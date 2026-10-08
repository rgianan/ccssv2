import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  getPortalConfig,
  submitResponse,
  verifyCertificate,
} from "../actions/public.mjs";
import { handleRequest } from "../dispatch.mjs";
import { RESPONSE_COLUMNS, responseRecord } from "../records.mjs";
import { DEFAULT_SERVICES, seed } from "../seed.mjs";
import { NOW, addServices, freshDatabase, validForm } from "./fixture.mjs";

// Vercel's zone. Nothing in the backend may lean on it.
process.env.TZ = "UTC";

let db;
before(async () => {
  db = await freshDatabase();
  await addServices(db);
});

const submit = (form, now = NOW) => submitResponse({ db, now }, form);
const stored = async (referenceId) => {
  const [row] = await db.query(
    `select ${RESPONSE_COLUMNS}, submission_id, age as age_number,
            privacy_notice_version, privacy_notice_presented_at
     from csm.responses where reference_id = $1`,
    [referenceId],
  );
  return row;
};
const count = async () =>
  (await db.query("select count(*)::int as n from csm.responses"))[0].n;

describe("getPortalConfig", () => {
  test("lists active programmes in order, with the default office name", async () => {
    const config = await getPortalConfig({ db });
    assert.equal(
      config.officeName,
      "Office of Student Development and Services (OSDS)",
    );
    assert.deepEqual(
      config.services.map((s) => s.service_id),
      ["S-CHARGES", "S-FREE", "S-OTHER"],
    );
    assert.deepEqual(config.services[0], {
      service_id: "S-CHARGES",
      code: "CEM/CED",
      name_en: "Certification",
      name_tl: "",
      category: "main",
      active: true,
      has_fees: true,
    });
  });

  test("uses the office name from Settings once it is set", async () => {
    await db.query(
      "insert into csm.settings (key, value) values ('office_name', '  OSDS Main  ')",
    );
    assert.equal((await getPortalConfig({ db })).officeName, "OSDS Main");
    await db.query("delete from csm.settings where key = 'office_name'");
  });
});

