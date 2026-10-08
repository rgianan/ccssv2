import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MONTH_NAMES, officeMinute, officeSecond } from "./dates.mjs";
import { database } from "./db.mjs";
import { RESPONSE_COLUMNS, responseRecord } from "./records.mjs";

/**
 * The way back, should the cutover have to be undone: what the new backend
 * took after `since`, in the shape the Responses sheet holds it, for
 * restoreFromNewBackend() in Export.gs to put back.
 *
 *   npm run db:rollback -- --since 2026-10-10T08:00:00+08:00
 *
 * Writes .import/rollback-<time>.json: new responses, certificates issued on
 * older ones, and the administrators' other actions since then, which are
 * listed for redoing by hand. Upload the file to Drive and run
 * restoreFromNewBackend() from the Apps Script editor.
 */

export const ROLLBACK_FORMAT = "csm-rollback-1";

/** A response as the sheet's columns hold it, keyed by header. */
function sheetRow(record, row) {
  const [year, month] = record.transactionDate.split("-").map(Number);
  const out = {
    Timestamp: new Date(row.submitted_at).toISOString(),
    ResponseID: record.referenceId,
    SubmissionID: row.submission_id || "",
    TransactionDate: record.transactionDate,
    Month: MONTH_NAMES[month - 1].toUpperCase(),
    Year: year,
    ClientType: record.clientType,
    Sex: record.sex,
    Age: record.age,
    Region: record.region,
    RegionCode: record.regionCode,
    ServiceID: record.serviceId,
    ServiceCode: record.serviceCode,
    ServiceName: record.serviceName,
    OtherService: record.otherService,
    Suggestions: record.suggestions,
    Email: record.email,
    Language: row.language,
    COARequested: record.coaRequested ? "YES" : "NO",
    ...certificateCells(record),
    COATitle: record.coaTitle,
    COAName: record.coaName,
    COAAgency: record.coaAgency,
    COAPurpose: record.coaPurpose,
    COADateFrom: record.coaDateFrom,
    COADateTo: record.coaDateTo,
    COADeclineReason: record.coaDeclineReason,
    privacy_notice_version: row.privacy_notice_version || "",
    privacy_notice_presented_at: row.privacy_notice_presented_at
      ? new Date(row.privacy_notice_presented_at).toISOString()
      : "",
  };
  for (const key of [
    "cc1",
    "cc2",
    "cc3",
    "sqd0",
    "sqd1",
    "sqd2",
    "sqd3",
    "sqd4",
    "sqd5",
    "sqd6",
    "sqd7",
    "sqd8",
  ])
    out[key.toUpperCase()] = record[key];
  return out;
}

/** The columns an issuance writes. */
const certificateCells = (record) => ({
  COAStatus: record.coaStatus,
  COALink: record.coaLink,
  COAIssuedAt: record.coaIssuedAt,
  COAIssueKey: record.coaIssueKey,
  COAIssuedDetails: record.coaIssuedDetails,
  VerificationCode: record.verificationCode,
  VerificationURL: record.verificationUrl,
});

export async function buildRollback(db, since) {
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) throw new Error(`"${since}" is not a time.`);
  const fresh = await db.query(
    `select ${RESPONSE_COLUMNS}, submission_id, language, privacy_notice_version,
            privacy_notice_presented_at
     from csm.responses where submitted_at >= $1 order by seq`,
    [at],
  );
  const issued = await db.query(
    `select ${RESPONSE_COLUMNS} from csm.responses
     where submitted_at < $1 and coa_issued_at >= $1 order by coa_issued_at`,
    [at],
  );
  // The audit log's own text: its timestamps are Manila's, to the second.
  const actions = await db.query(
    `select logged_at, actor_email, action, target_type, target_id, outcome
     from csm.audit_log where logged_at >= $1 and action <> 'LOGIN' and action <> 'LOGOUT'
     order by seq`,
    [officeSecond(at)],
  );
  return {
    format: ROLLBACK_FORMAT,
    since: at.toISOString(),
    sinceInManila: officeMinute(at),
    madeAt: new Date().toISOString(),
    responses: fresh.map((row) => sheetRow(responseRecord(row), row)),
    certificateUpdates: issued.map((row) => {
      const record = responseRecord(row);
      return { ResponseID: record.referenceId, ...certificateCells(record) };
    }),
    // Changes the restore cannot replay — a program edited, a request
    // declined, a response moved — for the office to redo by hand.
    otherActions: actions.filter(
      (a) => !(a.action === "COA_GENERATE" && a.outcome === "SUCCESS"),
    ),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values: options } = parseArgs({
    options: { since: { type: "string" } },
  });
  const db = database();
  try {
    if (!options.since)
      throw new Error(
        "Give the cutover time: npm run db:rollback -- --since 2026-10-10T08:00:00+08:00",
      );
    const rollback = await buildRollback(db, options.since);
    mkdirSync(".import", { recursive: true });
    const file = `.import/CSM rollback ${rollback.madeAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(rollback, null, 1));
    console.log(
      `Since ${rollback.sinceInManila} (Manila): ${rollback.responses.length} new responses, ` +
        `${rollback.certificateUpdates.length} certificates issued on older ones, ` +
        `${rollback.otherActions.length} other administrator actions to redo by hand.`,
    );
    console.log(
      `Saved ${file}. Upload it to Drive, then run restoreFromNewBackend() in the Apps Script editor.`,
    );
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
