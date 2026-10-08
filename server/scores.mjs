import { meanOf, SQD_KEYS } from "./records.mjs";

/**
 * How CSM scores are computed, as Code.gs and Report.gs compute them. The
 * dashboard and the filed report must agree, so both read through these.
 */

export const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * The mean of every valid SQD answer across `records`, respondent-weighted,
 * N/A excluded: overallScore_ in Code.gs.
 */
export const overallScore = (records) =>
  round2(
    meanOf(records.flatMap((record) => SQD_KEYS.map((key) => record[key]))),
  );

/** CC1's "never encountered a Charter"; equals CC_UNAWARE_VALUE in src/lib/csm.js. */
const CC_UNAWARE_VALUE = "4";

/**
 * The rules the form now enforces, applied to every response whenever it was
 * collected — applyAnswerPolicy_ in Report.gs. SQD5 counts only for a
 * fee-charging programme, and CC2 and CC3 only for a client who has seen a
 * Charter; earlier forms asked both of everyone. Stored answers are left as
 * they are; this is only how they are read.
 */
export function applyAnswerPolicy(records, services) {
  const charges = new Set(
    services.filter((s) => s.has_fees).map((s) => s.service_id),
  );
  return records.map((record) => {
    const costsDoNotApply =
      !charges.has(record.serviceId) && record.sqd5 !== "N/A";
    const charterDoesNotApply =
      record.cc1 === CC_UNAWARE_VALUE &&
      (record.cc2 !== "N/A" || record.cc3 !== "N/A");
    if (!costsDoNotApply && !charterDoesNotApply) return record;
    const copy = { ...record };
    if (costsDoNotApply) {
      copy.sqd5 = "N/A";
      copy.overall = meanOf(SQD_KEYS.map((key) => copy[key]));
    }
    if (charterDoesNotApply) copy.cc2 = copy.cc3 = "N/A";
    return copy;
  });
}