describe("submitResponse", () => {
  test("stores a valid response and returns its reference", async () => {
    const reply = await submit(
      validForm({ submissionId: "form-1", age: "", suggestions: "  Thanks  " }),
    );
    assert.equal(reply.status, "OK");
    assert.match(reply.referenceId, /^CSM-[0-9A-F]{10}$/);
    assert.equal(reply.coaRequested, false);

    const row = await stored(reply.referenceId);
    const record = responseRecord(row);
    assert.equal(record.transactionDate, "2026-09-16");
    assert.equal(record.month, "SEPTEMBER");
    assert.equal(record.year, 2026);
    assert.equal(record.clientType, "CITIZEN");
    assert.equal(record.sex, "FEMALE");
    assert.equal(record.age, "N/A");
    assert.equal(row.age_number, null);
    assert.equal(record.regionCode, "NCR");
    assert.equal(record.serviceCode, "SIAP 1");
    assert.equal(record.suggestions, "Thanks");
    assert.equal(record.coaStatus, "NONE");
    assert.equal(record.verificationCode, "");
    assert.equal(row.submission_id, "form-1");
    assert.equal(row.privacy_notice_version, "1.1");
    assert.equal(
      new Date(row.privacy_notice_presented_at).getTime(),
      NOW.getTime(),
    );
    assert.equal(record.overall, (5 + 5 + 4 + 5 + 5 + 5 + 3 + 5) / 8);
  });

  test("a retried form is stored once and answered with the first reference", async () => {
    const before = await count();
    const first = await submit(validForm({ submissionId: "form-retry" }));
    const again = await submit(validForm({ submissionId: "form-retry" }));
    assert.equal(again.referenceId, first.referenceId);
    assert.equal(again.duplicate, true);
    assert.equal(await count(), before + 1);
  });

  test("retries arriving together are still stored once", async () => {
    const before = await count();
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        submit(
          validForm({
            submissionId: "form-burst",
            wantsCoa: "yes",
            coaName: "A",
            coaAgency: "B",
            coaPurpose: "C",
            coaDateFrom: "2026-09-16",
          }),
        ),
      ),
    );
    assert.equal(new Set(replies.map((r) => r.referenceId)).size, 1);
    assert.ok(replies.every((r) => r.coaRequested === true));
    assert.equal(await count(), before + 1);
  });

  test("forms without a submission id are never merged", async () => {
    const before = await count();
    await submit(validForm());
    await submit(validForm());
    assert.equal(await count(), before + 2);
  });

  test("the honeypot is answered as a success and stores nothing", async () => {
    const before = await count();
    assert.deepEqual(await submit(validForm({ website: "spam" })), {
      status: "OK",
      referenceId: "",
      coaRequested: false,
    });
    assert.equal(await count(), before);
  });

  test("today means today in Manila, not in the server's zone", async () => {
    // 01:30 on October 8 in Manila; still October 7 in UTC.
    const earlyMorning = new Date("2026-10-07T17:30:00Z");
    assert.equal(
      (await submit(validForm({ transactionDate: "2026-10-08" }), earlyMorning))
        .status,
      "OK",
    );
    const tomorrow = await submit(
      validForm({ transactionDate: "2026-10-09" }),
      earlyMorning,
    );
    assert.equal(
      tomorrow.message,
      "The transaction date cannot be in the future.",
    );
  });

  test("SQD5 is N/A for a fee-free programme and required where fees are charged", async () => {
    const free = await submit(validForm({ sqd5: "2" }));
    assert.equal((await stored(free.referenceId)).sqd5, "N/A");
    const missing = await submit(
      validForm({ serviceId: "S-CHARGES", sqd5: "N/A" }),
    );
    assert.deepEqual(missing, {
      status: "BAD_REQUEST",
      code: "SQD5_REQUIRED",
      message: "Please rate the fees you paid for this transaction.",
    });
    const rated = await submit(
      validForm({ serviceId: "S-CHARGES", sqd5: "3" }),
    );
    assert.equal((await stored(rated.referenceId)).sqd5, "3");
  });

  test("a client unaware of the Charter has CC2 and CC3 recorded as N/A", async () => {
    const reply = await submit(validForm({ cc1: "4", cc2: "9", cc3: "" }));
    const row = await stored(reply.referenceId);
    assert.deepEqual([row.cc1, row.cc2, row.cc3], ["4", "N/A", "N/A"]);
  });

  test("a certificate request gets a verification code", async () => {
    const reply = await submit(
      validForm({
        wantsCoa: "YES",
        coaTitle: "Engr. Longer Than Twelve",
        coaName: "Juan Dela Cruz",
        coaAgency: "CHED",
        coaPurpose: "Travel",
        coaDateFrom: "2026-09-15",
        coaDateTo: "2026-09-16",
      }),
    );
    assert.equal(reply.coaRequested, true);
    const record = responseRecord(await stored(reply.referenceId));
    assert.match(record.verificationCode, /^OSDS-[0-9A-F]{20}$/);
    assert.equal(record.coaStatus, "REQUESTED");
    assert.equal(record.coaTitle, "Engr. Longer");
    assert.equal(record.coaDateFrom, "2026-09-15");
    assert.equal(record.coaDateTo, "2026-09-16");
  });

  test("a reference that repeats an existing one is drawn again", async () => {
    let failedOnce = false;
    const flaky = {
      ...db,
      query: async (text, params) => {
        if (!failedOnce && /insert into csm\.responses/.test(text)) {
          failedOnce = true;
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "responses_pkey",
          });
        }
        return db.query(text, params);
      },
    };
    const reply = await submitResponse({ db: flaky, now: NOW }, validForm());
    assert.equal(failedOnce, true);
    assert.equal(reply.status, "OK");
    assert.ok(await stored(reply.referenceId));
  });

  const refusals = [
    [{ email: "not-an-email" }, "A valid email address is required."],
    [
      { email: `${"a".repeat(250)}@x.ph` },
      "A valid email address is required.",
    ],
    [{ clientType: "citizen" }, "Please select a valid client type."],
    [{ transactionDate: "" }, "A valid transaction date is required."],
    [{ transactionDate: "someday" }, "A valid transaction date is required."],
    [
      { transactionDate: "1999-12-31" },
      "Please check the year of the transaction date.",
    ],
    [{ region: "" }, "Region of residence is required."],
    [
      { region: "Atlantis" },
      "Please choose your region of residence from the list.",
    ],
    [
      { region: "constructor" },
      "Please choose your region of residence from the list.",
    ],
    [
      { serviceId: "S-GONE" },
      "The service you chose is no longer offered. Please choose again from the list.",
    ],
    [{ sex: "other" }, "Please choose a valid option for sex."],
    [
      { serviceId: "S-OTHER", otherService: " " },
      "Please specify the service you availed.",
    ],
    [{ age: "0" }, "Age must be between 1 and 120."],
    [{ age: "121" }, "Age must be between 1 and 120."],
    [{ age: "3.5" }, "Age must be between 1 and 120."],
    [{ cc2: "5" }, "Please answer all Citizen’s Charter questions."],
    [{ cc3: "4" }, "Please answer all Citizen’s Charter questions."],
    [{ sqd3: "" }, "Please answer all Service Quality Dimension questions."],
    [
      {
        wantsCoa: "yes",
        coaName: "A",
        coaAgency: "B",
        coaPurpose: "",
        coaDateFrom: "2026-09-16",
      },
      "Complete the Certificate of Appearance details.",
    ],
    [
      {
        wantsCoa: "yes",
        coaName: "A",
        coaAgency: "B",
        coaPurpose: "C",
        coaDateFrom: "2026-09-16",
        coaDateTo: "2026-09-15",
      },
      "The end date of your appearance cannot be earlier than its start.",
    ],
    [
      {
        wantsCoa: "yes",
        coaName: "A",
        coaAgency: "B",
        coaPurpose: "C",
        coaDateFrom: "2026-10-09",
      },
      "The date of appearance cannot be in the future.",
    ],
  ];
  for (const [over, message] of refusals)
    test(`refuses ${JSON.stringify(over).slice(0, 70)}`, async () => {
      const before = await count();
      const reply = await submit(validForm(over));
      assert.equal(reply.status, "BAD_REQUEST");
      assert.equal(reply.message, message);
      assert.equal(await count(), before);
    });

  test("a withdrawn programme is refused with the code that refreshes the list", async () => {
    assert.equal(
      (await submit(validForm({ serviceId: "S-GONE" }))).code,
      "SERVICE_UNAVAILABLE",
    );
  });
});

