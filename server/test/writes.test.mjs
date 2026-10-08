import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { handleRequest } from "../dispatch.mjs";
import { appsScript } from "./apps-script.mjs";
import { ADMIN, buildDataset, loadIntoDb, loadIntoGas } from "./dataset.mjs";
import { SERVICES, addServices, freshDatabase } from "./fixture.mjs";

/**
 * The same admin writes, in the same order, put through Apps Script's doPost
 * (the real .gs files) and the new backend. After each one the reply must
 * match, the screens must read the same data back, and at the end both audit
 * logs must hold the same entries.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";

const STAFF = "staff@ched.gov.ph";
let db, gas, data, auditStart;
const tokens = {};
/** Stands in for the phase 2 worker, which sends through MailApp. */
const emailed = [];
const worker = {
  async sendDeclineEmail({ record, reason, settings }) {
    emailed.push({ to: record.email, reason, office: settings.office_name });
    return "The client was emailed the reason.";
  },
};
/** Ids each side made up for the same new record: Apps Script's -> ours. */
const sameIds = new Map();

before(async () => {
  data = buildDataset();
  db = await freshDatabase();
  await addServices(db);
  await loadIntoDb(db, data);
  gas = appsScript({ services: SERVICES });
  loadIntoGas(gas, data);
  gas.props.SUBMIT_SHARED_TOKEN_HASH = gas.call("sha256Base64_('proxy-token')");
  for (const [role, email] of [
    ["superadmin", ADMIN.email],
    ["admin", STAFF],
  ]) {
    const login = await handleRequest(
      { action: "adminLogin", email, password: ADMIN.password },
      { db, requestContext: { clientIp: `192.0.2.${role.length}` } },
    );
    assert.equal(login.ok, true, login.error);
    tokens[role] = login.data.token;
  }
  auditStart = await lastAuditSeq();
});

const lastAuditSeq = async () =>
  (
    await db.query("select coalesce(max(seq), 0)::int as s from csm.audit_log")
  )[0].s;

/** Audit entries made by checks that run against the new backend alone. */
const ourOnly = [];
async function oursAlone(work) {
  const from = await lastAuditSeq();
  await work();
  ourOnly.push([from, await lastAuditSeq()]);
}

/** Apps Script signed in as `role`, the way requireAdmin_ would find it. */
function gasAs(role) {
  const email = role === "superadmin" ? ADMIN.email : STAFF;
  gas.call(`
    requireAdmin_ = function () { return { email: '${email}', role: '${role}' }; };
    requireSuperadmin_ = function (t) {
      var s = requireAdmin_(t);
      if (String(s.role).toLowerCase() !== 'superadmin')
        throw new Error('Forbidden: superadmin access required.');
      return s;
    };
    // Each request is a fresh execution there.
    RECLASSIFY_AUDIT_ = {}; ADMIN_SESSION_MEMO_ = {}; ENSURED_SHEETS_ = {};`);
}

/** Our output with the ids we made up swapped for Apps Script's. */
function aligned(value) {
  let text = JSON.stringify(value);
  for (const [gasId, pgId] of sameIds) text = text.replaceAll(pgId, gasId);
  return JSON.parse(text);
}

async function write(body, { role = "superadmin" } = {}) {
  gasAs(role);
  const expected = JSON.parse(
    gas.call("doPost({ postData: { contents: __c } }).text", {
      __c: JSON.stringify({
        ...body,
        proxyToken: "proxy-token",
        adminToken: "x",
      }),
    }),
  );
  const actual = await handleRequest(
    { ...body, adminToken: tokens[role] },
    { db, worker },
  );
  delete expected.perf;
  delete actual.perf;
  return { actual: aligned(actual), expected };
}

const same = async (body, options) => {
  const { actual, expected } = await write(body, options);
  assert.deepEqual(actual, expected);
  return actual;
};

const READS = {
  adminGetServices: () => "adminGetServices('t')",
  adminGetSettings: () => "adminGetSettings('t')",
  adminGetServiceStats: () => "adminGetServiceStats(__a, 't')",
  adminGetResponses: () => "adminGetResponses(__a, 't')",
  adminGetCoaRequests: () => "adminGetCoaRequests(__a, 't')",
  adminGetUsers: () => "adminGetUsers('t')",
};
const argument = {
  adminGetServiceStats: "period",
  adminGetResponses: "filters",
  adminGetCoaRequests: "filters",
};

