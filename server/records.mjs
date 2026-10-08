import { MONTH_NAMES, officeMinute } from "./dates.mjs";

/**
 * A response as the portal has always passed it around: the record
 * buildResponseRecord_ in Code.gs made from a sheet row. The admin screens,
 * the certificate worker and the report all read this shape, so the database
 * row is turned into it rather than the other way round.
 */

export const safeTrim = (value) => String(value == null ? "" : value).trim();

export const CC_KEYS = ["cc1", "cc2", "cc3"];
export const SQD_KEYS = [
  "sqd0",
  "sqd1",
  "sqd2",
  "sqd3",
  "sqd4",
  "sqd5",
  "sqd6",
  "sqd7",
  "sqd8",
];

/** The columns responseRecord needs, with every date already text. */
export const RESPONSE_COLUMNS = `
  reference_id, submitted_at,
  to_char(transaction_date, 'YYYY-MM-DD') as transaction_date,
  client_type, sex, age, region, region_code,
  service_id, service_code, service_name, other_service,
  cc1, cc2, cc3, sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8,
  suggestions, email, coa_requested, coa_title, coa_name, coa_agency, coa_purpose,
  coalesce(to_char(coa_date_from, 'YYYY-MM-DD'), '') as coa_date_from,
  coalesce(to_char(coa_date_to, 'YYYY-MM-DD'), '') as coa_date_to,
  coa_status, coa_link, coa_issued_at, coa_issue_key, coa_issued_details,
  coa_decline_reason, verification_code, verification_url`;

/** N/A and blanks are left out of every CSM average, per the ARTA guidance. */
export function meanOf(values) {
  const scores = values.map(Number).filter((score) => score >= 1 && score <= 5);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

export function responseRecord(row) {
  const [year, month] = row.transaction_date.split("-").map(Number);
  const record = {
    referenceId: row.reference_id,
    timestamp: row.submitted_at,
    transactionDate: row.transaction_date,
    month: MONTH_NAMES[month - 1].toUpperCase(),
    year,
    clientType: row.client_type,
    sex: row.sex,
    age: row.age == null ? "N/A" : String(row.age),
    region: row.region,
    regionCode: row.region_code || "N/A",
    serviceId: row.service_id,
    serviceCode: row.service_code,
    serviceName: row.service_name,
    otherService: row.other_service,
    suggestions: row.suggestions,
    email: row.email,
    coaRequested: row.coa_requested === true,
    coaTitle: row.coa_title,
    coaName: row.coa_name,
    coaAgency: row.coa_agency,
    coaPurpose: row.coa_purpose,
    coaDateFrom: row.coa_date_from,
    coaDateTo: row.coa_date_to,
    // Upper-cased whole, as the sheet was read: error text included.
    coaStatus: String(row.coa_status || "").toUpperCase() || "NONE",
    coaLink: row.coa_link,
    coaIssuedAt: row.coa_issued_at
      ? officeMinute(new Date(row.coa_issued_at))
      : "",
    coaIssueKey: row.coa_issue_key,
    // Text, as the sheet held it: callers parse it themselves.
    coaIssuedDetails:
      row.coa_issued_details == null
        ? ""
        : JSON.stringify(row.coa_issued_details),
    coaDeclineReason: row.coa_decline_reason,
    verificationCode: row.verification_code || "",
    verificationUrl: row.verification_url,
  };
  for (const key of [...CC_KEYS, ...SQD_KEYS]) record[key] = row[key];
  record.overall = meanOf(SQD_KEYS.map((key) => record[key]));
  return record;
}
