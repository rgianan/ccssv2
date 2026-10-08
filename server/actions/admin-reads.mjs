import { timingSafeEqual } from "node:crypto";
import { auditCanonical, auditHmac } from "../audit.mjs";
import { requireAdmin, requireSuperadmin } from "../auth.mjs";
import {
  coaDetailsOf,
  issuedCoaDetails,
  sameCoaDetails,
} from "../certificates.mjs";
import { dateCoverage, officeDay, officeMinute } from "../dates.mjs";
import { normalizePeriod, periodRange } from "../periods.mjs";
import {
  CC_KEYS,
  RESPONSE_COLUMNS,
  SQD_KEYS,
  meanOf,
  responseRecord,
  safeTrim,
} from "../records.mjs";
import { applyAnswerPolicy, overallScore, round2 } from "../scores.mjs";

/**
 * What the admin screens read: the Overview, Responses, Certificates,
 * Programs, Settings, report statistics, the reports list, Users and the
 * audit log. Each answers with the fields, order and wording its Apps Script
 * namesake used, so the screens need no change.
 */

const SERVICE_COLUMNS = `service_id, code, name_en, name_tl, category, active, has_fees, sort_order`;
const SERVICE_ORDER = `order by sort_order, created_at, service_id`;

/** Every programme, withdrawn ones included, in the order the list shows. */
export const allServices = (db) =>
  db.query(`select ${SERVICE_COLUMNS} from csm.services ${SERVICE_ORDER}`);

/** Responses whose transaction date falls in `period`, oldest first. */
export async function periodRecords(db, period) {
  const range = periodRange(period);
  if (!range) return [];
  const rows = await db.query(
    `select ${RESPONSE_COLUMNS} from csm.responses
     where transaction_date >= $1::date and transaction_date < $2::date
     order by seq`,
    [range.from, range.to],
  );
  return rows.map(responseRecord);
}

// --------------------------------- Overview -----------------------------------

const AGE_BRACKETS = [
  { label: "16 & Below (Child)", min: 0, max: 16 },
  { label: "17-30 (Young Adult)", min: 17, max: 30 },
  { label: "31-45 (Middle-aged Adult)", min: 31, max: 45 },
  { label: "Above 45 (Old-aged adult)", min: 46, max: 200 },
];

function ageBracketOf(age) {
  const value = Number(age);
  if (!value || Number.isNaN(value)) return "N/A";
  return (
    AGE_BRACKETS.find((b) => value >= b.min && value <= b.max)?.label || "N/A"
  );
}

