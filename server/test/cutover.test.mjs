import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { handleRequest } from "../dispatch.mjs";
import { catchUpImport, loadImport } from "../import/load.mjs";
import { transformExport } from "../import/transform.mjs";
import { buildRollback } from "../rollback.mjs";
import { freshDatabase, validForm } from "./fixture.mjs";
import { PASSWORD, liveLikeSheets } from "./live-like.mjs";

/**
 * The cutover's two safety nets: the catch-up that adds what Apps Script took
 * after the final import, and the rollback file that puts back what the new
 * backend took after the switch.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";

let gas, db, token;
/** The switch, set just before the new backend takes its first request. */
let cutover;
const form = (over) =>
  validForm({ serviceId: "S-FREE", transactionDate: "2026-09-16", ...over });

before(async () => {
  ({ gas } = liveLikeSheets());
  db = await freshDatabase();
  const exported = gas.call("buildCsmExport_()");
  await loadImport(
    db,
    transformExport(exported, { auditSecret: "audit" }).tables,
  );
  const login = await handleRequest(
    { action: "adminLogin", email: "host@ched.gov.ph", password: PASSWORD },
    { db, requestContext: { clientIp: "192.0.2.1" } },
  );
  token = login.data.token;
});

const gasSubmit = (payload) =>
  gas.call("submitResponse(__f)", { __f: payload });
const pgSubmit = async (payload) =>
  (await handleRequest({ action: "submitResponse", payload }, { db })).data;
const publicRow = async (referenceId) => {
  const reply = await handleRequest(
    {
      action: "adminGetResponses",
      adminToken: token,
      filters: { query: referenceId },
    },
    { db },
  );
  return reply.data.rows.find((r) => r.referenceId === referenceId);
};
const gasRow = (referenceId) =>
  gas
    .call("adminGetResponses(__f, 't')", { __f: { query: referenceId } })
    .rows.find((r) => r.referenceId === referenceId);

describe("the catch-up", () => {
  let late, both;
  before(() => {
    late = gasSubmit(form({ submissionId: "late-1" }));
    // A browser retry that reached Apps Script and then the new backend.
    both = gasSubmit(form({ submissionId: "both-sides", sqd1: "3" }));
  });

  test("adds what Apps Script took after the import, and skips what both took", async () => {
    await pgSubmit(form({ submissionId: "both-sides", sqd1: "3" }));
    const second = transformExport(gas.call("buildCsmExport_()"), {
      auditSecret: "audit",
    });
    const dry = await catchUpImport(db, second.tables);
    assert.deepEqual(dry.added, [late.referenceId]);
    assert.deepEqual(dry.skippedAsDuplicates, [both.referenceId]);
    assert.equal(
      await publicRow(late.referenceId),
      undefined,
      "a dry run adds nothing",
    );

    const applied = await catchUpImport(db, second.tables, { apply: true });
    assert.deepEqual(applied.added, [late.referenceId]);
    assert.deepEqual(
      await publicRow(late.referenceId),
      gasRow(late.referenceId),
    );
    const again = await catchUpImport(db, second.tables, { apply: true });
    assert.deepEqual(again.added, [], "running it twice adds nothing twice");
  });
});

describe("the rollback", () => {
  let rollback, fresh, issuedRef, declinedRef;
  before(async () => {
    cutover = new Date();
    fresh = [
      await pgSubmit(form({ submissionId: "after-1" })),
      await pgSubmit(
        form({
          submissionId: "after-2",
          wantsCoa: "yes",
          coaName: "A",
          coaAgency: "B",
          coaPurpose: "C",
          coaDateFrom: "2026-09-15",
        }),
      ),
    ];
    await db.query(
      "insert into csm.settings (key, value) values ('coa_template_id', 'TPL') on conflict (key) do update set value = excluded.value",
    );
    const [requested, other] = await db.query(
      `select reference_id from csm.responses
       where coa_status = 'REQUESTED' and coa_date_from <= '2026-10-01' and submitted_at < $1
       order by seq limit 2`,
      [cutover],
    );
    issuedRef = requested.reference_id;
    declinedRef = other.reference_id;
    const worker = {
      mintCertificate: async () => ({
        fileId: "F",
        certificateUrl: "https://drive.example/F",
        shared: false,
        outputFolderId: "D",
      }),
      sendCertificateEmail: async () => "Emailed.",
    };
    const issued = await handleRequest(
      {
        action: "adminGenerateCoa",
        adminToken: token,
        responseId: issuedRef,
        issueKey: "after",
      },
      { db, worker },
    );
    assert.equal(issued.ok, true, issued.error);
    await handleRequest(
      {
        action: "adminDeclineCoa",
        adminToken: token,
        payload: { referenceId: declinedRef, reason: "No", notify: false },
      },
      { db },
    );
    rollback = await buildRollback(db, cutover.toISOString());
  });

  test("lists what the new backend took since the switch", () => {
    const refs = rollback.responses.map((r) => r.ResponseID);
    for (const reply of fresh) assert.ok(refs.includes(reply.referenceId));
    assert.deepEqual(
      rollback.certificateUpdates.map((u) => u.ResponseID),
      [issuedRef],
    );
    assert.ok(
      rollback.otherActions.some(
        (a) => a.action === "COA_DECLINE" && a.target_id === declinedRef,
      ),
      "a decline is listed for redoing by hand",
    );
    assert.ok(
      !rollback.otherActions.some((a) => a.action === "COA_GENERATE"),
      "issuance is replayed, not listed",
    );
  });

  test("Apps Script puts it back, and then reads it as the new backend did", async () => {
    const restored = gas.call("restoreRows_(JSON.parse(__d))", {
      __d: JSON.stringify(rollback),
    });
    for (const reply of fresh) {
      assert.ok(restored.added.includes(reply.referenceId));
      assert.deepEqual(
        gasRow(reply.referenceId),
        await publicRow(reply.referenceId),
      );
    }
    assert.deepEqual(restored.certificatesUpdated, [issuedRef]);
    const [code] = await db.query(
      "select verification_code from csm.responses where reference_id = $1",
      [issuedRef],
    );
    const theirs = gas.call("verifyCertificate(__c)", {
      __c: code.verification_code,
    });
    const ours = (
      await handleRequest(
        { action: "verifyCertificate", code: code.verification_code },
        { db },
      )
    ).data;
    assert.equal(theirs.valid, true);
    assert.deepEqual(theirs, ours);

    const again = gas.call("restoreRows_(JSON.parse(__d))", {
      __d: JSON.stringify(rollback),
    });
    assert.deepEqual(again.added, [], "running it twice adds nothing twice");
  });
});
