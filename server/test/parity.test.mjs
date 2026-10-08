import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { officeDay } from "../dates.mjs";
import { handleRequest } from "../dispatch.mjs";
import { RESPONSE_COLUMNS, responseRecord } from "../records.mjs";
import { appsScript } from "./apps-script.mjs";
import { SERVICES, addServices, freshDatabase, validForm } from "./fixture.mjs";

/**
 * The same requests, put to Apps Script (the real .gs files) and to the new
 * backend, must get the same answers and leave the same records behind.
 */

process.env.TZ = "UTC";

let db, gas;
before(async () => {
  db = await freshDatabase();
  await addServices(db);
  gas = appsScript({ services: SERVICES });
});

const fromGas = (action, body) =>
  gas.call(`doPost({ postData: { contents: __body } })`, {
    __body: JSON.stringify({ ...body, action, proxyToken: "t" }),
  });

// Apps Script checks the proxy's token against a stored hash; the harness has
// none, so answers come straight from the action functions.
const gasSubmit = (form) =>
  gas.call("submitResponse(__form)", { __form: form });
const pgSubmit = async (form) => {
  const reply = await handleRequest(
    { action: "submitResponse", payload: form },
    { db },
  );
  assert.equal(reply.ok, true, reply.error);
  return reply.data;
};
const pgRecord = async (referenceId) => {
  const [row] = await db.query(
    `select ${RESPONSE_COLUMNS}, privacy_notice_version from csm.responses where reference_id = $1`,
    [referenceId],
  );
  return (
    row && {
      record: responseRecord(row),
      notice: row.privacy_notice_version || "",
    }
  );
};

/** Fields drawn at random or kept only by one side. */
const comparable = (record) => {
  const copy = { ...record };
  for (const key of [
    "rowIndex",
    "referenceId",
    "timestamp",
    "verificationCode",
  ])
    delete copy[key];
  return copy;
};

