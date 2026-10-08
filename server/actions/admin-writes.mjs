import { randomUUID } from "node:crypto";
import {
  requireAdmin,
  requireSuperadmin,
  restampSession,
  setUserPassword,
} from "../auth.mjs";
import {
  coaDetailsOf,
  issuedCoaDetails,
  sameCoaDetails,
} from "../certificates.mjs";
import { LOCK_NOT_AVAILABLE, isUniqueViolation } from "../db.mjs";
import { officeDay, parseDay } from "../dates.mjs";
import { UserError } from "../errors.mjs";
import { normalizePeriod } from "../periods.mjs";
import { RESPONSE_COLUMNS, responseRecord, safeTrim } from "../records.mjs";

/**
 * What the admin screens change: programmes, settings, report statistics,
 * users, which programme a response counts under, and certificate requests
 * short of issuing them. Same checks, same messages and same replies as
 * Code.gs and Certificate.gs.
 *
 * Apps Script queued these behind one script-wide lock. Here each is one
 * transaction, and the certificate ones lock the response row they change —
 * the lock issuing a certificate will take too, so a request cannot be
 * declined while its certificate is being made.
 */

const SETTINGS_ORDER = "order by key";

export async function readSettings(db) {
  const rows = await db.query(
    `select key, value from csm.settings where key <> '' ${SETTINGS_ORDER}`,
  );
  return Object.fromEntries(rows.map((row) => [row.key, safeTrim(row.value)]));
}

/**
 * One response, locked for the rest of the transaction. References are
 * matched regardless of case, as findResponseRow_ matched them.
 *
 * Issuing a certificate holds this lock while the worker makes it, so
 * anything else that wants the row waits — for `waitSeconds`, as long as
 * Apps Script waited for its script lock — and is then told why.
 */
export async function lockedResponse(
  tx,
  referenceId,
  {
    waitSeconds = 15,
    busy = "A certificate is being issued right now. Wait a moment, then try again.",
  } = {},
) {
  referenceId = safeTrim(referenceId);
  if (!referenceId) throw new UserError("A response reference is required.");
  await tx.query(`set local lock_timeout = '${Math.trunc(waitSeconds)}s'`);
  let row;
  try {
    [row] = await tx.query(
      `select ${RESPONSE_COLUMNS} from csm.responses
       where upper(reference_id) = $1 order by seq desc limit 1 for update`,
      [referenceId.toUpperCase()],
    );
  } catch (error) {
    if (error?.code === LOCK_NOT_AVAILABLE) throw new UserError(busy);
    throw error;
  }
  if (!row) throw new UserError(`Response ${referenceId} was not found.`);
  return responseRecord(row);
}

// --------------------------------- Programmes ---------------------------------

