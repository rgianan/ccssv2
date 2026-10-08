import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { fromPostgresJs } from "../db.mjs";
import { handleRequest } from "../dispatch.mjs";
import { loadImport } from "../import/load.mjs";
import { transformExport } from "../import/transform.mjs";
import { verifyImport } from "../import/verify.mjs";
import { migrate } from "../migrate.mjs";
import { PASSWORD, liveLikeSheets } from "./live-like.mjs";

/**
 * The other tests talk to PGlite directly. Production talks to Supabase
 * through postgres.js, which encodes parameters by the types the server
 * reports — and so can differ: a JSON parameter once arrived as one quoted
 * string. Here postgres.js, set up as production sets it up, reaches PGlite
 * over a real Postgres connection, and the paths that write JSON, dates and
 * lists of parameters run through it.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";

let server, sql, db, pg;
before(async () => {
  pg = await PGlite.create();
  server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await server.start();
  const { port } = server.server.address();
  sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
    prepare: false,
    max: 1,
    onnotice: () => {},
  });
  db = fromPostgresJs(sql);
  await migrate(db);
});
after(async () => {
  await sql?.end({ timeout: 1 });
  await server?.stop();
  await pg?.close();
});

describe("through postgres.js", () => {
  let exported, transformed, token;

  test("an import loads, and verifies against Apps Script", async () => {
    const { gas } = liveLikeSheets();
    exported = gas.call("buildCsmExport_()");
    transformed = transformExport(exported, { auditSecret: "audit" });
    const { loaded } = await loadImport(db, transformed.tables);
    assert.equal(loaded.responses, 64);
    const [kind] = await db.query(
      "select jsonb_typeof(coa_issued_details) as t from csm.responses where coa_issued_details is not null limit 1",
    );
    assert.equal(kind.t, "object", "the printed details arrive as an object");
    const { results } = await verifyImport({
      db,
      data: exported,
      transformed,
      auditSecret: "audit",
    });
    assert.deepEqual(
      results.filter((r) => !r.same),
      [],
    );
  });

  test("signing in, with its list parameters and audit entry", async () => {
    const reply = await handleRequest(
      { action: "adminLogin", email: "host@ched.gov.ph", password: PASSWORD },
      { db, requestContext: { clientIp: "192.0.2.1" } },
    );
    assert.equal(reply.ok, true, reply.error);
    token = reply.data.token;
    const [entry] = await db.query(
      "select action from csm.audit_log order by seq desc limit 1",
    );
    assert.equal(entry.action, "LOGIN");
  });

  test("a submission, with its dates, booleans and numbers", async () => {
    const [service] = await db.query(
      "select service_id, has_fees from csm.services where active and category = 'main' order by sort_order limit 1",
    );
    const reply = await handleRequest(
      {
        action: "submitResponse",
        payload: {
          email: "c@x.ph",
          clientType: "Citizen",
          transactionDate: "2026-09-16",
          age: "30",
          region: "National Capital Region",
          serviceId: service.service_id,
          cc1: "1",
          cc2: "1",
          cc3: "1",
          sqd0: "5",
          sqd1: "5",
          sqd2: "5",
          sqd3: "5",
          sqd4: "5",
          sqd5: service.has_fees ? "5" : "N/A",
          sqd6: "5",
          sqd7: "5",
          sqd8: "5",
          wantsCoa: "yes",
          coaName: "A",
          coaAgency: "B",
          coaPurpose: "C",
          coaDateFrom: "2026-09-15",
          submissionId: "driver-1",
          privacyNoticeVersion: "1.1",
        },
      },
      { db },
    );
    assert.equal(reply.data.status, "OK");
    const [row] = await db.query(
      `select to_char(transaction_date, 'YYYY-MM-DD') as d, to_char(coa_date_from, 'YYYY-MM-DD') as f,
              age, coa_requested from csm.responses where submission_id = 'driver-1'`,
    );
    assert.deepEqual(row, {
      d: "2026-09-16",
      f: "2026-09-15",
      age: 30,
      coa_requested: true,
    });
  });

  test("editing an issued certificate records what it printed, as an object", async () => {
    const [issued] = await db.query(
      "select reference_id from csm.responses where coa_status = 'ISSUED' and coa_issued_details is null limit 1",
    );
    const reply = await handleRequest(
      {
        action: "adminSaveCoaDetails",
        adminToken: token,
        payload: {
          referenceId: issued.reference_id,
          coaTitle: "Dr.",
          coaName: "Edited",
          coaAgency: "CHED",
          coaPurpose: "Travel",
          coaDateFrom: "2026-09-15",
        },
      },
      { db },
    );
    assert.equal(reply.ok, true, reply.error);
    const [row] = await db.query(
      "select jsonb_typeof(coa_issued_details) as t from csm.responses where reference_id = $1",
      [issued.reference_id],
    );
    assert.equal(row.t, "object");
  });

  test("issuing a certificate records what it printed, as an object", async () => {
    await db.query(
      `insert into csm.settings (key, value) values ('coa_template_id', 'TPL'), ('coa_designation', 'Director')
       on conflict (key) do update set value = excluded.value`,
    );
    const [requested] = await db.query(
      "select reference_id from csm.responses where coa_status = 'REQUESTED' and coa_date_from <= '2026-10-01' limit 1",
    );
    const worker = {
      mintCertificate: async () => ({
        fileId: "F",
        certificateUrl: "https://drive.example/F",
        shared: false,
        outputFolderId: "D",
      }),
      sendCertificateEmail: async () => "Emailed.",
    };
    const reply = await handleRequest(
      {
        action: "adminGenerateCoa",
        adminToken: token,
        responseId: requested.reference_id,
        issueKey: "k",
      },
      { db, worker },
    );
    assert.equal(reply.ok, true, reply.error);
    const [row] = await db.query(
      `select jsonb_typeof(coa_issued_details) as t, coa_issued_details->>'name' as name
       from csm.responses where reference_id = $1`,
      [requested.reference_id],
    );
    assert.equal(row.t, "object");
    assert.ok(row.name);
  });

  test("a replacing import, with the audit log's triggers off and on again", async () => {
    const { replaced } = await loadImport(db, transformed.tables, {
      replace: true,
    });
    assert.ok(replaced.responses > 64);
    await assert.rejects(db.query("delete from csm.audit_log"), /append-only/);
  });
});