const tomorrow = () => {
  const day = new Date(`${officeDay()}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

const coa = (over = {}) => ({
  wantsCoa: "yes",
  coaTitle: "Ms.",
  coaName: "Maria Santos",
  coaAgency: "CHED",
  coaPurpose: "Travel",
  coaDateFrom: "2026-09-15",
  coaDateTo: "",
  ...over,
});

const CASES = {
  "a plain response": {},
  "no age given": { age: "" },
  "an age with a leading zero": { age: "045" },
  "sex in lower case": { sex: "male" },
  "an unrecognised sex": { sex: "x" },
  "a retired region label": { region: "Region 4" },
  "a region with stray spaces and capitals": {
    region: "  CALABARZON ".replace("CALABARZON", "04 - Calabarzon"),
  },
  "an unknown region": { region: "Atlantis" },
  "no region": { region: "" },
  "a long-form date": { transactionDate: "September 1, 2026" },
  "a date that overflows its month": { transactionDate: "2026-02-31" },
  tomorrow: { transactionDate: tomorrow() },
  "last century": { transactionDate: "1999-12-31" },
  "no date": { transactionDate: "" },
  "a bad email": { email: "nobody@" },
  "a client type in the wrong case": { clientType: "business" },
  Business: { clientType: "Business" },
  "a withdrawn programme": { serviceId: "S-GONE" },
  "an unknown programme": { serviceId: "S-NOPE" },
  "Other Services, described": {
    serviceId: "S-OTHER",
    otherService: "x".repeat(250),
  },
  "Other Services, not described": { serviceId: "S-OTHER", otherService: "" },
  "a fee-free rating of fees": { sqd5: "1" },
  "a fee-charging programme, rated": { serviceId: "S-CHARGES", sqd5: "2" },
  "a fee-charging programme, unrated": { serviceId: "S-CHARGES", sqd5: "N/A" },
  "unaware of the Charter": { cc1: "4", cc2: "", cc3: "junk" },
  "CC2 out of range": { cc2: "5" },
  "an SQD left blank": { sqd8: "" },
  "every SQD N/A": Object.fromEntries(
    ["sqd0", "sqd1", "sqd2", "sqd3", "sqd4", "sqd6", "sqd7", "sqd8"].map(
      (k) => [k, "N/A"],
    ),
  ),
  "a formula-like suggestion": { suggestions: '=HYPERLINK("x")' },
  "a very long suggestion": { suggestions: "y".repeat(1600) },
  Filipino: { language: "tl" },
  "an unknown language": { language: "fr" },
  "no privacy notice version": { privacyNoticeVersion: "" },
  "a malformed privacy notice version": { privacyNoticeVersion: "1.1.1.1" },
  "a certificate request": coa(),
  "a certificate request over two days": coa({ coaDateTo: "2026-09-16" }),
  "a certificate request in capitals": coa({
    wantsCoa: "YES",
    coaTitle: "Atty. Very Long Title",
  }),
  "a certificate request missing its purpose": coa({ coaPurpose: "" }),
  "a certificate ending before it starts": coa({ coaDateTo: "2026-09-14" }),
  "a certificate for tomorrow": coa({ coaDateFrom: tomorrow() }),
  "certificate fields without a request": coa({ wantsCoa: "no" }),
  "the honeypot": { website: "http://spam" },
};

describe("submitResponse matches Apps Script", () => {
  for (const [name, over] of Object.entries(CASES))
    test(name, async () => {
      const form = validForm(over);
      const expected = gasSubmit(form);
      const actual = await pgSubmit(form);
      assert.deepEqual(
        { ...actual, referenceId: actual.referenceId && "(ref)" },
        { ...expected, referenceId: expected.referenceId && "(ref)" },
      );
      if (expected.status !== "OK" || !expected.referenceId) return;

      const kept = await pgRecord(actual.referenceId);
      assert.deepEqual(
        comparable(kept.record),
        comparable(gas.record(expected.referenceId)),
      );
      assert.equal(
        kept.notice,
        String(gas.cell(expected.referenceId, "privacy_notice_version")),
      );
      assert.equal(
        Boolean(kept.record.verificationCode),
        Boolean(gas.record(expected.referenceId).verificationCode),
      );
    });

  test("a retried form", async () => {
    const form = validForm({ submissionId: "parity-retry", ...coa() });
    const gasFirst = gasSubmit(form),
      pgFirst = await pgSubmit(form);
    const gasAgain = gasSubmit(form),
      pgAgain = await pgSubmit(form);
    assert.equal(gasAgain.referenceId, gasFirst.referenceId);
    assert.equal(pgAgain.referenceId, pgFirst.referenceId);
    assert.deepEqual(
      { ...pgAgain, referenceId: "" },
      { ...gasAgain, referenceId: "" },
    );
  });
});

describe("getPortalConfig matches Apps Script", () => {
  test("the programme list and office name", async () => {
    assert.deepEqual(
      (await handleRequest({ action: "getPortalConfig" }, { db })).data,
      gas.call("getPortalConfig()"),
    );
  });
});

describe("verifyCertificate matches Apps Script", () => {
  const issued = [
    {
      code: "OSDS-0123456789ABCDEF0001",
      status: "ISSUED",
      from: "2026-09-15",
      to: "",
      details: "",
    },
    {
      code: "OSDS-0123456789ABCDEF0002",
      status: "ISSUED",
      from: "2026-09-15",
      to: "2026-09-17",
      details: "",
    },
    {
      code: "OSDS-0123456789ABCDEF0003",
      status: "ISSUED",
      from: "2026-09-15",
      to: "2026-09-15",
      details: "",
    },
    {
      code: "OSDS-0123456789ABCDEF0004",
      status: "ISSUED",
      from: "2026-09-15",
      to: "",
      details: JSON.stringify({
        name: " Ms. Printed ",
        agency: "CHED",
        purpose: "Travel",
        dateCoverage: "on September 15, 2026",
      }),
    },
    {
      code: "OSDS-0123456789ABCDEF0005",
      status: "REQUESTED",
      from: "2026-09-15",
      to: "",
      details: "",
    },
    {
      code: "OSDS-0123456789ABCDEF0006",
      status: "DECLINED",
      from: "2026-09-15",
      to: "",
      details: "",
    },
  ];

  before(async () => {
    for (const [i, c] of issued.entries()) {
      gas.addResponse({
        ResponseID: `CSM-PARITY${i}`,
        TransactionDate: "2026-09-15",
        ClientType: "CITIZEN",
        COARequested: "YES",
        COATitle: "Ms.",
        COAName: "Maria Santos",
        COAAgency: "CHED",
        COAPurpose: "Travel",
        COADateFrom: c.from,
        COADateTo: c.to,
        COAStatus: c.status,
        COAIssuedAt: "2026-09-20 15:05",
        COAIssuedDetails: c.details,
        VerificationCode: c.code,
      });
      await db.query(
        `insert into csm.responses (reference_id, transaction_date, client_type, region, region_code,
           service_id, service_code, service_name, cc1, cc2, cc3,
           sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, email, coa_requested,
           coa_title, coa_name, coa_agency, coa_purpose, coa_date_from, coa_date_to,
           coa_status, coa_issued_at, coa_issued_details, verification_code)
         values ($1, '2026-09-15', 'CITIZEN', 'National Capital Region', 'NCR', 'S-FREE', 'SIAP 1', 'Internship',
           '1', '1', '1', '5', '5', '5', '5', '5', 'N/A', '5', '5', '5', 'c@x.ph', true,
           'Ms.', 'Maria Santos', 'CHED', 'Travel', $2, $3, $4, '2026-09-20T07:05:00Z', $5, $6)`,
        [
          `CSM-PARITY${i}`,
          c.from,
          c.to || null,
          c.status,
          c.details || null,
          c.code,
        ],
      );
    }
  });

  for (const code of [
    ...[1, 2, 3, 4, 5, 6].map((n) => `OSDS-0123456789ABCDEF000${n}`),
    "osds-0123456789abcdef0001",
    "OSDS-FFFFFFFFFFFFFFFFFFFF",
    "OSDS-123",
    "",
    "not a code",
  ])
    test(code || "(empty)", async () => {
      const actual = await handleRequest(
        { action: "verifyCertificate", code },
        { db },
      );
      assert.deepEqual(
        actual.data,
        gas.call("verifyCertificate(__code)", { __code: code }),
      );
    });
});

describe("the harness itself", () => {
  test("doPost refuses a request without the proxy's token, as deployed", () => {
    const reply = JSON.parse(fromGas("getPortalConfig", {}).text);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Backend security is not configured/);
  });
});