/** A screen reads the same thing back from both. */
async function sameRead(action, args = {}, adjust = (x) => x) {
  gasAs("superadmin");
  const expected = gas.call(READS[action](), { __a: args });
  const reply = await handleRequest(
    { action, adminToken: tokens.superadmin, [argument[action]]: args },
    { db },
  );
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(adjust(aligned(reply.data)), adjust(expected));
}

const pick = (predicate, what) => {
  const found = data && data.responses.find(predicate);
  assert.ok(found, `the dataset has ${what}`);
  return found.referenceId;
};

describe("programs", () => {
  test("a new program with a chosen id", () =>
    same({
      action: "adminSaveService",
      payload: {
        service_id: "S-NEW1",
        code: " new prog ",
        name_en: " New Program ",
        name_tl: "Bago",
        category: "Main",
        active: true,
        has_fees: true,
        sort_order: "",
      },
    }));

  test("an edit that leaves the fees flag out keeps it", () =>
    same({
      action: "adminSaveService",
      payload: {
        service_id: "S-NEW1",
        code: "NEW PROG",
        name_en: "Renamed",
        category: "other",
        sort_order: "15",
      },
    }));

  test("a new program with no id gets one", async () => {
    const { actual, expected } = await write({
      action: "adminSaveService",
      payload: {
        code: "fresh",
        name_en: "Fresh",
        sort_order: "abc",
        active: "false",
      },
    });
    assert.match(actual.data.service_id, /^S-[0-9A-F]{8}$/);
    sameIds.set(expected.data.service_id, actual.data.service_id);
    assert.deepEqual(aligned(actual), expected);
  });

  for (const [name, payload] of [
    [
      "a code another program uses",
      { service_id: "S-NEW1", code: "SIAP 1", name_en: "x" },
    ],
    ["no code", { code: " ", name_en: "x" }],
    ["a code too long", { code: "X".repeat(25), name_en: "x" }],
    ["no English name", { code: "OK", name_en: "" }],
  ])
    test(`refuses ${name}`, async () => {
      const reply = await same({ action: "adminSaveService", payload });
      assert.equal(reply.ok, false);
    });

  test("the Programs list reads back the same", () =>
    // The sheet's row number, which no screen reads, has no counterpart here.
    sameRead("adminGetServices", {}, (list) =>
      list.map(({ rowIndex, ...service }) => service),
    ));
});

describe("settings", () => {
  test("a superadmin saves, trimmed and capped, unknown keys ignored", () =>
    same({
      action: "adminSaveSettings",
      settings: {
        office_name: "  OSDS  ",
        coa_signatory: "Dr. New",
        report_prepared_by: "y".repeat(400),
        unknown_key: "x",
      },
    }));

  test("an admin may resend the signatory unchanged", () =>
    same(
      {
        action: "adminSaveSettings",
        settings: { office_name: "OSDS Main", coa_signatory: "Dr. New" },
      },
      { role: "admin" },
    ));

  test("but not change it", async () => {
    const reply = await same(
      {
        action: "adminSaveSettings",
        settings: { coa_signatory: "Someone Else" },
      },
      { role: "admin" },
    );
    assert.match(reply.error, /Only a superadmin/);
  });

  test("Settings reads back the same", () => sameRead("adminGetSettings"));
});

describe("report statistics", () => {
  const period = { type: "quarter", year: 2026, quarter: 3 };
  test("saves figures and blanks", () =>
    same({
      action: "adminSaveServiceStats",
      period,
      rows: [
        {
          service_id: "S-CHARGES",
          clients: "40",
          transactions: " 55 ",
          remarks: " updated ",
        },
        {
          service_id: "S-OTHER",
          clients: "",
          transactions: "",
          remarks: "none",
        },
        { service_id: "", clients: "1" },
      ],
    }));

  for (const [name, rows] of [
    [
      "a negative count",
      [{ service_id: "S-FREE", code: "SIAP 1", clients: "-1" }],
    ],
    ["a fraction", [{ service_id: "S-FREE", transactions: "1.5" }]],
    ["rows that are not a list", { a: 1 }],
  ])
    test(`refuses ${name}`, async () => {
      const reply = await same({
        action: "adminSaveServiceStats",
        period,
        rows,
      });
      assert.equal(reply.ok, false);
    });

  test("the statistics read back the same", () =>
    sameRead("adminGetServiceStats", period));
});