describe("verifyCertificate", () => {
  const issue = async (code, over = {}) => {
    const values = {
      reference_id: `CSM-${code.slice(-10)}`,
      verification_code: code,
      coa_status: "ISSUED",
      coa_title: "Ms.",
      coa_name: "Maria Santos",
      coa_agency: "CHED",
      coa_purpose: "Travel",
      coa_date_from: "2026-09-15",
      coa_date_to: null,
      coa_issued_at: "2026-09-20T07:05:00Z",
      coa_issued_details: null,
      ...over,
    };
    await db.query(
      `insert into csm.responses (reference_id, transaction_date, client_type, region, region_code,
         service_id, service_code, service_name, cc1, cc2, cc3,
         sqd0, sqd1, sqd2, sqd3, sqd4, sqd5, sqd6, sqd7, sqd8, email, coa_requested,
         verification_code, coa_status, coa_title, coa_name, coa_agency, coa_purpose,
         coa_date_from, coa_date_to, coa_issued_at, coa_issued_details)
       values ($1, '2026-09-15', 'CITIZEN', 'National Capital Region', 'NCR', 'S-FREE', 'SIAP 1', 'Internship',
         '1', '1', '1', '5', '5', '5', '5', '5', 'N/A', '5', '5', '5', 'c@x.ph', true,
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        values.reference_id,
        values.verification_code,
        values.coa_status,
        values.coa_title,
        values.coa_name,
        values.coa_agency,
        values.coa_purpose,
        values.coa_date_from,
        values.coa_date_to,
        values.coa_issued_at,
        values.coa_issued_details,
      ],
    );
  };

  test("an issued certificate shows its details and the Manila issue time", async () => {
    await issue("OSDS-AAAAAAAAAAAAAAAAAAA1");
    assert.deepEqual(
      await verifyCertificate({ db }, "osds-aaaaaaaaaaaaaaaaaaa1"),
      {
        valid: true,
        verificationCode: "OSDS-AAAAAAAAAAAAAAAAAAA1",
        name: "Ms. Maria Santos",
        agency: "CHED",
        purpose: "Travel",
        dateCoverage: "on September 15, 2026",
        issuedAt: "2026-09-20 15:05",
      },
    );
  });

  test("it shows what was printed, not what the row says now", async () => {
    await issue("OSDS-AAAAAAAAAAAAAAAAAAA2", {
      coa_name: "Edited Later",
      coa_date_to: "2026-09-17",
      coa_issued_details: JSON.stringify({
        name: "Ms. As Printed",
        agency: " CHED ",
        purpose: "Travel",
        dateCoverage: "from September 15, 2026 to September 16, 2026",
      }),
    });
    const shown = await verifyCertificate({ db }, "OSDS-AAAAAAAAAAAAAAAAAAA2");
    assert.equal(shown.name, "Ms. As Printed");
    assert.equal(shown.agency, "CHED");
    assert.equal(
      shown.dateCoverage,
      "from September 15, 2026 to September 16, 2026",
    );
  });

  test("anything else is simply not valid", async () => {
    await issue("OSDS-AAAAAAAAAAAAAAAAAAA3", { coa_status: "REQUESTED" });
    for (const code of [
      "",
      "OSDS-123",
      "OSDS-AAAAAAAAAAAAAAAAAAA3",
      "OSDS-BBBBBBBBBBBBBBBBBBBB",
      "x'; drop table csm.responses; --",
    ])
      assert.deepEqual(await verifyCertificate({ db }, code), { valid: false });
  });
});

describe("handleRequest", () => {
  test("answers in the {ok, data} shape with a timing record", async () => {
    const reply = await handleRequest(
      { action: "verifyCertificate", code: "OSDS-123" },
      { db },
    );
    assert.deepEqual(reply.data, { valid: false });
    assert.equal(reply.ok, true);
    assert.equal(reply.perf.queries, 0);
    const config = await handleRequest({ action: "getPortalConfig" }, { db });
    assert.equal(config.perf.queries, 2);
  });

  test("names unknown actions, the worker's included", async () => {
    assert.equal(
      (await handleRequest({ action: "workerMintCertificate" }, { db })).error,
      "Unknown action: workerMintCertificate",
    );
    assert.equal(
      (await handleRequest({ action: "toString" }, { db })).error,
      "Unknown action: toString",
    );
  });

  test("a database failure is reported as temporary, without its detail", async () => {
    const broken = {
      query: async () => {
        throw new Error('relation "csm.services" does not exist');
      },
    };
    const original = console.error;
    console.error = () => {};
    try {
      const reply = await handleRequest(
        { action: "getPortalConfig" },
        { db: broken },
      );
      assert.equal(reply.ok, false);
      assert.equal(
        reply.error,
        "The database is temporarily unavailable. Please try again in a moment.",
      );
    } finally {
      console.error = original;
    }
  });
});

describe("seed", () => {
  test("adds the default programmes and settings once", async () => {
    const empty = await freshDatabase();
    const first = await seed(empty);
    assert.deepEqual(
      first.services,
      DEFAULT_SERVICES.map((s) => s.code),
    );
    assert.equal((await seed(empty)).services.length, 0);
    const config = await getPortalConfig({ db: empty });
    assert.equal(config.services.length, 5);
    assert.equal(config.services[0].has_fees, true);
    await empty.end();
  });
});