/** Counts by value, in order of first appearance; a blank counts as N/A. */
function tally(values) {
  const counts = {};
  for (const value of values) {
    const key = value || "N/A";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export async function adminGetOverview(ctx, periodInput, token) {
  await requireAdmin(ctx, token);
  const period = normalizePeriod(periodInput, ctx.now);
  const [rows, services, [pending]] = await Promise.all([
    periodRecords(ctx.db, period),
    allServices(ctx.db),
    // Pending certificates are a work queue, not a period statistic: every
    // one still awaiting release counts, whatever period is on screen.
    ctx.db.query(
      `select count(*)::int as n from csm.responses
       where coa_requested and coa_status in ('REQUESTED', 'PROCESSING')`,
    ),
  ]);
  // Read through the report's answer policy, so the dashboard and the filed
  // workbook give the same score for the same quarter.
  const records = applyAnswerPolicy(rows, services);

  const byService = new Map();
  for (const record of records) {
    if (!byService.has(record.serviceCode))
      byService.set(record.serviceCode, {
        code: record.serviceCode,
        name: record.serviceName,
        records: [],
      });
    byService.get(record.serviceCode).records.push(record);
  }
  const aware = records.filter((r) => ["1", "2", "3"].includes(r.cc1)).length;

  return {
    period,
    totalResponses: records.length,
    overall: overallScore(records),
    ccAwareness: records.length
      ? Math.round((aware / records.length) * 1000) / 10
      : 0,
    sqd: Object.fromEntries(
      SQD_KEYS.map((key) => [
        key,
        { mean: round2(meanOf(records.map((r) => r[key]))) },
      ]),
    ),
    cc: Object.fromEntries(
      CC_KEYS.map((key) => [key, tally(records.map((r) => r[key]))]),
    ),
    clientTypes: tally(records.map((r) => r.clientType)),
    sexes: tally(records.map((r) => r.sex)),
    ageBrackets: tally(records.map((r) => ageBracketOf(r.age))),
    services: [...byService.values()]
      .map((bucket) => ({
        code: bucket.code,
        name: bucket.name,
        respondents: bucket.records.length,
        overall: overallScore(bucket.records),
      }))
      .sort((a, b) => b.respondents - a.respondents),
    coa: {
      issued: records.filter((r) => r.coaRequested && r.coaStatus === "ISSUED")
        .length,
      pending: pending.n,
      failed: records.filter(
        (r) => r.coaRequested && r.coaStatus.startsWith("ERROR"),
      ).length,
    },
  };
}

// --------------------------------- Responses ----------------------------------

/** The response shape the admin table consumes: publicResponse_ in Code.gs. */
function publicResponse(record) {
  const out = {
    referenceId: record.referenceId,
    transactionDate: record.transactionDate,
    clientType: record.clientType,
    sex: record.sex,
    age: record.age,
    region: record.region,
    serviceCode: record.serviceCode,
    serviceName: record.serviceName,
    otherService: record.otherService,
    email: record.email,
    suggestions: record.suggestions,
    overall: round2(record.overall),
    coaStatus: record.coaStatus,
  };
  for (const key of [...CC_KEYS, ...SQD_KEYS]) out[key] = record[key];
  return out;
}

/**
 * Filters and pages over every response, newest first, with the true match
 * count, so the screen can say what it is showing and what it is not.
 */
export async function adminGetResponses(ctx, filters, token) {
  await requireAdmin(ctx, token);
  filters = filters || {};
  const query = safeTrim(filters.query).toLowerCase();
  const serviceCode = safeTrim(filters.serviceCode).toUpperCase();
  const coaStatus = safeTrim(filters.coaStatus).toUpperCase();
  const period =
    filters.period && safeTrim(filters.period.year)
      ? normalizePeriod(filters.period, ctx.now)
      : null;
  const limit = Math.min(500, Math.max(25, Number(filters.limit) || 100));
  const offset = Math.max(0, Number(filters.offset) || 0);

  const params = [];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [];
  if (period) {
    const range = periodRange(period);
    where.push(
      range
        ? `transaction_date >= ${param(range.from)}::date and transaction_date < ${param(range.to)}::date`
        : "false",
    );
  }
  if (serviceCode) where.push(`upper(service_code) = ${param(serviceCode)}`);
  if (coaStatus) where.push(`upper(coa_status) = ${param(coaStatus)}`);
  if (query)
    // The fields the search box has always matched, joined as one text.
    where.push(
      `strpos(lower(concat_ws(' ', reference_id, email, service_name, other_service,
         region, client_type, suggestions)), ${param(query)}) > 0`,
    );
  const filter = where.length ? `where ${where.join(" and ")}` : "";

  const [[{ total }], rows] = await Promise.all([
    ctx.db.query(
      `select count(*)::int as total from csm.responses ${filter}`,
      params,
    ),
    ctx.db.query(
      `select ${RESPONSE_COLUMNS} from csm.responses ${filter}
       order by seq desc
       limit ${Math.trunc(limit)} offset ${Math.trunc(Math.min(offset, 1e15))}`,
      params,
    ),
  ]);
  return {
    rows: rows.map((row) => publicResponse(responseRecord(row))),
    total,
    offset,
    limit,
  };
}

// -------------------------------- Certificates --------------------------------

export async function adminGetCoaRequests(ctx, filters, token) {
  await requireAdmin(ctx, token);
  const wanted = safeTrim((filters || {}).status).toUpperCase();
  const params = [];
  let status = "";
  if (wanted === "ERROR") status = "and coa_status like 'ERROR%'";
  // An issuance cut off mid-run is left at PROCESSING; it is still awaiting
  // release, so that is where it is listed.
  else if (wanted === "REQUESTED")
    status = "and coa_status in ('REQUESTED', 'PROCESSING')";
  else if (wanted) {
    params.push(wanted);
    status = "and coa_status = $1";
  }
  const rows = await ctx.db.query(
    `select ${RESPONSE_COLUMNS} from csm.responses
     where coa_requested ${status} order by seq desc`,
    params,
  );
  return rows.map(responseRecord).map((record) => {
    const failed = record.coaStatus.startsWith("ERROR");
    return {
      referenceId: record.referenceId,
      email: record.email,
      coaTitle: record.coaTitle,
      coaName: record.coaName,
      coaAgency: record.coaAgency,
      coaPurpose: record.coaPurpose,
      coaDateFrom: record.coaDateFrom,
      coaDateTo: record.coaDateTo,
      coaDateCoverage: dateCoverage(record.coaDateFrom, record.coaDateTo),
      coaStatus: failed ? "ERROR" : record.coaStatus,
      coaError: failed ? record.coaStatus : "",
      coaLink: record.coaLink,
      coaIssuedAt: record.coaIssuedAt,
      coaDeclineReason: record.coaDeclineReason,
      verificationCode: record.verificationCode,
      // Edited after release: the certificate in the client's hands, and what
      // /verification says, still carry the details it was issued with.
      detailsChanged:
        record.coaStatus === "ISSUED" &&
        !sameCoaDetails(issuedCoaDetails(record), coaDetailsOf(record)),
    };
  });
}

// ---------------------------- Programs and settings ---------------------------

export async function adminGetServices(ctx, token) {
  await requireAdmin(ctx, token);
  return allServices(ctx.db);
}

export async function adminGetSettings(ctx, token) {
  await requireAdmin(ctx, token);
  const rows = await ctx.db.query(
    "select key, value from csm.settings where key <> '' order by key",
  );
  return Object.fromEntries(rows.map((row) => [row.key, safeTrim(row.value)]));
}

// --------------------------- Report statistics --------------------------------

export async function adminGetServiceStats(ctx, periodInput, token) {
  await requireAdmin(ctx, token);
  const period = normalizePeriod(periodInput, ctx.now);
  const range = periodRange(period);
  const [services, stats, counts] = await Promise.all([
    allServices(ctx.db),
    ctx.db.query(
      `select service_id, clients, transactions, remarks
       from csm.service_stats where period_key = $1`,
      [period.key],
    ),
    range
      ? ctx.db.query(
          `select service_id, count(*)::int as n from csm.responses
           where transaction_date >= $1::date and transaction_date < $2::date
           group by service_id`,
          [range.from, range.to],
        )
      : [],
  ]);
  const statOf = new Map(stats.map((s) => [s.service_id, s]));
  const respondentsOf = new Map(counts.map((c) => [c.service_id, c.n]));
  const text = (value) => (value == null ? "" : String(value));
  return services.map((service) => {
    const stat = statOf.get(service.service_id) || {};
    return {
      service_id: service.service_id,
      code: service.code,
      name_en: service.name_en,
      category: service.category,
      respondents: respondentsOf.get(service.service_id) || 0,
      clients: text(stat.clients),
      transactions: text(stat.transactions),
      remarks: safeTrim(stat.remarks),
    };
  });
}

// ---------------------------------- Reports -----------------------------------

export async function adminGetReports(ctx, token) {
  await requireAdmin(ctx, token);
  const rows = await ctx.db.query(
    `select report_id, name, period_key, period_label, url, created_at, created_by
     from csm.reports order by seq desc`,
  );
  return rows.map((row) => ({
    report_id: row.report_id,
    name: row.name,
    period_key: row.period_key,
    period_label: row.period_label,
    url: row.url,
    created_at: officeMinute(new Date(row.created_at)),
    created_by: row.created_by,
  }));
}

// ----------------------------------- Users ------------------------------------

export async function adminGetUsers(ctx, token) {
  await requireSuperadmin(ctx, token);
  const rows = await ctx.db.query(
    `select user_id, name, role, email, active, created_at, updated_at
     from csm.admin_users order by created_at, user_id`,
  );
  return rows.map((row) => ({
    user_id: row.user_id,
    name: row.name,
    role: row.role,
    email: row.email,
    active: row.active,
    created_at: officeDay(new Date(row.created_at)),
    updated_at: officeDay(new Date(row.updated_at)),
  }));
}

// --------------------------------- Audit log ----------------------------------

const sameText = (a, b) => {
  const left = Buffer.from(String(a)),
    right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The log, newest first, and whether its chain is intact: every entry's own
 * hash, every link to the entry before, and the last entry against the head
 * recorded apart from the log. The first break is reported by position —
 * counted as the Audit sheet numbered its rows, so an imported entry points
 * at the same row of the archived sheet.
 */
export async function adminGetAuditLog(ctx, filters, token) {
  await requireSuperadmin(ctx, token);
  filters = filters || {};
  const [[state], entries] = await Promise.all([
    ctx.db.query(
      "select head_hash, dropped_count, dropped_last from csm.audit_state",
    ),
    ctx.db.query(
      `select logged_at as timestamp, audit_id, actor_email, actor_role, action, target_type,
              target_id, outcome, details, request_id, previous_hash, entry_hash
       from csm.audit_log order by seq`,
    ),
  ]);
  const expectedHead = state?.head_hash || "";
  const dropped = state?.dropped_count || 0;
  const droppedLast = safeTrim(state?.dropped_last);
  if (!entries.length)
    return {
      entries: [],
      total: 0,
      integrity: {
        valid: !expectedHead && !dropped,
        checkedRows: 0,
        dropped,
        droppedLast,
      },
      summary: { logins: 0, failures: 0 },
    };

  const secret = process.env.AUDIT_HASH_SECRET || "";
  let broken = null,
    previous = null;
  entries.forEach((entry, index) => {
    if (!broken) {
      const at = { row: index + 2, auditId: entry.audit_id };
      if (!secret) broken = { reason: "secret", ...at };
      else if (
        !sameText(auditHmac(auditCanonical(entry), secret), entry.entry_hash)
      )
        broken = { reason: "contents", ...at };
      else if (previous !== null && entry.previous_hash !== previous)
        broken = { reason: "link", ...at };
    }
    previous = entry.entry_hash;
  });
  if (!broken && expectedHead && previous !== expectedHead)
    broken = { reason: "head", row: null, auditId: "" };

  const action = safeTrim(filters.action).toUpperCase();
  const outcome = safeTrim(filters.outcome).toUpperCase();
  const query = safeTrim(filters.query).toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      (!action || entry.action === action) &&
      (!outcome || entry.outcome === outcome) &&
      (!query ||
        [
          entry.actor_email,
          entry.target_id,
          entry.action,
          entry.details,
          entry.request_id,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
  const limit = Math.min(500, Math.max(25, Number(filters.limit) || 200));
  // A page of the matching entries, newest first; offset 0 is the newest.
  const offset = Math.max(0, Math.trunc(Number(filters.offset) || 0));
  return {
    entries: filtered
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map(({ previous_hash, entry_hash, ...entry }) => {
        let details = {};
        try {
          details = JSON.parse(entry.details || "{}");
        } catch {}
        return { ...entry, details };
      }),
    integrity: {
      valid: !broken && !dropped,
      broken,
      checkedRows: entries.length,
      dropped,
      droppedLast,
    },
    total: filtered.length,
    // Across every matching entry, not the page: the tab's figures would
    // otherwise describe only the 25 rows on screen.
    summary: {
      logins: filtered.filter(
        (entry) => entry.action === "LOGIN" && entry.outcome === "SUCCESS",
      ).length,
      failures: filtered.filter((entry) => entry.outcome === "FAILURE").length,
    },
  };
}