describe("users", () => {
  const nowish = (users) =>
    users.map((u) => ({
      ...u,
      // Both stamp the time of the save; only its day is compared.
      created_at: String(u.created_at).slice(0, 10),
      updated_at: String(u.updated_at).slice(0, 10),
    }));

  test("a new user", async () => {
    const { actual, expected } = await write({
      action: "adminSaveUser",
      payload: {
        email: " New@CHED.gov.ph ",
        name: "New Person",
        role: "Admin",
        active: true,
        password: "long enough password",
      },
    });
    assert.match(actual.data.user_id, /^U-[0-9a-f]{8}$/);
    sameIds.set(expected.data.user_id, actual.data.user_id);
    const [one, other] = [aligned(actual), expected].map((r) => ({
      ...r,
      data: nowish([r.data])[0],
    }));
    assert.deepEqual(one, other);
  });

  test("a change without a new password", async () => {
    const { actual, expected } = await write({
      action: "adminSaveUser",
      payload: {
        user_id: "U-staff",
        email: STAFF,
        name: "Staff Renamed",
        role: "admin",
        active: true,
      },
    });
    assert.deepEqual(
      { ...actual, data: nowish([actual.data])[0] },
      { ...expected, data: nowish([expected.data])[0] },
    );
  });

  for (const [name, payload] of [
    [
      "no name",
      { email: "a@b.ph", role: "admin", password: "long enough password" },
    ],
    [
      "a bad email",
      {
        email: "nope",
        name: "N",
        role: "admin",
        password: "long enough password",
      },
    ],
    [
      "an unknown role",
      {
        email: "a@b.ph",
        name: "N",
        role: "owner",
        password: "long enough password",
      },
    ],
    ["demoting yourself", { email: ADMIN.email, name: "Host", role: "admin" }],
    [
      "deactivating yourself",
      { email: ADMIN.email, name: "Host", role: "superadmin", active: false },
    ],
    [
      "a new user without a password",
      { email: "b@c.ph", name: "N", role: "admin" },
    ],
    [
      "a short password",
      { email: STAFF, name: "Staff", role: "admin", password: "short" },
    ],
  ])
    test(`refuses ${name}`, async () => {
      const reply = await same({ action: "adminSaveUser", payload });
      assert.equal(reply.ok, false);
    });

  test("an admin may not manage users", async () => {
    const reply = await same(
      {
        action: "adminSaveUser",
        payload: {
          email: "c@d.ph",
          name: "N",
          role: "admin",
          password: "long enough password",
        },
      },
      { role: "admin" },
    );
    assert.equal(reply.error, "Forbidden: superadmin access required.");
  });

  test("Users reads back the same", () =>
    sameRead("adminGetUsers", {}, nowish));

  test("the new password works here, and a changed one ends old sessions", () =>
    oursAlone(async () => {
      const signIn = (password) =>
        handleRequest(
          { action: "adminLogin", email: "new@ched.gov.ph", password },
          { db, requestContext: { clientIp: "192.0.2.77" } },
        );
      const first = await signIn("long enough password");
      assert.equal(first.ok, true, first.error);
      await handleRequest(
        {
          action: "adminSaveUser",
          adminToken: tokens.superadmin,
          payload: {
            email: "new@ched.gov.ph",
            name: "New Person",
            role: "admin",
            password: "another long password",
          },
        },
        { db },
      );
      const old = await handleRequest(
        { action: "adminValidateSession", adminToken: first.data.token },
        { db },
      );
      assert.equal(old.error, "Your admin session has expired.");
      assert.equal((await signIn("another long password")).ok, true);
    }));

  test("a superadmin changing their own password stays signed in", () =>
    oursAlone(async () => {
      const reply = await handleRequest(
        {
          action: "adminSaveUser",
          adminToken: tokens.superadmin,
          payload: {
            email: ADMIN.email,
            name: "Portal Host",
            role: "superadmin",
            password: ADMIN.password,
          },
        },
        { db },
      );
      assert.equal(reply.ok, true, reply.error);
      const still = await handleRequest(
        { action: "adminValidateSession", adminToken: tokens.superadmin },
        { db },
      );
      assert.equal(still.ok, true, still.error);
    }));
});

