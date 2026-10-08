import { randomUUID } from "node:crypto";
import { auditCanonical, auditHmac } from "../audit.mjs";
import { newCredentialVersion } from "../auth.mjs";
import { parseDay } from "../dates.mjs";
import { legacyStored } from "../passwords.mjs";
import { CC_KEYS, SQD_KEYS, safeTrim } from "../records.mjs";
import { regionCode } from "../actions/public.mjs";

/**
 * An export from Export.gs turned into the rows the database takes, sheet by
 * sheet, reading each cell the way Code.gs read it.
 *
 * Nothing is dropped quietly. Every row that cannot be carried over as it
 * stands is a problem, reported by sheet, row number and field:
 *
 *   error    the row cannot be imported; the import will not apply
 *   fixed    carried over with a change that keeps what the portal showed
 *            (a blank answer read as N/A was already counted as N/A)
 *   warning  carried over as it stands, but worth a look
 *
 * Reports name rows and fields, never the personal details in them.
 */

export const EXPORT_FORMAT = "csm-export-1";

const isDateCell = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.$date === "string";

/** yyyy-mm-dd HH:mm:ss of an instant in `zone`. */
function zoned(instant, zone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** A sheet as rows of named cells, its header read as getHeaderMap_ read it. */
function sheetOf(data, name) {
  const rows = data.sheets?.[name];
  if (!Array.isArray(rows) || !rows.length)
    return { rows: [], has: () => false };
  const header = {};
  rows[0].forEach((title, index) => {
    const key = String(title ?? "")
      .trim()
      .toLowerCase();
    if (key) header[key] = index;
  });
  const column = (aliases) => {
    for (const alias of aliases) if (alias in header) return header[alias];
    return -1;
  };
  return {
    has: (aliases) => column(aliases) >= 0,
    rows: rows.slice(1).map((cells, index) => ({
      sheetRow: index + 2,
      cells,
      get: (aliases) => {
        const at = column(aliases);
        return at < 0 ? "" : cells[at];
      },
      blank: () =>
        cells.every((cell) => safeTrim(isDateCell(cell) ? "x" : cell) === ""),
    })),
  };
}

const RESPONSE_ALIASES = {
  timestamp: ["timestamp", "submitted at"],
  referenceId: ["responseid", "response id", "reference"],
  submissionId: ["submissionid", "submission id"],
  transactionDate: ["transactiondate", "transaction date", "date"],
  year: ["year"],
  clientType: ["clienttype", "client type"],
  sex: ["sex"],
  age: ["age"],
  region: ["region"],
  regionCode: ["regioncode", "region code"],
  serviceId: ["serviceid", "service id"],
  serviceCode: ["servicecode", "service code"],
  serviceName: ["servicename", "service name"],
  otherService: ["otherservice", "other service"],
  suggestions: ["suggestions", "comments", "comments/suggestions"],
  email: ["email", "e-mail"],
  language: ["language"],
  coaRequested: ["coarequested", "coa requested"],
  coaTitle: ["coatitle", "coa title"],
  coaName: ["coaname", "coa name"],
  coaAgency: ["coaagency", "coa agency"],
  coaPurpose: ["coapurpose", "coa purpose"],
  coaDateFrom: ["coadatefrom", "coa date from"],
  coaDateTo: ["coadateto", "coa date to"],
  coaStatus: ["coastatus", "coa status"],
  coaLink: ["coalink", "coa link"],
  coaIssuedAt: ["coaissuedat", "coa issued at"],
  coaIssueKey: ["coaissuekey", "coa issue key"],
  coaIssuedDetails: ["coaissueddetails", "coa issued details"],
  coaDeclineReason: ["coadeclinereason", "coa decline reason"],
  verificationCode: ["verificationcode", "verification code"],
  verificationUrl: ["verificationurl", "verification url"],
  privacyNoticeVersion: [
    "privacy_notice_version",
    "privacynoticeversion",
    "privacy notice version",
  ],
  privacyNoticePresentedAt: [
    "privacy_notice_presented_at",
    "privacynoticepresentedat",
    "privacy notice presented at",
  ],
};
const ANSWERS = ["1", "2", "3", "4", "5", "N/A"];
const STATUSES = ["NONE", "REQUESTED", "PROCESSING", "ISSUED", "DECLINED"];

export function transformExport(data, { auditSecret = "" } = {}) {
  if (data?.format !== EXPORT_FORMAT)
    throw new Error(
      `Not an export from Export.gs (format ${JSON.stringify(data?.format)}).`,
    );
  const scriptZone = data.scriptTimeZone || "Asia/Manila";
  const sheetZone = data.spreadsheetTimeZone || scriptZone;
  const problems = [];
  const report = (level, sheet, row, field, message) =>
    problems.push({ level, sheet, row, field, message });

  /** Text, as safeTrim_ made it — except a date, which is no text at all. */
  const text = (value) => (isDateCell(value) ? "" : safeTrim(value));
  /** A calendar day, read in the script's zone as fmtDate_ read it. */
  const day = (value) =>
    isDateCell(value)
      ? zoned(value.$date, scriptZone).slice(0, 10)
      : parseDay(value);
  const instant = (value) => {
    if (isDateCell(value)) return value.$date;
    const parsed = safeTrim(value) ? new Date(safeTrim(value)) : null;
    return parsed && !Number.isNaN(parsed.getTime())
      ? parsed.toISOString()
      : null;
  };
  const now = new Date().toISOString();

  // ------------------------------- Settings ---------------------------------
  const settings = [];
  for (const row of sheetOf(data, "Settings").rows) {
    const key = text(row.cells[0]);
    if (!key) continue;
    const value = row.cells[1];
    settings.push({
      key,
      value: isDateCell(value)
        ? zoned(value.$date, scriptZone)
        : safeTrim(value),
    });
  }

  // ------------------------------- Programmes -------------------------------
  const services = [];
  const serviceIds = new Set();
  const codes = new Set();
  for (const row of sheetOf(data, "Services").rows) {
    const id = text(row.get(["service_id"]));
    const code = text(row.get(["code"]));
    if (!id || !code) {
      if (!row.blank())
        report(
          "warning",
          "Services",
          row.sheetRow,
          "service_id",
          "No id or code; Apps Script never listed it either.",
        );
      continue;
    }
    if (serviceIds.has(id) || codes.has(code)) {
      report(
        "error",
        "Services",
        row.sheetRow,
        "code",
        `The id ${id} or code ${code} appears twice.`,
      );
      continue;
    }
    serviceIds.add(id);
    codes.add(code);
    let category = text(row.get(["category"])).toLowerCase() || "main";
    if (category !== "main" && category !== "other") {
      report(
        "fixed",
        "Services",
        row.sheetRow,
        "category",
        `"${category}" read as main.`,
      );
      category = "main";
    }
    services.push({
      service_id: id,
      code,
      name_en: text(row.get(["name_en"])) || code,
      name_tl: text(row.get(["name_tl"])),
      category,
      active: String(row.get(["active"])).toLowerCase() !== "false",
      has_fees:
        row.get(["has_fees"]) === true ||
        String(row.get(["has_fees"])).toLowerCase() === "true",
      sort_order: Math.trunc(Number(row.get(["sort_order"])) || 0),
      created_at: instant(row.get(["created_at"])) || now,
      updated_at: instant(row.get(["updated_at"])) || now,
    });
  }

  // -------------------------------- Responses -------------------------------
  const responses = [];
  const references = new Set();
  const submissions = new Set();
  const verificationCodes = new Set();
  const placeholders = new Map();
  for (const row of sheetOf(data, "Responses").rows) {
    const value = (field) => row.get(RESPONSE_ALIASES[field]);
    const ref = text(value("referenceId"));
    if (!ref) {
      if (!row.blank())
        report(
          "warning",
          "Responses",
          row.sheetRow,
          "ResponseID",
          "No reference; Apps Script skipped this row too.",
        );
      continue;
    }
    const fail = (field, message) => {
      report("error", "Responses", row.sheetRow, field, `${ref}: ${message}`);
      return null;
    };
    const fix = (field, message) =>
      report("fixed", "Responses", row.sheetRow, field, `${ref}: ${message}`);

    if (references.has(ref.toUpperCase())) {
      fail("ResponseID", "this reference appears twice.");
      continue;
    }
    references.add(ref.toUpperCase());

    const transactionDate = day(value("transactionDate"));
    if (!transactionDate) {
      fail("TransactionDate", "no readable transaction date.");
      continue;
    }
    const yearCell = Number(text(value("year")));
    if (yearCell && yearCell !== Number(transactionDate.slice(0, 4)))
      report(
        "warning",
        "Responses",
        row.sheetRow,
        "Year",
        `${ref}: Year ${yearCell} disagrees with the transaction date ${transactionDate}; the date is kept.`,
      );

    const clientType = text(value("clientType")).toUpperCase();
    if (!["CITIZEN", "BUSINESS", "GOVERNMENT"].includes(clientType)) {
      fail(
        "ClientType",
        `client type "${clientType}" is not Citizen, Business or Government.`,
      );
      continue;
    }
    let sex = text(value("sex")).toUpperCase();
    if (sex === "N/A") sex = "";
    if (sex && sex !== "MALE" && sex !== "FEMALE") {
      fail("Sex", `"${sex}" is not MALE, FEMALE or blank.`);
      continue;
    }
    const ageText = text(value("age"));
    let age = null;
    if (ageText && ageText.toUpperCase() !== "N/A") {
      const n = Number(ageText);
      if (Number.isInteger(n) && n >= 1 && n <= 120) age = n;
      else fix("Age", `age "${ageText}" is outside 1–120; kept as N/A.`);
    }

    let serviceId = text(value("serviceId"));
    const serviceCode = text(value("serviceCode"));
    const serviceName = text(value("serviceName"));
    if (!serviceId) {
      fail("ServiceID", "no program id.");
      continue;
    }
    if (!serviceIds.has(serviceId) && !placeholders.has(serviceId)) {
      placeholders.set(serviceId, {
        service_id: serviceId,
        code:
          codes.has(serviceCode) || !serviceCode
            ? `${serviceCode || "UNKNOWN"} (${serviceId})`
            : serviceCode,
        name_en: serviceName || serviceCode || serviceId,
        name_tl: "",
        category: serviceCode.toUpperCase() === "OTHER" ? "other" : "main",
        active: false,
        has_fees: false,
        sort_order: 9990,
        created_at: now,
        updated_at: now,
      });
      codes.add(placeholders.get(serviceId).code);
      report(
        "fixed",
        "Services",
        null,
        "service_id",
        `${serviceId} (${serviceCode || "no code"}) is named by responses but missing from Services; added as a withdrawn program.`,
      );
    }

    const answers = {};
    let badAnswer = false;
    for (const key of [...CC_KEYS, ...SQD_KEYS]) {
      let answer = text(row.get([key])).toUpperCase();
      if (answer === "") {
        answer = "N/A";
        fix(
          key.toUpperCase(),
          "blank answer read as N/A, as the dashboard and report already counted it.",
        );
      }
      if (!ANSWERS.includes(answer)) {
        fail(key.toUpperCase(), `answer "${answer}" is not 1–5 or N/A.`);
        badAnswer = true;
        break;
      }
      answers[key] = answer;
    }
    if (badAnswer) continue;

    let coaStatus = text(value("coaStatus")).toUpperCase() || "NONE";
    if (!STATUSES.includes(coaStatus) && !coaStatus.startsWith("ERROR")) {
      fail(
        "COAStatus",
        `certificate status "${coaStatus}" is not one the portal uses.`,
      );
      continue;
    }

    let submissionId = text(value("submissionId")).slice(0, 64) || null;
    if (submissionId && submissions.has(submissionId)) {
      fix(
        "SubmissionID",
        "a second response with the same submission id; the id is cleared on this one.",
      );
      submissionId = null;
    }
    if (submissionId) submissions.add(submissionId);

    let verificationCode =
      text(value("verificationCode")).toUpperCase() || null;
    if (verificationCode && verificationCodes.has(verificationCode)) {
      fail(
        "VerificationCode",
        "this verification code is already used by another response.",
      );
      continue;
    }
    if (verificationCode) verificationCodes.add(verificationCode);

    let issuedDetails = null;
    const detailsText = text(value("coaIssuedDetails"));
    if (detailsText) {
      try {
        const parsed = JSON.parse(detailsText);
        if (parsed && typeof parsed === "object") issuedDetails = parsed;
        else throw new Error();
      } catch {
        fix(
          "COAIssuedDetails",
          "the record of what was printed does not parse; verification will show the current details.",
        );
      }
    }

    const issuedAtCell = value("coaIssuedAt");
    let issuedAt = null;
    if (isDateCell(issuedAtCell)) issuedAt = issuedAtCell.$date;
    else if (text(issuedAtCell)) {
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(text(issuedAtCell));
      issuedAt = m
        ? new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`).toISOString()
        : instant(issuedAtCell);
      if (!issuedAt) fix("COAIssuedAt", "unreadable issue time; left blank.");
    }

    let language = text(value("language"));
    if (language !== "tl" && language !== "en") {
      if (language) fix("Language", `"${language}" read as en.`);
      language = "en";
    }

    const submittedAt = instant(value("timestamp"));
    if (!submittedAt)
      report(
        "warning",
        "Responses",
        row.sheetRow,
        "Timestamp",
        `${ref}: no submission time; the transaction date is used.`,
      );

    const region = text(value("region"));
    responses.push({
      reference_id: ref,
      submission_id: submissionId,
      submitted_at:
        submittedAt ||
        new Date(`${transactionDate}T00:00:00+08:00`).toISOString(),
      transaction_date: transactionDate,
      client_type: clientType,
      sex,
      age,
      region,
      region_code: text(value("regionCode")) || regionCode(region),
      service_id: serviceId,
      service_code: serviceCode,
      service_name: serviceName,
      other_service: text(value("otherService")),
      ...answers,
      suggestions: text(value("suggestions")),
      email: text(value("email")),
      language,
      coa_requested: text(value("coaRequested")).toUpperCase() === "YES",
      coa_title: text(value("coaTitle")),
      coa_name: text(value("coaName")),
      coa_agency: text(value("coaAgency")),
      coa_purpose: text(value("coaPurpose")),
      coa_date_from: day(value("coaDateFrom")),
      coa_date_to: day(value("coaDateTo")),
      coa_status: coaStatus,
      coa_link: text(value("coaLink")),
      coa_issued_at: issuedAt,
      coa_issue_key: text(value("coaIssueKey")),
      coa_issued_details: issuedDetails,
      coa_decline_reason: text(value("coaDeclineReason")),
      verification_code: verificationCode,
      verification_url: text(value("verificationUrl")),
      privacy_notice_version: text(value("privacyNoticeVersion")) || null,
      privacy_notice_presented_at: instant(value("privacyNoticePresentedAt")),
    });
  }
  services.push(...placeholders.values());

  // ----------------------------- Report statistics --------------------------
  const statsByKey = new Map();
  for (const row of sheetOf(data, "ServiceStats").rows) {
    const periodKey = text(row.get(["period_key"]));
    const serviceId = text(row.get(["service_id"]));
    if (!periodKey || !serviceId) continue;
    if (!serviceIds.has(serviceId) && !placeholders.has(serviceId)) {
      report(
        "warning",
        "ServiceStats",
        row.sheetRow,
        "service_id",
        `${periodKey}: figures for ${serviceId}, which is not a program; not imported.`,
      );
      continue;
    }
    const count = (field) => {
      const raw = text(row.get([field]));
      if (!raw) return null;
      if (/^\d{1,9}$/.test(raw)) return Number(raw);
      report(
        "fixed",
        "ServiceStats",
        row.sheetRow,
        field,
        `${periodKey} ${serviceId}: "${raw}" is not a whole number; left blank.`,
      );
      return null;
    };
    // A later row for the same period and program replaced an earlier one
    // when Apps Script read them; so it does here.
    statsByKey.set(`${periodKey}|${serviceId}`, {
      period_key: periodKey,
      service_id: serviceId,
      clients: count("clients"),
      transactions: count("transactions"),
      remarks: text(row.get(["remarks"])).slice(0, 300),
      updated_at: instant(row.get(["updated_at"])) || now,
    });
  }

  // --------------------------------- Reports --------------------------------
  const reports = [];
  const reportIds = new Set();
  for (const row of sheetOf(data, "Reports").rows) {
    const id = text(row.get(["report_id"]));
    if (!id) continue;
    if (reportIds.has(id)) {
      report(
        "warning",
        "Reports",
        row.sheetRow,
        "report_id",
        `${id} appears twice; the first is kept.`,
      );
      continue;
    }
    reportIds.add(id);
    reports.push({
      report_id: id,
      name: text(row.get(["name"])),
      period_key: text(row.get(["period_key"])),
      period_label: text(row.get(["period_label"])),
      file_id: text(row.get(["file_id"])),
      url: text(row.get(["url"])),
      created_at: instant(row.get(["created_at"])) || now,
      created_by: text(row.get(["created_by"])),
    });
  }

  // ------------------------- Administrators (two sheets) --------------------
  const listed = new Map();
  for (const row of sheetOf(data, "Whitelist").rows) {
    const email = text(row.get(["email", "e-mail"])).toLowerCase();
    if (email) listed.set(email, row);
  }
  const adminUsers = [];
  const seenEmails = new Set();
  for (const row of sheetOf(data, "Users").rows) {
    const email = text(row.get(["email", "e-mail"])).toLowerCase();
    if (!email) continue;
    if (seenEmails.has(email)) {
      report(
        "warning",
        "Users",
        row.sheetRow,
        "Email",
        "a second row for the same account; Apps Script signed in with the first.",
      );
      continue;
    }
    seenEmails.add(email);
    const hash = text(row.get(["passwordhash", "password hash"]));
    const salt = text(row.get(["salt"]));
    if (!hash || !salt) {
      report(
        "warning",
        "Users",
        row.sheetRow,
        "PasswordHash",
        "an account with no password; not imported — create it again with npm run db:user.",
      );
      continue;
    }
    let role = text(row.get(["role"])).toLowerCase() || "admin";
    if (role !== "admin" && role !== "superadmin") {
      report(
        "error",
        "Users",
        row.sheetRow,
        "Role",
        `role "${role}" is not admin or superadmin.`,
      );
      continue;
    }
    const entry = listed.get(email);
    const name = text(row.get(["name", "display name"])) || email;
    if (
      entry &&
      (text(entry.get(["role"])).toLowerCase() !== role ||
        (String(entry.get(["active", "enabled"])).toLowerCase() !== "false") !==
          (String(row.get(["active"])).toLowerCase() !== "false"))
    )
      report(
        "warning",
        "Users",
        row.sheetRow,
        "Role",
        "the Users and Whitelist sheets disagree on this account's role or status; Users, which sign-in used, is kept.",
      );
    adminUsers.push({
      user_id:
        (entry && text(entry.get(["user_id"]))) ||
        `U-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      email,
      name,
      role,
      active: String(row.get(["active"])).toLowerCase() !== "false",
      password_hash: legacyStored(hash, salt),
      credential_version: newCredentialVersion(),
      created_at:
        instant(entry?.get(["created_at"])) ||
        instant(row.get(["createdat", "created at"])) ||
        now,
      updated_at: instant(entry?.get(["updated_at"])) || now,
    });
  }
  for (const [email, row] of listed)
    if (!seenEmails.has(email))
      report(
        "warning",
        "Whitelist",
        row.sheetRow,
        "email",
        "listed in Whitelist with no password in Users, so it could not sign in; not imported.",
      );

  // --------------------------------- Audit log ------------------------------
  const audit = sheetOf(data, "Audit");
  const auditText = (value) =>
    isDateCell(value) ? zoned(value.$date, sheetZone) : safeTrim(value);
  const auditLog = [];
  for (const row of audit.rows) {
    if (row.blank()) continue;
    const field = (name) => auditText(row.get([name]));
    auditLog.push({
      sheetRow: row.sheetRow,
      timestamp: field("timestamp"),
      audit_id: field("audit_id"),
      actor_email: field("actor_email"),
      actor_role: field("actor_role"),
      action: field("action"),
      target_type: field("target_type"),
      target_id: field("target_id"),
      outcome: field("outcome"),
      details: field("details"),
      request_id: field("request_id"),
      previous_hash: field("previous_hash"),
      entry_hash: field("entry_hash"),
    });
  }
  const outcomeOk = auditLog.every(
    (e) => e.outcome === "SUCCESS" || e.outcome === "FAILURE",
  );
  if (!outcomeOk)
    report(
      "error",
      "Audit",
      null,
      "outcome",
      "an entry whose outcome is not SUCCESS or FAILURE.",
    );
  const ids = new Set();
  for (const entry of auditLog) {
    if (!entry.audit_id || ids.has(entry.audit_id))
      report(
        "error",
        "Audit",
        entry.sheetRow,
        "audit_id",
        "a missing or repeated audit id.",
      );
    ids.add(entry.audit_id);
  }

  // The chain, checked as adminGetAuditLog checks it. A break is reported,
  // not mended: the log is imported exactly as it stands.
  const head = safeTrim(data.properties?.AUDIT_HEAD_HASH);
  let chain;
  if (!auditSecret) chain = { checked: false };
  else {
    let previous = null,
      broken = null;
    for (const entry of auditLog) {
      if (!broken) {
        if (auditHmac(auditCanonical(entry), auditSecret) !== entry.entry_hash)
          broken = { reason: "contents", row: entry.sheetRow };
        else if (previous !== null && entry.previous_hash !== previous)
          broken = { reason: "link", row: entry.sheetRow };
      }
      previous = entry.entry_hash;
    }
    if (!broken && head && previous !== head)
      broken = { reason: "head", row: null };
    chain = { checked: true, intact: !broken, broken };
    if (broken)
      report(
        "warning",
        "Audit",
        broken.row,
        "entry_hash",
        `the chain is already broken here (${broken.reason}); the log is imported exactly as it stands.`,
      );
  }

  return {
    tables: {
      settings,
      services,
      responses,
      serviceStats: [...statsByKey.values()],
      reports,
      adminUsers,
      auditLog: auditLog.map(({ sheetRow, timestamp, ...entry }) => ({
        logged_at: timestamp,
        ...entry,
      })),
      auditState: {
        head_hash: head,
        dropped_count: Number(data.properties?.AUDIT_DROPPED_COUNT) || 0,
        dropped_last: safeTrim(data.properties?.AUDIT_DROPPED_LAST),
      },
    },
    problems,
    chain,
    zones: { script: scriptZone, spreadsheet: sheetZone },
  };
}
