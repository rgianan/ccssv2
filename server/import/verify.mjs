import { randomBytes, createHash } from "node:crypto";
import { officeMinute } from "../dates.mjs";
import { handleRequest } from "../dispatch.mjs";
import { CC_KEYS, SQD_KEYS } from "../records.mjs";
import { appsScript } from "../test/apps-script.mjs";

/**
 * Asks Apps Script — the real .gs files, reading the export as it read the
 * sheets — and the new backend, reading the imported database, the same
 * questions: every quarter's overview and statistics, every page of
 * responses, every certificate list and verification, the programs, settings,
 * users, reports and the audit log. Each answer must match.
 *
 * Nothing is written: the backend is asked inside a transaction that is
 * rolled back, under a session that exists only for it.
 */

class RolledBack extends Error {}

const isDateCell = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.$date === "string";

/** Where two answers part, as paths; rows are named by their id. */
function differences(
  expected,
  actual,
  path = "",
  found = { count: 0, examples: [] },
) {
  const note = () => {
    found.count++;
    if (found.examples.length < 5)
      found.examples.push(path || "(whole answer)");
  };
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) note();
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      const item = expected[i];
      const label =
        item && typeof item === "object"
          ? item.referenceId ||
            item.verificationCode ||
            item.service_id ||
            item.user_id ||
            item.report_id ||
            item.audit_id ||
            item.code ||
            i
          : i;
      differences(item, actual[i], `${path}[${label}]`, found);
    }
    return found;
  }
  if (
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    for (const key of new Set([
      ...Object.keys(expected),
      ...Object.keys(actual),
    ]))
      differences(
        expected[key],
        actual[key],
        path ? `${path}.${key}` : key,
        found,
      );
    return found;
  }
  if (!Object.is(expected, actual)) note();
  return found;
}

/** "Sun Sep 20 2026 15:05:00 GMT+0800 (…)": a Date that Sheets made of text. */
const LONG_DATE =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/;