export async function adminSaveService(ctx, payload, token) {
  await requireAdmin(ctx, token);
  const code = safeTrim(payload.code).toUpperCase();
  const nameEn = safeTrim(payload.name_en);
  const nameTl = safeTrim(payload.name_tl);
  const category =
    safeTrim(payload.category).toLowerCase() === "other" ? "other" : "main";
  const active =
    payload.active !== false &&
    String(payload.active).toLowerCase() !== "false";
  let serviceId = safeTrim(payload.service_id);
  if (!code || code.length > 24)
    throw new UserError("A short program code of 1-24 characters is required.");
  if (!nameEn) throw new UserError("The English program name is required.");
  const clash = new UserError(`Another program already uses the code ${code}.`);

  try {
    await ctx.db.transaction(async (tx) => {
      const [taken] = await tx.query(
        "select 1 from csm.services where code = $1 and service_id <> $2",
        [code, serviceId],
      );
      if (taken) throw clash;
      const [current] = await tx.query(
        "select sort_order, has_fees from csm.services where service_id = $1 for update",
        [serviceId],
      );
      if (!serviceId)
        serviceId = `S-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

      let sortOrder;
      if (payload.sort_order === "" || payload.sort_order == null) {
        if (current) sortOrder = current.sort_order;
        else {
          const [{ n }] = await tx.query(
            "select count(*)::int as n from csm.services",
          );
          sortOrder = (n + 1) * 10;
        }
      } else sortOrder = Number(payload.sort_order) || 0;
      // The column holds whole numbers; the screen only ever sends those.
      sortOrder = Math.max(
        -2147483648,
        Math.min(2147483647, Math.trunc(sortOrder)),
      );

      // A save that does not mention the fees flag leaves it as it was: a
      // partial payload must not quietly stop a programme asking about fees.
      const hasFees = Object.hasOwn(payload, "has_fees")
        ? payload.has_fees === true ||
          String(payload.has_fees).toLowerCase() === "true"
        : current
          ? current.has_fees === true
          : false;

      await tx.query(
        `insert into csm.services (service_id, code, name_en, name_tl, category, active, has_fees, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (service_id) do update set
           code = excluded.code, name_en = excluded.name_en, name_tl = excluded.name_tl,
           category = excluded.category, active = excluded.active, has_fees = excluded.has_fees,
           sort_order = excluded.sort_order, updated_at = now()`,
        [serviceId, code, nameEn, nameTl, category, active, hasFees, sortOrder],
      );
    });
  } catch (error) {
    // Two saves racing for the same new code: the index decides, and the
    // loser gets the message the check above would have given.
    if (isUniqueViolation(error, "services_code_key")) throw clash;
    throw error;
  }
  return { status: "OK", service_id: serviceId, code };
}

// ---------------------------------- Settings ----------------------------------

/**
 * These decide whose name and signature appear on an issued certificate and
 * which template it is built from. Changing them is effectively signing on
 * someone else's behalf, so they are held to superadmin.
 */
const SIGNING_SETTINGS = [
  "coa_signatory",
  "coa_designation",
  "coa_template_id",
  "coa_template_name",
  "coa_signature_id",
  "coa_signature_name",
];
const EDITABLE_SETTINGS = [
  "office_name",
  "report_prepared_by",
  "report_prepared_title",
  "report_reviewed_by",
  "report_reviewed_title",
  "report_approved_by",
  "report_approved_title",
  ...SIGNING_SETTINGS,
];

export async function adminSaveSettings(ctx, settings, token) {
  const session = await requireAdmin(ctx, token);
  if (!settings || typeof settings !== "object")
    throw new UserError("Invalid settings payload.");
  const isSuperadmin = session.role === "superadmin";
  return ctx.db.transaction(async (tx) => {
    const updates = {};
    let current = null;
    for (const key of EDITABLE_SETTINGS) {
      if (!(key in settings)) continue;
      const value = safeTrim(settings[key]).slice(0, 300);
      if (!isSuperadmin && SIGNING_SETTINGS.includes(key)) {
        current ??= await readSettings(tx);
        // Silently dropping it would look like a save that worked.
        if (value !== safeTrim(current[key]))
          throw new UserError(
            "Only a superadmin can change the certificate signatory, designation, template or e-signature.",
          );
        continue;
      }
      updates[key] = value;
    }
    for (const [key, value] of Object.entries(updates))
      await tx.query(
        `insert into csm.settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, safeTrim(value)],
      );
    return readSettings(tx);
  });
}

// ----------------------------- Report statistics ------------------------------

export async function adminSaveServiceStats(ctx, periodInput, rows, token) {
  await requireAdmin(ctx, token);
  const period = normalizePeriod(periodInput, ctx.now);
  if (!Array.isArray(rows)) throw new UserError("Invalid statistics payload.");
  // Whole numbers, or blank for "not entered". Checked for every row before
  // any is written, so a bad figure cannot leave the period half saved.
  for (const entry of rows)
    for (const key of ["clients", "transactions"]) {
      const value = safeTrim(entry && entry[key]);
      if (value && !/^\d{1,9}$/.test(value))
        throw new UserError(
          `Client and transaction counts must be whole numbers of zero or more (${safeTrim(entry.code || entry.service_id)}: "${value.slice(0, 20)}").`,
        );
    }
  const count = (value) => (safeTrim(value) ? Number(safeTrim(value)) : null);
  await ctx.db.transaction(async (tx) => {
    for (const entry of rows) {
      const serviceId = safeTrim(entry?.service_id);
      if (!serviceId) continue;
      const [known] = await tx.query(
        "select 1 from csm.services where service_id = $1",
        [serviceId],
      );
      // Apps Script stored figures against any id it was sent; a programme
      // that does not exist has no report row to put them on.
      if (!known)
        throw new UserError(`Unknown program: ${serviceId.slice(0, 40)}.`);
      await tx.query(
        `insert into csm.service_stats (period_key, service_id, clients, transactions, remarks, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (period_key, service_id) do update set
           clients = excluded.clients, transactions = excluded.transactions,
           remarks = excluded.remarks, updated_at = now()`,
        [
          period.key,
          serviceId,
          count(entry.clients),
          count(entry.transactions),
          safeTrim(entry.remarks).slice(0, 300),
        ],
      );
    }
  });
  return { status: "OK", period: period.key };
}

// ----------------------------------- Users ------------------------------------

