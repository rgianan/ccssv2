import { randomUUID } from "node:crypto";
import { issuedCoaDetails } from "../certificates.mjs";
import { isUniqueViolation } from "../db.mjs";
import { officeDay, parseDay } from "../dates.mjs";
import {
  CC_KEYS,
  RESPONSE_COLUMNS,
  SQD_KEYS,
  responseRecord,
  safeTrim,
} from "../records.mjs";

/**
 * The three actions anyone may call: the programme list, a survey submission
 * and certificate verification. Each answers exactly what its Apps Script
 * namesake answered — same fields, same messages, same codes — so the
 * browser cannot tell which backend it reached.
 */

const DEFAULT_OFFICE_NAME = "Office of Student Development and Services (OSDS)";

// ------------------------------- Programme list -------------------------------

export async function getPortalConfig({ db }) {
  const [settings, services] = await Promise.all([
    db.query("select value from csm.settings where key = 'office_name'"),
    db.query(`
      select service_id, code, name_en, name_tl, category, has_fees
      from csm.services
      where active
      order by sort_order, created_at, service_id`),
  ]);
  return {
    officeName: safeTrim(settings[0]?.value) || DEFAULT_OFFICE_NAME,
    services: services.map((service) => ({
      service_id: service.service_id,
      code: service.code,
      name_en: service.name_en,
      name_tl: service.name_tl,
      category: service.category,
      active: true,
      has_fees: service.has_fees,
    })),
  };
}

// --------------------------------- Submission ---------------------------------

/**
 * Region name -> report code, as REGION_CODES_ in Code.gs: the official names
 * the form offers, then the portal's retired labels, which older rows hold.
 */
const REGION_CODES = {
  "national capital region": "NCR",
  "01 - ilocos region": "I",
  "02 - cagayan valley": "II",
  "03 - central luzon": "III",
  "04 - calabarzon": "IV-A",
  "05 - bicol region": "V",
  "06 - western visayas": "VI",
  "07 - central visayas": "VII",
  "08 - eastern visayas": "VIII",
  "09 - zamboanga peninsula": "IX",
  "10 - northern mindanao": "X",
  "11 - davao region": "XI",
  "12 - soccsksargen": "XII",
  caraga: "CARAGA",
  "cordillera administrative region": "CAR",
  "bangsamoro autonomous region in muslim mindanao": "BARMM",
  mimaropa: "IV-B",
  "negros island region": "NIR",

  // Retired labels, still present in older rows.
  "region ncr": "NCR",
  "region 1": "I",
  "region 2": "II",
  "region 3": "III",
  "region 4": "IV-A",
  "region 5": "V",
  "region 6": "VI",
  "region 7": "VII",
  "region 8": "VIII",
  "region 9": "IX",
  "region 10": "X",
  "region 11": "XI",
  "region 12": "XII",
  "region car": "CAR",
  "region caraga": "CARAGA",
  "region mimaropa": "IV-B",
  barmm: "BARMM",
  nir: "NIR",
};

export const regionCode = (region) =>
  Object.hasOwn(REGION_CODES, safeTrim(region).toLowerCase())
    ? REGION_CODES[safeTrim(region).toLowerCase()]
    : "N/A";

/**
 * Must stay in step with CC_QUESTIONS in src/lib/csm.js and the report's
 * columns; see CC_OPTIONS_ in Code.gs for why CC2 and CC3 offer fewer.
 */
const CC_OPTIONS = {
  cc1: ["1", "2", "3", "4"],
  cc2: ["1", "2", "3", "4"],
  cc3: ["1", "2", "3"],
};
/** CC1's "never encountered a Charter"; equals CC_UNAWARE_VALUE in src/lib/csm.js. */
const CC_UNAWARE_VALUE = "4";
const SQD_OPTIONS = ["1", "2", "3", "4", "5", "N/A"];
/** Where a fee is charged every client pays one, so there is no N/A to give. */
const SQD_RATED_OPTIONS = ["1", "2", "3", "4", "5"];

const hexId = (length) =>
  randomUUID().replace(/-/g, "").slice(0, length).toUpperCase();

const badRequest = (message, code) =>
  code
    ? { status: "BAD_REQUEST", code, message }
    : { status: "BAD_REQUEST", message };

/**
 * Checks a form as submitResponse in Code.gs does, in the same order, so the
 * first problem a client is told about is the same one. Returns the row to
 * store, or the answer to send back.
 */