describe("the program a response counts under", () => {
  let moved;
  before(() => {
    moved = pick((r) => r.serviceId === "S-FREE", "a SIAP 1 response");
  });

  test("moves to Other services, described", () =>
    same(
      {
        action: "adminChangeResponseService",
        payload: {
          referenceId: moved,
          serviceId: "S-OTHER",
          otherService: " Walk-in ",
        },
      },
      { role: "admin" },
    ));
  test("the same move again changes nothing", () =>
    same(
      {
        action: "adminChangeResponseService",
        payload: {
          referenceId: moved.toLowerCase(),
          serviceId: "S-OTHER",
          otherService: "Walk-in",
        },
      },
      { role: "admin" },
    ));
  test("to a withdrawn program", () =>
    same(
      {
        action: "adminChangeResponseService",
        payload: { referenceId: moved, serviceId: "S-GONE" },
      },
      { role: "admin" },
    ));

  for (const [name, payload] of [
    [
      "Other services undescribed",
      () => ({ referenceId: moved, serviceId: "S-OTHER" }),
    ],
    ["an unknown program", () => ({ referenceId: moved, serviceId: "S-NOPE" })],
    [
      "an unknown response",
      () => ({ referenceId: "CSM-NOPE", serviceId: "S-FREE" }),
    ],
    ["no response", () => ({ serviceId: "S-FREE" })],
    ["no program", () => ({ referenceId: moved })],
  ])
    test(`refuses ${name}`, async () => {
      const reply = await same(
        { action: "adminChangeResponseService", payload: payload() },
        { role: "admin" },
      );
      assert.equal(reply.ok, false);
    });

  test("Responses reads back the same", () =>
    sameRead("adminGetResponses", {}));
});

describe("certificate requests", () => {
  let requested, issuedPlain, issuedRecorded, declined, noCertificate;
  before(() => {
    requested = pick((r) => r.coaStatus === "REQUESTED", "a pending request");
    issuedPlain = pick(
      (r) => r.coaStatus === "ISSUED" && !r.coaIssuedDetails,
      "an issued certificate with no record of what it printed",
    );
    issuedRecorded = pick(
      (r) => r.coaStatus === "ISSUED" && r.coaIssuedDetails,
      "an issued certificate with that record",
    );
    declined = pick((r) => r.coaStatus === "DECLINED", "a declined request");
    noCertificate = pick((r) => !r.coaRequested, "a response with no request");
  });
  const details = (referenceId, over = {}) => ({
    referenceId,
    coaTitle: "Engr.",
    coaName: " Juan Dela Cruz ",
    coaAgency: "CHED",
    coaPurpose: "Travel",
    coaDateFrom: "2026-09-15",
    coaDateTo: "2026-09-16",
    ...over,
  });

  test("edits a pending request", () =>
    same(
      { action: "adminSaveCoaDetails", payload: details(requested) },
      { role: "admin" },
    ));
  test("edits an issued one, recording what it printed first", () =>
    same(
      { action: "adminSaveCoaDetails", payload: details(issuedPlain) },
      { role: "admin" },
    ));
  test("edits an issued one back to what it printed", () =>
    same(
      {
        action: "adminSaveCoaDetails",
        payload: details(issuedRecorded, {
          coaTitle: "Ms.",
          coaName: "Printed Name",
          coaDateFrom: "2026-10-01",
          coaDateTo: "",
        }),
      },
      { role: "admin" },
    ));

  for (const [name, payload] of [
    ["no purpose", () => details(requested, { coaPurpose: "" })],
    [
      "an end before the start",
      () => details(requested, { coaDateTo: "2026-09-01" }),
    ],
    [
      "a start in the future",
      () => details(requested, { coaDateFrom: "2099-01-01", coaDateTo: "" }),
    ],
    ["an unknown response", () => details("CSM-NOPE")],
  ])
    test(`refuses ${name}`, async () => {
      const reply = await same(
        { action: "adminSaveCoaDetails", payload: payload() },
        { role: "admin" },
      );
      assert.equal(reply.ok, false);
    });

  test("declines and tells the client", async () => {
    await same(
      {
        action: "adminDeclineCoa",
        payload: { referenceId: requested, reason: " Not our transaction " },
      },
      { role: "admin" },
    );
    assert.equal(gas.mail.at(-1).to, emailed.at(-1).to);
    assert.equal(emailed.at(-1).reason, "Not our transaction");
  });
  test("declining again changes nothing and sends nothing", async () => {
    const before = emailed.length;
    await same(
      {
        action: "adminDeclineCoa",
        payload: { referenceId: requested, reason: "Again" },
      },
      { role: "admin" },
    );
    assert.equal(emailed.length, before);
  });
  test("declines without telling, when asked not to", () =>
    same(
      {
        action: "adminDeclineCoa",
        payload: { referenceId: declined, reason: "x", notify: false },
      },
      { role: "admin" },
    ));

  for (const [name, payload] of [
    [
      "an issued certificate",
      () => ({ referenceId: issuedPlain, reason: "x" }),
    ],
    [
      "a response with no request",
      () => ({ referenceId: noCertificate, reason: "x" }),
    ],
    ["no reason", () => ({ referenceId: requested, reason: " " })],
    ["no response", () => ({ reason: "x" })],
  ])
    test(`will not decline ${name}`, async () => {
      const reply = await same(
        { action: "adminDeclineCoa", payload: payload() },
        { role: "admin" },
      );
      assert.equal(reply.ok, false);
    });

  test("reopens a declined request", () =>
    same(
      { action: "adminReopenCoa", payload: { referenceId: requested } },
      { role: "admin" },
    ));
  test("will not reopen one that is not declined", async () => {
    const reply = await same(
      { action: "adminReopenCoa", payload: { referenceId: requested } },
      { role: "admin" },
    );
    assert.equal(reply.ok, false);
  });

  test("the certificate list reads back the same", () =>
    sameRead("adminGetCoaRequests", {}));
  test("and so does verification of the one edited after release", async () => {
    const code = data.responses.find(
      (r) => r.referenceId === issuedPlain,
    ).verificationCode;
    const reply = await handleRequest(
      { action: "verifyCertificate", code },
      { db },
    );
    assert.deepEqual(
      reply.data,
      gas.call("verifyCertificate(__c)", { __c: code }),
    );
    assert.notEqual(
      reply.data.name,
      "Engr. Juan Dela Cruz",
      "it still shows what was printed",
    );
  });
});