export async function adminSaveUser(ctx, payload, token) {
  const session = await requireSuperadmin(ctx, token);
  const email = safeTrim(payload.email).toLowerCase();
  const name = safeTrim(payload.name);
  const role = safeTrim(payload.role).toLowerCase();
  const active =
    payload.active !== false &&
    String(payload.active).toLowerCase() !== "false";
  const password = String(payload.password ?? "");
  if (!name) throw new UserError("Name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new UserError("A valid email is required.");
  if (!["admin", "superadmin"].includes(role))
    throw new UserError("Role must be admin or superadmin.");
  if (session.email === email && (role !== "superadmin" || !active))
    throw new UserError(
      "You cannot demote or deactivate your own superadmin account.",
    );

  const user = await ctx.db.transaction(async (tx) => {
    const [existing] = await tx.query(
      "select user_id from csm.admin_users where email = $1 for update",
      [email],
    );
    if (!existing && password.length < 12)
      throw new UserError(
        "New users require a password of at least 12 characters.",
      );
    if (password && password.length < 12)
      throw new UserError("Passwords must contain at least 12 characters.");
    if (password) {
      // A new password ends every session opened with the old one — except
      // the one this superadmin is saving from, when it is their own.
      const saved = await setUserPassword(tx, {
        email,
        password,
        name,
        role,
        active,
        // An existing account keeps its id whatever the request says: sessions
        // hang off it. Apps Script let a request rename it.
        userId: existing ? undefined : safeTrim(payload.user_id) || undefined,
      });
      if (session.email === email)
        await restampSession(tx, token, saved.credential_version);
      return saved;
    }
    const [updated] = await tx.query(
      `update csm.admin_users set name = $2, role = $3, active = $4, updated_at = now()
       where email = $1
       returning user_id, name, role, email, active, created_at, updated_at`,
      [email, name, role, active],
    );
    return updated;
  });
  return {
    user_id: user.user_id,
    name: user.name,
    role: user.role,
    email: user.email,
    active: user.active,
    created_at: new Date(user.created_at).toISOString(),
    updated_at: new Date(user.updated_at).toISOString(),
  };
}

// --------------------------- Programme of a response --------------------------

/**
 * Moves a response to a different programme: the four columns that name it
 * change together, and the audit entry records the programme it moved from,
 * read from the row itself rather than taken from the request.
 */
export async function adminChangeResponseService(ctx, payload, token) {
  await requireAdmin(ctx, token);
  payload = payload || {};
  const referenceId = safeTrim(payload.referenceId);
  const serviceId = safeTrim(payload.serviceId);
  if (!referenceId) throw new UserError("A response reference is required.");
  if (!serviceId)
    throw new UserError("Choose the program this response belongs to.");

  // Any programme on the list, withdrawn ones included: a response from last
  // quarter may belong to one the office has since withdrawn.
  const [service] = await ctx.db.query(
    "select service_id, code, name_en, category from csm.services where service_id = $1",
    [serviceId],
  );
  if (!service)
    throw new UserError(
      "That program is no longer on the list. Refresh the page and choose again.",
    );
  const otherService =
    service.category === "other"
      ? safeTrim(payload.otherService).slice(0, 200)
      : "";
  if (service.category === "other" && !otherService)
    throw new UserError(
      "Describe the transaction, since this response is being filed under Other services.",
    );

  return ctx.db.transaction(async (tx) => {
    const record = await lockedResponse(tx, referenceId);
    const unchanged =
      record.serviceId === service.service_id &&
      safeTrim(record.otherService) === otherService;
    ctx.moved = {
      from: safeTrim(record.serviceCode) || "(none)",
      to: service.code,
      unchanged,
    };
    if (!unchanged)
      // SQD5 is left as it is: the fees question is re-read from the new
      // programme's flag every time scores are computed.
      await tx.query(
        `update csm.responses
         set service_id = $2, service_code = $3, service_name = $4, other_service = $5
         where reference_id = $1`,
        [
          record.referenceId,
          service.service_id,
          service.code,
          service.name_en,
          otherService,
        ],
      );
    return {
      status: "OK",
      referenceId: record.referenceId,
      serviceId: service.service_id,
      serviceCode: service.code,
      serviceName: service.name_en,
      otherService,
      unchanged,
    };
  });
}

// ---------------------------- Certificate requests ----------------------------

export async function adminSaveCoaDetails(ctx, payload, token) {
  await requireAdmin(ctx, token);
  payload = payload || {};
  return ctx.db.transaction(async (tx) => {
    const record = await lockedResponse(tx, payload.referenceId);
    const title = safeTrim(payload.coaTitle).slice(0, 12);
    const name = safeTrim(payload.coaName).slice(0, 160);
    const agency = safeTrim(payload.coaAgency).slice(0, 200);
    const purpose = safeTrim(payload.coaPurpose).slice(0, 300);
    const from = parseDay(payload.coaDateFrom);
    const to = parseDay(payload.coaDateTo);
    if (!name || !agency || !purpose || !from)
      throw new UserError(
        "Name, agency, purpose, and the date of appearance are all required.",
      );
    if (to && to < from)
      throw new UserError(
        "The end date cannot be earlier than the start date.",
      );
    if (from > officeDay(ctx.now))
      throw new UserError("The date of appearance cannot be in the future.");

    // Once a certificate is issued these fields describe the next one, not
    // the one the client holds. A row issued before that was recorded gets
    // its record now, from its values as they stand before this edit.
    const snapshot =
      record.coaStatus === "ISSUED" && !record.coaIssuedDetails
        ? JSON.stringify(coaDetailsOf(record))
        : null;
    await tx.query(
      `update csm.responses
       set coa_title = $2, coa_name = $3, coa_agency = $4, coa_purpose = $5,
           coa_date_from = $6, coa_date_to = $7,
           coa_issued_details = coalesce($8::text::jsonb, coa_issued_details)
       where reference_id = $1`,
      [record.referenceId, title, name, agency, purpose, from, to, snapshot],
    );
    const edited = coaDetailsOf({
      coaTitle: title,
      coaName: name,
      coaAgency: agency,
      coaPurpose: purpose,
      coaDateFrom: from,
      coaDateTo: to,
    });
    return {
      status: "OK",
      referenceId: record.referenceId,
      reissueNeeded:
        record.coaStatus === "ISSUED" &&
        !sameCoaDetails(issuedCoaDetails(record), edited),
    };
  });
}

/**
 * Refuses a request for a certificate. Recorded first and sent second: a
 * mail failure must not leave the register saying the request is still open
 * when the office has decided it is not.
 */
export async function adminDeclineCoa(ctx, payload, token) {
  await requireAdmin(ctx, token);
  payload = payload || {};
  const referenceId = safeTrim(payload.referenceId);
  const reason = safeTrim(payload.reason).slice(0, 500);
  const notify = payload.notify !== false;
  if (!referenceId) throw new UserError("A response reference is required.");
  // It is what the client is told, and what the office has to show when
  // asked months later why this one was refused.
  if (!reason)
    throw new UserError(
      "Give a reason for declining. It is recorded, and it is what the client is told.",
    );

  const outcome = await ctx.db.transaction(async (tx) => {
    const record = await lockedResponse(tx, referenceId);
    if (!record.coaRequested)
      throw new UserError(
        "This response did not ask for a Certificate of Appearance.",
      );
    if (record.coaStatus === "ISSUED")
      throw new UserError(
        "This certificate has already been issued and the client holds it. It cannot be declined after the fact.",
      );
    if (record.coaStatus === "DECLINED") return { record, already: true };
    await tx.query(
      `update csm.responses set coa_status = 'DECLINED', coa_decline_reason = $2
       where reference_id = $1`,
      [record.referenceId, reason],
    );
    return { record, settings: await readSettings(tx) };
  });
  const { record } = outcome;
  if (outcome.already)
    return {
      status: "OK",
      referenceId: record.referenceId,
      unchanged: true,
      emailStatus: "It was already declined, so nothing was sent again.",
    };

  let emailStatus;
  if (!notify) emailStatus = "The client was not emailed.";
  else if (!record.email)
    emailStatus = "Declined. No recipient email on file, so nobody was told.";
  else
    try {
      emailStatus = await ctx.worker.sendDeclineEmail({
        record,
        reason,
        settings: outcome.settings,
      });
    } catch (error) {
      emailStatus = `Declined, but the client could not be emailed (${String(error?.message || error).slice(0, 160)}). Tell them another way.`;
    }
  return { status: "OK", referenceId: record.referenceId, emailStatus };
}

/**
 * Puts a declined request back in the queue, for a decision made in error.
 * The reason goes with it; the audit log keeps the history.
 */
export async function adminReopenCoa(ctx, payload, token) {
  await requireAdmin(ctx, token);
  payload = payload || {};
  if (!safeTrim(payload.referenceId))
    throw new UserError("A response reference is required.");
  return ctx.db.transaction(async (tx) => {
    const record = await lockedResponse(tx, payload.referenceId);
    if (record.coaStatus !== "DECLINED")
      throw new UserError(
        "Only a declined request can be put back in the queue.",
      );
    await tx.query(
      `update csm.responses set coa_status = 'REQUESTED', coa_decline_reason = ''
       where reference_id = $1`,
      [record.referenceId],
    );
    return { status: "OK", referenceId: record.referenceId };
  });
}