async function checkedSubmission(db, formData, now) {
  const email = safeTrim(formData.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return { reply: badRequest("A valid email address is required.") };

  const clientType = safeTrim(formData.clientType);
  if (!["Citizen", "Business", "Government"].includes(clientType))
    return { reply: badRequest("Please select a valid client type.") };

  const transactionDay = parseDay(formData.transactionDate);
  if (!transactionDay)
    return { reply: badRequest("A valid transaction date is required.") };
  // A day not yet reached, or a mistyped year, files the response under a
  // quarter it does not belong to.
  if (transactionDay > officeDay(now))
    return {
      reply: badRequest("The transaction date cannot be in the future."),
    };
  if (transactionDay < "2000-01-01")
    return {
      reply: badRequest("Please check the year of the transaction date."),
    };

  const region = safeTrim(formData.region);
  if (!region) return { reply: badRequest("Region of residence is required.") };
  if (regionCode(region) === "N/A")
    return {
      reply: badRequest(
        "Please choose your region of residence from the list.",
      ),
    };

  const [service] = await db.query(
    `select service_id, code, name_en, category, has_fees
     from csm.services where service_id = $1 and active`,
    [safeTrim(formData.serviceId)],
  );
  // Also the answer when a programme is withdrawn while a client has the form
  // open; the code has the browser refresh its list.
  if (!service)
    return {
      reply: badRequest(
        "The service you chose is no longer offered. Please choose again from the list.",
        "SERVICE_UNAVAILABLE",
      ),
    };

  const sex = safeTrim(formData.sex).toUpperCase();
  if (sex && sex !== "MALE" && sex !== "FEMALE")
    return { reply: badRequest("Please choose a valid option for sex.") };

  const otherService = safeTrim(formData.otherService).slice(0, 200);
  if (service.category === "other" && !otherService)
    return { reply: badRequest("Please specify the service you availed.") };

  const age = safeTrim(formData.age);
  if (age && (!/^\d{1,3}$/.test(age) || Number(age) < 1 || Number(age) > 120))
    return { reply: badRequest("Age must be between 1 and 120.") };

  // A client who has never seen a Charter is not asked CC2 and CC3, and is
  // recorded as N/A whatever the browser sent.
  const cc = Object.fromEntries(
    CC_KEYS.map((key) => [key, safeTrim(formData[key])]),
  );
  const unawareOfCharter = cc.cc1 === CC_UNAWARE_VALUE;
  if (unawareOfCharter) cc.cc2 = cc.cc3 = "N/A";
  for (const key of CC_KEYS) {
    const allowed =
      unawareOfCharter && key !== "cc1" ? ["N/A"] : CC_OPTIONS[key];
    if (!allowed.includes(cc[key]))
      return {
        reply: badRequest("Please answer all Citizen’s Charter questions."),
      };
  }

  // SQD5 asks about fees, so only a fee-charging programme's clients answer
  // it; everyone else is recorded as N/A.
  const sqd = Object.fromEntries(
    SQD_KEYS.map((key) => [key, safeTrim(formData[key])]),
  );
  if (!service.has_fees) sqd.sqd5 = "N/A";
  for (const key of SQD_KEYS) {
    const allowed =
      key === "sqd5" && service.has_fees ? SQD_RATED_OPTIONS : SQD_OPTIONS;
    if (!allowed.includes(sqd[key]))
      return {
        reply:
          key === "sqd5" && service.has_fees
            ? badRequest(
                "Please rate the fees you paid for this transaction.",
                "SQD5_REQUIRED",
              )
            : badRequest(
                "Please answer all Service Quality Dimension questions.",
              ),
      };
  }

  const wantsCoa = safeTrim(formData.wantsCoa).toLowerCase() === "yes";
  const coaName = safeTrim(formData.coaName).slice(0, 160);
  const coaAgency = safeTrim(formData.coaAgency).slice(0, 200);
  const coaPurpose = safeTrim(formData.coaPurpose).slice(0, 300);
  const coaFrom = parseDay(formData.coaDateFrom);
  const coaTo = parseDay(formData.coaDateTo);
  if (wantsCoa && (!coaName || !coaAgency || !coaPurpose || !coaFrom))
    return {
      reply: badRequest("Complete the Certificate of Appearance details."),
    };
  if (wantsCoa && coaTo && coaTo < coaFrom)
    return {
      reply: badRequest(
        "The end date of your appearance cannot be earlier than its start.",
      ),
    };
  if (wantsCoa && coaFrom > officeDay(now))
    return {
      reply: badRequest("The date of appearance cannot be in the future."),
    };

  // Which Privacy Notice was on screen, recorded only when the form reports
  // one: a page from before the notice existed never showed it.
  const noticeVersion = safeTrim(formData.privacyNoticeVersion);
  const noticeShown = /^\d{1,3}(\.\d{1,3}){0,2}$/.test(noticeVersion);

  return {
    row: {
      submission_id: safeTrim(formData.submissionId).slice(0, 64) || null,
      transaction_date: transactionDay,
      client_type: clientType.toUpperCase(),
      sex,
      age: age ? Number(age) : null,
      region,
      region_code: regionCode(region),
      service_id: service.service_id,
      service_code: service.code,
      service_name: service.name_en,
      other_service: otherService,
      ...cc,
      ...sqd,
      suggestions: safeTrim(formData.suggestions).slice(0, 1500),
      email,
      // The only two the form has.
      language: safeTrim(formData.language) === "tl" ? "tl" : "en",
      coa_requested: wantsCoa,
      coa_title: wantsCoa ? safeTrim(formData.coaTitle).slice(0, 12) : "",
      coa_name: wantsCoa ? coaName : "",
      coa_agency: wantsCoa ? coaAgency : "",
      coa_purpose: wantsCoa ? coaPurpose : "",
      coa_date_from: wantsCoa ? coaFrom : null,
      coa_date_to: wantsCoa && coaTo ? coaTo : null,
      coa_status: wantsCoa ? "REQUESTED" : "NONE",
      privacy_notice_version: noticeShown ? noticeVersion : null,
      // The notice counts as presented when its form was submitted.
      privacy_notice_presented_at: noticeShown ? now : null,
    },
  };
}

const RESPONSE_INSERT_COLUMNS = [
  "reference_id",
  "verification_code",
  "submitted_at",
  "submission_id",
  "transaction_date",
  "client_type",
  "sex",
  "age",
  "region",
  "region_code",
  "service_id",
  "service_code",
  "service_name",
  "other_service",
  ...CC_KEYS,
  ...SQD_KEYS,
  "suggestions",
  "email",
  "language",
  "coa_requested",
  "coa_title",
  "coa_name",
  "coa_agency",
  "coa_purpose",
  "coa_date_from",
  "coa_date_to",
  "coa_status",
  "privacy_notice_version",
  "privacy_notice_presented_at",
];

const INSERT_RESPONSE = `
  insert into csm.responses (${RESPONSE_INSERT_COLUMNS.join(", ")})
  values (${RESPONSE_INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
  on conflict (submission_id) do nothing
  returning reference_id`;

export async function submitResponse({ db, now = new Date() }, formData) {
  formData = formData || {};
  // Bots fill every field they find; a real client never sees this one.
  if (safeTrim(formData.website))
    return { status: "OK", referenceId: "", coaRequested: false };

  const checked = await checkedSubmission(db, formData, now);
  if (checked.reply) return checked.reply;
  const { row } = checked;

  // A reference or verification code that happens to repeat one already
  // issued is drawn again; Apps Script could not tell, and stored both.
  for (let attempt = 0; attempt < 3; attempt++) {
    const values = {
      ...row,
      reference_id: `CSM-${hexId(10)}`,
      verification_code: row.coa_requested ? `OSDS-${hexId(20)}` : null,
      submitted_at: now,
    };
    let inserted;
    try {
      inserted = await db.query(
        INSERT_RESPONSE,
        RESPONSE_INSERT_COLUMNS.map((column) => values[column]),
      );
    } catch (error) {
      if (
        isUniqueViolation(error, "responses_pkey") ||
        isUniqueViolation(error, "responses_verification_code_key")
      )
        continue;
      throw error;
    }
    if (inserted.length)
      return {
        status: "OK",
        referenceId: inserted[0].reference_id,
        coaRequested: row.coa_requested,
      };

    // The browser retried a form whose first arrival was stored: answer with
    // that reference rather than counting the client twice.
    const [stored] = await db.query(
      "select reference_id, coa_requested from csm.responses where submission_id = $1",
      [row.submission_id],
    );
    if (!stored) continue;
    return {
      status: "OK",
      referenceId: stored.reference_id,
      coaRequested: stored.coa_requested,
      duplicate: true,
    };
  }
  throw new Error("Could not store the response. Please try again.");
}

// ------------------------------- Verification ---------------------------------

/**
 * Public and unauthenticated: one indexed lookup. A certificate shows what it
 * printed when issued, not what the row says now, and never its Drive link.
 */
export async function verifyCertificate({ db }, code) {
  code = safeTrim(code).toUpperCase();
  if (!/^OSDS-[A-F0-9]{20}$/.test(code)) return { valid: false };

  const [row] = await db.query(
    `select ${RESPONSE_COLUMNS} from csm.responses where verification_code = $1`,
    [code],
  );
  const record = row && responseRecord(row);
  if (!record || record.coaStatus !== "ISSUED") return { valid: false };

  const shown = issuedCoaDetails(record);
  return {
    valid: true,
    verificationCode: code,
    name: shown.name,
    agency: shown.agency,
    purpose: shown.purpose,
    dateCoverage: shown.dateCoverage,
    issuedAt: record.coaIssuedAt,
  };
}
