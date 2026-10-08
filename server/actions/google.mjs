import { randomUUID } from "node:crypto";
import { requireAdmin, requireSuperadmin } from "../auth.mjs";
import {
  coaDetailsOf,
  issuedCoaDetails,
  sameCoaDetails,
} from "../certificates.mjs";
import { LOCK_NOT_AVAILABLE } from "../db.mjs";
import { officeDay } from "../dates.mjs";
import { UserError } from "../errors.mjs";
import { normalizePeriod } from "../periods.mjs";
import { safeTrim } from "../records.mjs";
import { allServices, periodRecords } from "./admin-reads.mjs";
import { lockedResponse, readSettings } from "./admin-writes.mjs";

/**
 * The four actions that make something in Google: issuing a certificate,
 * generating a report, and uploading a template or signature. The worker
 * (Worker.gs) makes the file; everything else — the checks, the register,
 * the order things happen in — is here, as it was in Certificate.gs and
 * Report.gs.
 */

/** Where Drive folders are remembered, as Apps Script named them. */
const FOLDER_SETTINGS = {
  certificates: "coa_output_folder_id",
  templates: "coa_template_folder_id",
  reports: "report_folder_id",
};

async function rememberFolder(db, key, folderId, known) {
  if (!folderId || folderId === known) return;
  await db.query(
    `insert into csm.settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, folderId],
  );
}

/** PORTAL_BASE_URL, if it is a bare https origin; certificates link to it. */
function portalBaseUrl() {
  const url = safeTrim(process.env.PORTAL_BASE_URL).replace(/\/$/, "");
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url) ? url : "";
}

const newVerificationCode = () =>
  `OSDS-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;

// ------------------------------- Certificates ---------------------------------

/**
 * Issues one Certificate of Appearance: issueCoa_ in Certificate.gs.
 *
 * The response row stays locked while the worker makes the PDF, so a second
 * click — or a second administrator — waits and then sees it issued, rather
 * than minting another copy and emailing the client twice. The issuance is
 * recorded before the email is sent: a client must never hold a certificate
 * the register still reports as unissued.
 */
export async function adminGenerateCoa(
  ctx,
  responseId,
  issueKey,
  token,
  expectedStatus,
) {
  await requireAdmin(ctx, token);
  issueKey = safeTrim(issueKey).slice(0, 64);
  const settings = await readSettings(ctx.db);

  const outcome = await ctx.db.transaction(async (tx) => {
    const record = await lockedResponse(tx, responseId, {
      waitSeconds: 45,
      busy: "Another certificate is being issued right now. Wait a moment, then refresh the list before trying again.",
    });
    const already = (emailStatus) => ({
      reply: {
        status: "OK",
        referenceId: record.referenceId,
        certificateUrl: record.coaLink,
        verificationCode: record.verificationCode,
        emailStatus,
        duplicate: true,
      },
    });

    // The same attempt, retried after a timeout, gets back the certificate
    // that already went out. A deliberate reissue carries a new key — and so,
    // in effect, does one after an edit.
    if (
      issueKey &&
      record.coaIssueKey === issueKey &&
      record.coaStatus === "ISSUED" &&
      sameCoaDetails(issuedCoaDetails(record), coaDetailsOf(record))
    )
      return already(
        `This certificate was already issued and emailed on ${record.coaIssuedAt || "an earlier attempt"}.`,
      );
    // The list the administrator clicked from said this was not issued yet;
    // another administrator, or an earlier click, got there first.
    const expected = safeTrim(expectedStatus).toUpperCase();
    if (expected && expected !== "ISSUED" && record.coaStatus === "ISSUED")
      return already(
        `It had already been issued${record.coaIssuedAt ? ` on ${record.coaIssuedAt}` : ""} by another request, so nothing was sent again.`,
      );
    if (record.coaStatus === "DECLINED")
      throw new UserError(
        `This request was declined${record.coaDeclineReason ? ` — ${record.coaDeclineReason}` : ""}. Put it back in the queue first if it should be issued after all.`,
      );
    if (!record.coaRequested)
      throw new UserError(
        "This response did not request a Certificate of Appearance.",
      );
    if (
      !record.coaName ||
      !record.coaAgency ||
      !record.coaPurpose ||
      !record.coaDateFrom
    )
      throw new UserError("Complete the certificate details before issuing.");
    if (record.coaDateFrom > officeDay(ctx.now))
      throw new UserError(
        `The date of appearance (${record.coaDateFrom}) is still in the future. Correct it, or issue the certificate on or after that day.`,
      );
    if (!safeTrim(settings.coa_template_id))
      throw new UserError(
        "No Certificate of Appearance template is configured. Upload one in Settings.",
      );
    if (
      !safeTrim(settings.coa_signatory) ||
      !safeTrim(settings.coa_designation)
    )
      throw new UserError(
        "Set the certificate signatory and designation in Settings before issuing.",
      );

    // A reissue printing the same details keeps its code, so the identical
    // earlier copy goes on verifying; one printing different details gets a
    // new code, and the outdated copy stops verifying.
    const previousStatus = record.coaStatus;
    const printed = coaDetailsOf(record);
    const previousCode = record.verificationCode;
    const superseded =
      previousStatus === "ISSUED" &&
      !!previousCode &&
      !sameCoaDetails(issuedCoaDetails(record), printed);
    const verificationCode =
      superseded || !previousCode ? newVerificationCode() : previousCode;
    const baseUrl = portalBaseUrl();
    const verificationUrl = baseUrl
      ? `${baseUrl}/verification?code=${encodeURIComponent(verificationCode)}`
      : "";
    const notes = [
      baseUrl
        ? ""
        : "PORTAL_BASE_URL is not set in Vercel, so this certificate carries no QR code or verification link.",
      superseded
        ? `The details changed, so this certificate has a new verification code and the earlier one (${previousCode}) no longer verifies.`
        : "",
    ];

    let minted;
    try {
      minted = await ctx.worker.mintCertificate({
        record,
        settings,
        verificationCode,
        verificationUrl,
        issuedOn: ctx.now.toISOString(),
        outputFolderId: safeTrim(settings[FOLDER_SETTINGS.certificates]),
      });
    } catch (error) {
      // A failed first issuance is left as ERROR for the office to act on;
      // a failed reissue leaves the valid certificate already issued alone.
      if (previousStatus !== "ISSUED")
        await tx.query(
          "update csm.responses set coa_status = $2 where reference_id = $1",
          [
            record.referenceId,
            `ERROR: ${String(error?.message || error).slice(0, 400)}`,
          ],
        );
      return { failure: error };
    }

    await rememberFolder(
      tx,
      FOLDER_SETTINGS.certificates,
      minted.outputFolderId,
      safeTrim(settings[FOLDER_SETTINGS.certificates]),
    );
    await tx.query(
      `update csm.responses
       set coa_status = 'ISSUED', coa_link = $2, coa_issued_at = $3, coa_issue_key = $4,
           coa_issued_details = $5::text::jsonb, verification_code = $6, verification_url = $7
       where reference_id = $1`,
      [
        record.referenceId,
        minted.certificateUrl,
        ctx.now,
        issueKey,
        JSON.stringify(printed),
        verificationCode,
        verificationUrl,
      ],
    );
    return { record, minted, verificationCode, verificationUrl, notes };
  });

  if (outcome.reply) return outcome.reply;
  if (outcome.failure) throw outcome.failure;

  // Recorded; now sent. A mail failure is reported, never rolled back.
  const { record, minted, verificationCode, verificationUrl, notes } = outcome;
  let emailStatus;
  try {
    emailStatus = await ctx.worker.sendCertificateEmail({
      record,
      fileId: minted.fileId,
      // A link to a file the client cannot open is worse than none; the PDF
      // travels as an attachment either way.
      certificateUrl: minted.shared ? minted.certificateUrl : "",
      verificationCode,
      verificationUrl,
      settings,
    });
  } catch (error) {
    emailStatus = `The certificate was issued, but the email could not be sent (${String(error?.message || error).slice(0, 160)}). Send the link manually.`;
  }
  return {
    status: "OK",
    referenceId: record.referenceId,
    certificateUrl: minted.certificateUrl,
    verificationCode,
    emailStatus: safeTrim([...notes, emailStatus].join(" ")),
  };
}

// ---------------------------------- Reports -----------------------------------

/**
 * One CSM Summary Report: buildReport_ in Report.gs. One at a time — a build
 * can outlast the browser's patience, and a second click must not make a
 * second workbook.
 */
export async function adminGenerateReport(ctx, periodInput, token) {
  const session = await requireAdmin(ctx, token);
  const period = normalizePeriod(periodInput, ctx.now);
  return ctx.db.transaction(async (tx) => {
    await tx.query("set local lock_timeout = '5s'");
    try {
      await tx.query("select pg_advisory_xact_lock(hashtext('csm.report'))");
    } catch (error) {
      if (error?.code === LOCK_NOT_AVAILABLE)
        throw new UserError(
          "A report is already being generated. Wait for it to finish, then check the list below before generating again.",
        );
      throw error;
    }
    const records = await periodRecords(tx, period);
    if (!records.length)
      throw new UserError(`There are no responses for ${period.label} yet.`);

    const [settings, services, statRows, admins] = [
      await readSettings(tx),
      await allServices(tx),
      await tx.query(
        `select service_id, clients, transactions, remarks
         from csm.service_stats where period_key = $1`,
        [period.key],
      ),
      await tx.query(
        "select email from csm.admin_users where active order by created_at, user_id",
      ),
    ];
    // In the shape readServiceStats_ gave the workbook builders.
    const text = (value) => (value == null ? "" : String(value));
    const stats = Object.fromEntries(
      statRows.map((s) => [
        s.service_id,
        {
          clients: text(s.clients),
          transactions: text(s.transactions),
          remarks: safeTrim(s.remarks),
        },
      ]),
    );

    const built = await ctx.worker.generateReport({
      period: { type: period.type, year: period.year, quarter: period.quarter },
      settings,
      services,
      records,
      stats,
      actorEmail: session.email,
      adminEmails: admins.map((a) => a.email),
      folderId: safeTrim(settings[FOLDER_SETTINGS.reports]),
    });
    await rememberFolder(
      tx,
      FOLDER_SETTINGS.reports,
      built.folderId,
      safeTrim(settings[FOLDER_SETTINGS.reports]),
    );
    const reportId = `RPT-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    await tx.query(
      `insert into csm.reports (report_id, name, period_key, period_label, file_id, url, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        reportId,
        built.name,
        period.key,
        period.label,
        built.fileId,
        built.url,
        session.email,
      ],
    );
    return {
      status: "OK",
      report_id: reportId,
      name: built.name,
      url: built.url,
      period: period.key,
      accessNote: built.accessNote,
    };
  });
}

// ---------------------------------- Uploads -----------------------------------

async function upload(ctx, kind, file) {
  const settings = await readSettings(ctx.db);
  const known = safeTrim(settings[FOLDER_SETTINGS.templates]);
  const saved = await ctx.worker.uploadFile({
    kind,
    file: {
      base64: file.base64,
      filename: file.filename,
      mimeType: file.mimeType,
    },
    folderId: known,
  });
  await rememberFolder(
    ctx.db,
    FOLDER_SETTINGS.templates,
    saved.folderId,
    known,
  );
  return { id: saved.id, name: saved.name, url: saved.url };
}

/**
 * The template decides what an issued certificate says, so it is held to
 * superadmin, like the signatory it is used with. Checked here before the
 * file travels any further, and again by the worker.
 */
export async function adminUploadCoaTemplate(ctx, file, token) {
  await requireSuperadmin(ctx, token);
  if (!file || !file.base64 || !file.filename)
    throw new UserError("No file payload.");
  if (!/\.docx?$/i.test(file.filename))
    throw new UserError(
      "The certificate template must be a Word (.doc or .docx) file.",
    );
  if (file.base64.length > 14000000)
    throw new UserError("Templates must be 10 MB or smaller.");
  return upload(ctx, "template", file);
}

export async function adminUploadSignature(ctx, file, token) {
  await requireSuperadmin(ctx, token);
  if (
    !file ||
    !file.base64 ||
    !file.filename ||
    !/^image\/(png|jpeg|webp)$/i.test(String(file.mimeType || "")) ||
    file.base64.length > 2800000
  )
    throw new UserError(
      "Please upload a PNG, JPG, or WebP signature image no larger than 2 MB.",
    );
  return upload(ctx, "signature", file);
}
