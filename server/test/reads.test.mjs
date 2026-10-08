import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { handleRequest } from "../dispatch.mjs";
import { appsScript } from "./apps-script.mjs";
import { ADMIN, buildDataset, loadIntoDb, loadIntoGas } from "./dataset.mjs";
import { SERVICES, addServices, freshDatabase } from "./fixture.mjs";

/**
 * Every admin read, put to Apps Script (the real .gs files) and to the new
 * backend over the same records, must come back the same.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";

let db, gas, token;
before(async () => {
  const data = buildDataset();
  db = await freshDatabase();
  await addServices(db);
  await loadIntoDb(db, data);
  gas = appsScript({ services: SERVICES });
  loadIntoGas(gas, data);
  const login = await handleRequest(
    { action: "adminLogin", email: ADMIN.email, password: ADMIN.password },
    { db, requestContext: { clientIp: "192.0.2.1", requestId: "sin1::reads" } },
  );
  assert.equal(login.ok, true, login.error);
  token = login.data.token;
});

async function both(action, args) {
  const reply = await handleRequest(
    { action, adminToken: token, ...args },
    { db },
  );
  assert.equal(reply.ok, true, reply.error);
  const call = {
    adminGetOverview: `adminGetOverview(__a.period || {}, 't')`,
    adminGetResponses: `adminGetResponses(__a.filters || {}, 't')`,
    adminGetCoaRequests: `adminGetCoaRequests(__a.filters || {}, 't')`,
    adminGetServices: `adminGetServices('t')`,
    adminGetSettings: `adminGetSettings('t')`,
    adminGetServiceStats: `adminGetServiceStats(__a.period || {}, 't')`,
    adminGetReports: `adminGetReports('t')`,
    adminGetUsers: `adminGetUsers('t')`,
    adminGetAuditLog: `adminGetAuditLog(__a.filters || {}, 't')`,
  }[action];
  return { actual: reply.data, expected: gas.call(call, { __a: args }) };
}

const same = async (action, args = {}) => {
  const { actual, expected } = await both(action, args);
  assert.deepEqual(actual, expected);
  return actual;
};

describe("adminGetOverview", () => {
  const periods = [
    { type: "quarter", year: 2026, quarter: 1 },
    { type: "quarter", year: "2026", quarter: "3" },
    { type: "quarter", year: 2026, quarter: 4 },
    { type: "quarter", year: 2025, quarter: 4 },
    { type: "year", year: 2026 },
    { type: "YEAR", year: 2025 },
    { type: "quarter", year: 2027, quarter: 1 },
    { type: "quarter", year: 2026, quarter: 9 },
    { type: "quarter", year: 2026.5, quarter: 2 },
    {},
  ];
  for (const period of periods)
    test(JSON.stringify(period), async () => {
      const overview = await same("adminGetOverview", { period });
      if (JSON.stringify(period) === '{"type":"year","year":2026}')
        assert.ok(
          overview.totalResponses > 30,
          "the dataset exercises the year",
        );
    });
});

describe("adminGetResponses", () => {
  const filters = [
    {},
    { offset: 25 },
    { offset: 50, limit: 25 },
    { offset: 500 },
    { limit: 10 },
    { limit: 9999 },
    { limit: "abc", offset: "x" },
    { query: "gmail" },
    { query: "  CSM-001 " },
    { query: "region 4" },
    { query: "citizen" },
    { query: "queue was" },
    { query: "=sum" },
    { query: "no such text anywhere" },
    { serviceCode: "cem/ced" },
    { serviceCode: "OTHER", query: "walk-in" },
    { coaStatus: "issued" },
    { coaStatus: "NONE" },
    { coaStatus: "ERROR: Drive quota exceeded" },
    { period: { type: "quarter", year: 2026, quarter: 3 } },
    {
      period: { type: "year", year: "2026" },
      serviceCode: "SIAP 1",
      offset: 3,
      limit: 25,
    },
    { period: { type: "quarter", year: "" } },
    {
      period: { type: "quarter", year: 2026, quarter: 4 },
      coaStatus: "REQUESTED",
      query: "@",
    },
  ];
  for (const f of filters)
    test(JSON.stringify(f), () => same("adminGetResponses", { filters: f }));
});

describe("adminGetCoaRequests", () => {
  for (const status of [
    "",
    "requested",
    "PROCESSING",
    "ISSUED",
    "DECLINED",
    "ERROR",
    "NONE",
  ])
    test(status || "(all)", async () => {
      const list = await same("adminGetCoaRequests", { filters: { status } });
      if (status === "ISSUED")
        assert.ok(
          list.some((c) => c.detailsChanged) &&
            list.some((c) => !c.detailsChanged),
        );
    });
});

describe("programs, settings, statistics, reports and users", () => {
  test("adminGetServices", async () => {
    const { actual, expected } = await both("adminGetServices", {});
    // The sheet's row number, which no screen reads, has no counterpart here.
    assert.deepEqual(
      actual,
      expected.map(({ rowIndex, ...service }) => service),
    );
  });
  test("adminGetSettings", () => same("adminGetSettings"));
  for (const period of [
    { type: "quarter", year: 2026, quarter: 3 },
    { type: "quarter", year: 2026, quarter: 2 },
    { type: "year", year: 2026 },
    { type: "quarter", year: 2030, quarter: 1 },
  ])
    test(`adminGetServiceStats ${JSON.stringify(period)}`, () =>
      same("adminGetServiceStats", { period }));
  test("adminGetReports", () => same("adminGetReports"));
  test("adminGetUsers", () => same("adminGetUsers"));
});

describe("adminGetAuditLog", () => {
  before(async () => {
    // A few more entries to read, then the same log copied into the sheet.
    for (const password of ["wrong password!", ADMIN.password])
      await handleRequest(
        { action: "adminLogin", email: ADMIN.email, password },
        { db, requestContext: { clientIp: "192.0.2.2" } },
      );
    const entries = await db.query(
      `select logged_at as timestamp, audit_id, actor_email, actor_role, action, target_type,
              target_id, outcome, details, request_id, previous_hash, entry_hash
       from csm.audit_log order by seq`,
    );
    const columns = Object.keys(entries[0]);
    gas.setSheet("Audit", [
      columns,
      ...entries.map((e) => columns.map((c) => e[c])),
    ]);
    gas.props.AUDIT_HEAD_HASH = entries.at(-1).entry_hash;
  });

  for (const filters of [
    {},
    { outcome: "failure" },
    { action: "LOGIN", query: "192" },
    { query: "sin1::reads" },
    { limit: 1 },
    { offset: 2 },
    { offset: 10000 },
  ])
    test(JSON.stringify(filters), async () => {
      const log = await same("adminGetAuditLog", { filters });
      assert.equal(log.integrity.valid, true);
    });

  test("pages run newest first, and the summary covers every match", async () => {
    const all = await same("adminGetAuditLog", { filters: { limit: 500 } });
    const page = await same("adminGetAuditLog", {
      filters: { limit: 25, offset: 2 },
    });
    assert.deepEqual(
      page.entries.map((entry) => entry.audit_id),
      all.entries.slice(2, 27).map((entry) => entry.audit_id),
    );
    assert.equal(page.total, all.total);
    assert.deepEqual(page.summary, {
      logins: all.entries.filter(
        (entry) => entry.action === "LOGIN" && entry.outcome === "SUCCESS",
      ).length,
      failures: all.entries.filter((entry) => entry.outcome === "FAILURE")
        .length,
    });
    assert.ok(page.summary.failures > 0, "the fixture holds a failed sign-in");
  });

  test("a missing head is reported the same way", async () => {
    await db.query(
      "update csm.audit_state set head_hash = 'not-the-last-entry'",
    );
    gas.props.AUDIT_HEAD_HASH = "not-the-last-entry";
    const log = await same("adminGetAuditLog", { filters: {} });
    assert.deepEqual(log.integrity.broken, {
      reason: "head",
      row: null,
      auditId: "",
    });
  });
});

describe("authorisation", () => {
  test("every read refuses a missing or wrong token", async () => {
    for (const action of [
      "adminGetOverview",
      "adminGetResponses",
      "adminGetCoaRequests",
      "adminGetServices",
      "adminGetSettings",
      "adminGetServiceStats",
      "adminGetReports",
      "adminGetUsers",
      "adminGetAuditLog",
    ]) {
      const reply = await handleRequest({ action, adminToken: "nope" }, { db });
      assert.equal(
        reply.error,
        "Forbidden: administrator authorization required.",
        action,
      );
    }
  });
});
