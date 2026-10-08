import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { handleRequest } from "../dispatch.mjs";
import { loadImport } from "../import/load.mjs";
import { transformExport } from "../import/transform.mjs";
import { verifyImport } from "../import/verify.mjs";
import { appsScript } from "./apps-script.mjs";
import { freshDatabase } from "./fixture.mjs";
import { PASSWORD, liveLikeSheets } from "./live-like.mjs";

/**
 * Phase 3 end to end: the sheets exported by the real Export.gs, imported,
 * and every admin read compared between Apps Script and the new backend.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";

describe("an import", () => {
  let gas, exported, transformed, db;
  before(async () => {
    ({ gas } = liveLikeSheets());
    exported = gas.call("buildCsmExport_()");
    transformed = transformExport(exported, { auditSecret: "audit" });
    db = await freshDatabase();
  });

  test("the export carries every sheet, dates marked as dates", () => {
    assert.equal(exported.format, "csm-export-1");
    assert.equal(exported.sheets.Responses.length, 65);
    assert.ok(exported.sheets.Responses[1].some((cell) => cell && cell.$date));
    assert.equal(exported.sheets.Audit.length, 4);
    assert.ok(exported.properties.AUDIT_HEAD_HASH);
  });

  test("reads every row, and says what it changed", () => {
    const t = transformed.tables;
    assert.equal(t.responses.length, 64);
    assert.equal(t.services.length, 4);
    assert.equal(t.adminUsers.length, 3);
    assert.equal(t.auditLog.length, 3);
    assert.deepEqual(transformed.chain, {
      checked: true,
      intact: true,
      broken: null,
    });
    const fixed = transformed.problems.filter((p) => p.level === "fixed");
    assert.deepEqual(fixed.map((p) => p.field).sort(), ["CC2", "SQD3"]);
    assert.equal(
      transformed.problems.filter((p) => p.level === "error").length,
      0,
    );
  });

  test("loads everything, in sheet order", async () => {
    const { loaded } = await loadImport(db, transformed.tables);
    assert.deepEqual(loaded, {
      responses: 64,
      services: 4,
      settings: 4,
      admin_users: 3,
      audit_log: 3,
      reports: 2,
      service_stats: 3,
    });
    const [first] = await db.query(
      "select reference_id from csm.responses order by seq limit 1",
    );
    assert.equal(first.reference_id, "CSM-0000TEST0");
  });

  test("and every screen then reads the same from both backends", async () => {
    const { results, known } = await verifyImport({
      db,
      data: exported,
      transformed,
      auditSecret: "audit",
    });
    const different = results.filter((r) => !r.same);
    assert.deepEqual(different, []);
    assert.ok(results.length > 30, `${results.length} checks ran`);
    assert.equal(known.blankAnswers, 2);
  });

  test("the passwords carried over still sign in", async () => {
    const reply = await handleRequest(
      { action: "adminLogin", email: "host@ched.gov.ph", password: PASSWORD },
      { db, requestContext: { clientIp: "192.0.2.1" } },
    );
    assert.equal(reply.ok, true, reply.error);
  });

  test("the audit chain continues from the imported head", async () => {
    const log = await handleRequest(
      {
        action: "adminGetAuditLog",
        adminToken: (
          await handleRequest(
            {
              action: "adminLogin",
              email: "host@ched.gov.ph",
              password: PASSWORD,
            },
            { db, requestContext: { clientIp: "192.0.2.2" } },
          )
        ).data.token,
      },
      { db },
    );
    assert.equal(log.data.integrity.valid, true);
    assert.ok(
      log.data.integrity.checkedRows >= 5,
      "imported entries plus the new sign-ins",
    );
  });

  test("will not load over data without --replace, and replaces cleanly with it", async () => {
    await assert.rejects(
      loadImport(db, transformed.tables),
      /already holds data/,
    );
    const { replaced, loaded } = await loadImport(db, transformed.tables, {
      replace: true,
    });
    assert.ok(replaced.audit_log > 3, "the sign-ins since were there");
    assert.equal(loaded.audit_log, 3);
    const after = await db.query(
      "select count(*)::int as n from csm.admin_sessions",
    );
    assert.equal(
      after[0].n,
      0,
      "sessions go with the accounts they belonged to",
    );
    assert.match(
      String(
        await db.query("delete from csm.audit_log").catch((e) => e.message),
      ),
      /append-only/,
      "and the log is append-only again",
    );
  });
});

describe("what an import will not carry over as it stands", () => {
  const exportOf = (sheets, properties = {}) => ({
    format: "csm-export-1",
    exportedAt: "2026-10-08T00:00:00.000Z",
    scriptTimeZone: "Asia/Manila",
    spreadsheetTimeZone: "Asia/Manila",
    sheets,
    properties,
  });
  const gas = appsScript();
  const HEAD = gas.headers;
  const response = (over) => {
    const values = {
      Timestamp: { $date: "2026-09-16T02:00:00.000Z" },
      ResponseID: "CSM-A",
      TransactionDate: "2026-09-16",
      Year: 2026,
      ClientType: "CITIZEN",
      Region: "National Capital Region",
      ServiceID: "S-1",
      ServiceCode: "SIAP 1",
      ServiceName: "SIAP",
      CC1: 1,
      CC2: 1,
      CC3: 1,
      SQD0: 5,
      SQD1: 5,
      SQD2: 5,
      SQD3: 5,
      SQD4: 5,
      SQD5: "N/A",
      SQD6: 5,
      SQD7: 5,
      SQD8: 5,
      Email: "a@b.ph",
      COAStatus: "NONE",
      ...over,
    };
    return HEAD.map((h) => (h in values ? values[h] : ""));
  };
  const SERVICES_SHEET = [
    [
      "service_id",
      "code",
      "name_en",
      "category",
      "active",
      "has_fees",
      "sort_order",
    ],
    ["S-1", "SIAP 1", "SIAP", "main", true, false, 10],
  ];
  const problemsOf = (sheets) =>
    transformExport(exportOf({ Services: SERVICES_SHEET, ...sheets })).problems;
  const levels = (problems) => problems.map((p) => `${p.level}:${p.field}`);

  test("a reference used twice, a bad client type, a bad answer, a bad date", () => {
    const problems = problemsOf({
      Responses: [
        HEAD,
        response({}),
        response({}),
        response({ ResponseID: "CSM-B", ClientType: "STUDENT" }),
        response({ ResponseID: "CSM-C", SQD1: 7 }),
        response({ ResponseID: "CSM-D", TransactionDate: "someday" }),
      ],
    });
    assert.deepEqual(levels(problems), [
      "error:ResponseID",
      "error:ClientType",
      "error:SQD1",
      "error:TransactionDate",
    ]);
    assert.ok(
      problems.every((p) => !p.message.includes("a@b.ph")),
      "no personal details in reports",
    );
  });

  test("a program missing from Services comes back as withdrawn", () => {
    const out = transformExport(
      exportOf({
        Services: SERVICES_SHEET,
        Responses: [
          HEAD,
          response({
            ServiceID: "S-OLD",
            ServiceCode: "OLD",
            ServiceName: "Old program",
          }),
        ],
      }),
    );
    const added = out.tables.services.find((s) => s.service_id === "S-OLD");
    assert.deepEqual([added.code, added.active], ["OLD", false]);
    assert.deepEqual(levels(out.problems), ["fixed:service_id"]);
  });

  test("a Year that disagrees with the date is flagged, the date kept", () => {
    const out = transformExport(
      exportOf({
        Services: SERVICES_SHEET,
        Responses: [HEAD, response({ Year: 2025 })],
      }),
    );
    assert.equal(out.tables.responses[0].transaction_date, "2026-09-16");
    assert.deepEqual(levels(out.problems), ["warning:Year"]);
  });

  test("accounts with no password, statistics that are not numbers, unreadable records", () => {
    const out = transformExport(
      exportOf({
        Services: SERVICES_SHEET,
        Responses: [
          HEAD,
          response({ COAIssuedDetails: "{not json", Age: 300, Language: "fr" }),
        ],
        Users: [
          ["Email", "PasswordHash", "Salt", "Name", "Role", "Active"],
          ["a@b.ph", "", "", "A", "admin", true],
        ],
        Whitelist: [
          ["user_id", "email", "role"],
          ["U-1", "a@b.ph", "admin"],
          ["U-2", "c@d.ph", "admin"],
        ],
        ServiceStats: [
          ["period_key", "service_id", "clients", "transactions"],
          ["2026-Q3", "S-1", "lots", 3],
          ["2026-Q3", "S-X", 1, 1],
        ],
      }),
    );
    assert.deepEqual(levels(out.problems).sort(), [
      "fixed:Age",
      "fixed:COAIssuedDetails",
      "fixed:Language",
      "fixed:clients",
      "warning:PasswordHash",
      "warning:email",
      "warning:service_id",
    ]);
    assert.equal(out.tables.adminUsers.length, 0);
    assert.deepEqual(
      out.tables.serviceStats.map((s) => [s.clients, s.transactions]),
      [[null, 3]],
    );
  });

  test("a broken audit chain is reported and imported as it stands", () => {
    const columns = [
      "timestamp",
      "audit_id",
      "actor_email",
      "actor_role",
      "action",
      "target_type",
      "target_id",
      "outcome",
      "details",
      "request_id",
      "previous_hash",
      "entry_hash",
    ];
    const out = transformExport(
      exportOf({
        Audit: [
          columns,
          [
            "2026-10-01 10:00:00",
            "AUD-1",
            "a@b.ph",
            "admin",
            "LOGIN",
            "session",
            "a@b.ph",
            "SUCCESS",
            "{}",
            "",
            "",
            "forged",
          ],
        ],
      }),
      { auditSecret: "audit" },
    );
    assert.equal(out.chain.intact, false);
    assert.equal(out.tables.auditLog.length, 1);
  });

  test("anything that is not an export is refused", () => {
    assert.throws(
      () => transformExport({ sheets: {} }),
      /Not an export from Export.gs/,
    );
  });
});
