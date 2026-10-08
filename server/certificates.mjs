import { dateCoverage } from "./dates.mjs";
import { safeTrim } from "./records.mjs";

/**
 * What a Certificate of Appearance prints, in the shape /verification shows
 * it — coaDetailsOf_, issuedCoaDetails_ and sameCoaDetails_ in
 * Certificate.gs.
 */

export const COA_DETAIL_KEYS = ["name", "agency", "purpose", "dateCoverage"];

/** From a response record's current fields. */
export const coaDetailsOf = (fields) => ({
  name: safeTrim(`${safeTrim(fields.coaTitle)} ${safeTrim(fields.coaName)}`),
  agency: safeTrim(fields.coaAgency),
  purpose: safeTrim(fields.coaPurpose),
  dateCoverage: dateCoverage(fields.coaDateFrom, fields.coaDateTo),
});

/**
 * What the certificate in circulation printed, recorded when it was issued.
 * A row issued before that record existed falls back to its live fields,
 * which is all there is to go on for it.
 */
export function issuedCoaDetails(record) {
  let stored = null;
  try {
    stored = JSON.parse(record.coaIssuedDetails || "null");
  } catch {}
  if (!stored || typeof stored !== "object") return coaDetailsOf(record);
  return Object.fromEntries(
    COA_DETAIL_KEYS.map((key) => [key, safeTrim(stored[key])]),
  );
}

export const sameCoaDetails = (a, b) =>
  COA_DETAIL_KEYS.every((key) => safeTrim(a[key]) === safeTrim(b[key]));