export async function verifyImport({
  db,
  data,
  transformed,
  auditSecret = "",
}) {
  // The rows each known difference touched, so a row seen on several pages
  // or filters is counted once.
  const known = {
    longIssueTimes: new Set(),
    blankAnswers: new Set(),
    invalidAges: new Set(),
  };

  // ---------------------- Apps Script, over the export ----------------------
  const gas = appsScript();
  for (const [name, rows] of Object.entries(data.sheets || {}))
    if (rows)
      gas.setSheet(
        name,
        rows.map((row) =>
          row.map((cell) => (isDateCell(cell) ? new Date(cell.$date) : cell)),
        ),
      );
  for (const key of Object.keys(gas.props)) delete gas.props[key];
  Object.assign(gas.props, data.properties || {});
  if (auditSecret) gas.props.AUDIT_HASH_SECRET = auditSecret;
  gas.call(
    "requireAdmin_ = requireSuperadmin_ = function () { return { email: 'verify', role: 'superadmin' }; }",
  );

  // What the import changed on purpose, so it is not reported as a difference.
  const placeholderIds = new Set(
    transformed.tables.services
      .filter((s) => s.sort_order === 9990 && s.active === false)
      .map((s) => s.service_id),
  );
  const importedEmails = new Set(
    transformed.tables.adminUsers.map((u) => u.email),
  );
  const alignAnswers = (row) => {
    const copy = { ...row };
    for (const key of [...CC_KEYS, ...SQD_KEYS]) {
      if (copy[key] === "") {
        copy[key] = "N/A";
        known.blankAnswers.add(row.referenceId);
      } else if (typeof copy[key] === "string")
        copy[key] = copy[key].toUpperCase();
    }
    if ("age" in copy && copy.age !== "N/A") {
      const n = Number(copy.age);
      if (!(Number.isInteger(n) && n >= 1 && n <= 120)) {
        copy.age = "N/A";
        known.invalidAges.add(row.referenceId);
      }
    }
    if (copy.sex === "N/A") copy.sex = "";
    return copy;
  };
  const alignIssueTime = (value, id) => {
    if (typeof value === "string" && LONG_DATE.test(value)) {
      known.longIssueTimes.add(id);
      return officeMinute(new Date(value));
    }
    return value;
  };

  const results = [];
  const compare = (check, expected, actual) => {
    const found = differences(expected, actual);
    results.push({
      check,
      same: found.count === 0,
      differences: found.count,
      examples: found.examples,
    });
  };

  try {
    await db.transaction(async (tx) => {
      // A superadmin and a session that exist only inside this transaction.
      const token = randomBytes(32).toString("hex");
      const userId = `U-verify-${randomBytes(3).toString("hex")}`;
      await tx.query(
        `insert into csm.admin_users (user_id, email, name, role, password_hash, credential_version)
         values ($1, $2, 'Import check', 'superadmin', 'none', 'v')`,
        [userId, `${userId.toLowerCase()}@import.invalid`],
      );
      await tx.query(
        `insert into csm.admin_sessions (token_hash, user_id, credential_version, expires_at)
         values ($1, $2, 'v', now() + interval '1 hour')`,
        [
          createHash("sha256")
            .update(`session|${token}`, "utf8")
            .digest("base64url"),
          userId,
        ],
      );
      const ask = async (action, args = {}) => {
        const reply = await handleRequest(
          { action, adminToken: token, ...args },
          { db: tx },
        );
        if (!reply.ok)
          throw new Error(
            `${action} failed on the new backend: ${reply.error}`,
          );
        return reply.data;
      };
      const gasAsk = (expression, args) => gas.call(expression, { __a: args });

      compare(
        "Program list on the survey",
        gasAsk("getPortalConfig()"),
        await ask("getPortalConfig"),
      );
      compare(
        "Programs",
        gasAsk("adminGetServices('t')").map(({ rowIndex, ...s }) => s),
        (await ask("adminGetServices")).filter(
          (s) => !placeholderIds.has(s.service_id),
        ),
      );
      compare(
        "Settings",
        gasAsk("adminGetSettings('t')"),
        await ask("adminGetSettings"),
      );

      const periods = await tx.query(
        `select distinct extract(year from transaction_date)::int as year,
                extract(quarter from transaction_date)::int as quarter
         from csm.responses order by 1, 2`,
      );
      const years = [...new Set(periods.map((p) => p.year))];
      for (const period of [
        ...periods.map((p) => ({
          type: "quarter",
          year: p.year,
          quarter: p.quarter,
        })),
        ...years.map((year) => ({ type: "year", year })),
      ]) {
        const label =
          period.type === "year"
            ? `${period.year}`
            : `${period.year}-Q${period.quarter}`;
        compare(
          `Overview ${label}`,
          gasAsk("adminGetOverview(__a, 't')", period),
          await ask("adminGetOverview", { period }),
        );
        compare(
          `Report statistics ${label}`,
          gasAsk("adminGetServiceStats(__a, 't')", period),
          (await ask("adminGetServiceStats", { period })).filter(
            (s) => !placeholderIds.has(s.service_id),
          ),
        );
      }

      // Every response, page by page, then the filters the screen offers.
      const responsePages = async (filters) => {
        const expected = [],
          actual = [];
        for (let offset = 0; ; offset += 500) {
          const theirs = gasAsk("adminGetResponses(__a, 't')", {
            ...filters,
            offset,
            limit: 500,
          });
          const ours = await ask("adminGetResponses", {
            filters: { ...filters, offset, limit: 500 },
          });
          expected.push({ ...theirs, rows: theirs.rows.map(alignAnswers) });
          actual.push(ours);
          if (offset + 500 >= Math.max(theirs.total, ours.total)) break;
        }
        return [expected, actual];
      };
      compare("Responses, every page", ...(await responsePages({})));
      const statuses = await tx.query(
        "select distinct coa_status from csm.responses order by 1",
      );
      for (const { coa_status } of statuses)
        compare(
          `Responses with certificate status ${coa_status.slice(0, 30)}`,
          ...(await responsePages({ coaStatus: coa_status })),
        );
      for (const year of years)
        compare(
          `Responses in ${year}`,
          ...(await responsePages({ period: { type: "year", year } })),
        );

      for (const status of [
        "",
        "REQUESTED",
        "PROCESSING",
        "ISSUED",
        "DECLINED",
        "ERROR",
      ])
        compare(
          `Certificates${status ? ` (${status.toLowerCase()})` : ""}`,
          gasAsk("adminGetCoaRequests(__a, 't')", { status }).map((c) => ({
            ...c,
            coaIssuedAt: alignIssueTime(c.coaIssuedAt, c.verificationCode),
          })),
          await ask("adminGetCoaRequests", { filters: { status } }),
        );

      const codes = await tx.query(
        "select verification_code from csm.responses where verification_code is not null order by seq",
      );
      const expectedChecks = [],
        actualChecks = [];
      for (const { verification_code: code } of codes) {
        const theirs = gas.call("verifyCertificate(__c)", { __c: code });
        expectedChecks.push(
          theirs.valid
            ? { ...theirs, issuedAt: alignIssueTime(theirs.issuedAt, code) }
            : theirs,
        );
        actualChecks.push(await ask("verifyCertificate", { code }));
      }
      compare(
        `Certificate verification, all ${codes.length} codes`,
        expectedChecks,
        actualChecks,
      );

      compare(
        "Reports list",
        gasAsk("adminGetReports('t')"),
        await ask("adminGetReports"),
      );
      compare(
        "Users",
        gasAsk("adminGetUsers('t')").filter((u) =>
          importedEmails.has(String(u.email).toLowerCase()),
        ),
        (await ask("adminGetUsers")).filter((u) => u.user_id !== userId),
      );
      const filters = { limit: 500 };
      compare(
        "Audit log and its chain check",
        gasAsk("adminGetAuditLog(__a, 't')", filters),
        await ask("adminGetAuditLog", { filters }),
      );
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return {
    results,
    known: Object.fromEntries(
      Object.entries(known).map(([name, rows]) => [name, rows.size]),
    ),
  };
}