describe("the audit log", () => {
  test("holds the same entries for every write, in order", async () => {
    const fields = ["action", "target_type", "target_id", "outcome", "details"];
    const ours = (
      await db.query(
        `select seq, ${fields.join(", ")} from csm.audit_log
         where seq > $1 order by seq`,
        [auditStart],
      )
    )
      .filter(
        ({ seq }) => !ourOnly.some(([from, to]) => seq > from && seq <= to),
      )
      .map(({ seq, ...entry }) => entry);
    const header = gas.sheets.Audit.data[0];
    const theirs = gas.sheets.Audit.data
      .slice(1)
      .map((row) =>
        Object.fromEntries(
          fields.map((f) => [f, String(row[header.indexOf(f)])]),
        ),
      );
    assert.equal(theirs.length > 40, true);
    assert.deepEqual(aligned(ours), theirs);
  });
});

describe("where the new backend differs on purpose", () => {
  const as = (action, args) =>
    handleRequest({ action, adminToken: tokens.superadmin, ...args }, { db });

  test("a decline while the email worker is not connected still records it", async () => {
    const referenceId = data.responses.find(
      (r) => r.coaStatus === "PROCESSING",
    ).referenceId;
    const reply = await as("adminDeclineCoa", {
      payload: { referenceId, reason: "Duplicate request" },
    });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(
      reply.data.emailStatus,
      "Declined, but the client could not be emailed (the email service is not connected yet). Tell them another way.",
    );
    const [row] = await db.query(
      "select coa_status from csm.responses where reference_id = $1",
      [referenceId],
    );
    assert.equal(row.coa_status, "DECLINED");
  });

  test("a settings payload that is not an object is refused by name", async () => {
    // Apps Script failed with "Cannot use 'in' operator…".
    assert.equal(
      (await as("adminSaveSettings", { settings: "office_name" })).error,
      "Invalid settings payload.",
    );
  });

  test("figures for a program that does not exist are refused, not stored", async () => {
    // Apps Script stored them against any id it was sent.
    const reply = await as("adminSaveServiceStats", {
      period: { type: "quarter", year: 2026, quarter: 3 },
      rows: [{ service_id: "S-NOPE", clients: "1" }],
    });
    assert.equal(reply.error, "Unknown program: S-NOPE.");
  });
});
