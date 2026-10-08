import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { handleRequest } from "../dispatch.mjs";
import { appsScriptWorker } from "../worker.mjs";
import { appsScript } from "./apps-script.mjs";
import { ADMIN, buildDataset, loadIntoDb, loadIntoGas } from "./dataset.mjs";
import { SERVICES, addServices, freshDatabase } from "./fixture.mjs";
import { googleStubs } from "./google-stubs.mjs";

/**
 * Certificates, reports and uploads: the new backend doing the bookkeeping
 * and Worker.gs doing the Google part. The worker here is the real Worker.gs
 * (with Certificate.gs and Report.gs) in the Apps Script harness, reached
 * through the real worker client — only Drive, Docs and MailApp are faked.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";
const WORKER_URL = "https://script.google.com/macros/s/WORKER/exec";

let db, gas, google, data, worker, workerToken;
const tokens = {};
const realFetch = globalThis.fetch;

before(async () => {
  data = buildDataset();
  db = await freshDatabase();
  await addServices(db);
  await loadIntoDb(db, data);
  await db.query(
    `insert into csm.settings (key, value) values
       ('coa_template_id', 'TPL-1'), ('coa_designation', 'Director IV')
     on conflict (key) do update set value = excluded.value`,
  );
  google = googleStubs();
  gas = appsScript({ services: SERVICES, google: google.globals });
  loadIntoGas(gas, data);
  workerToken = gas.call("setupCsmWorker()").workerToken;
  // The worker client's requests, delivered to doPost as Apps Script would.
  globalThis.fetch = async (url, init) => {
    if (String(url) !== WORKER_URL) throw new Error(`unexpected fetch ${url}`);
    const text = gas.call("doPost({ postData: { contents: __c } }).text", {
      __c: init.body,
    });
    return { status: 200, text: async () => text };
  };
  worker = appsScriptWorker({ url: WORKER_URL, token: workerToken });
  process.env.PORTAL_BASE_URL = "https://csm.example.ph";
  for (const [role, email] of [
    ["superadmin", ADMIN.email],
    ["admin", "staff@ched.gov.ph"],
  ]) {
    const login = await handleRequest(
      { action: "adminLogin", email, password: ADMIN.password },
      { db, requestContext: { clientIp: `192.0.2.${role.length}` } },
    );
    tokens[role] = login.data.token;
  }
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.PORTAL_BASE_URL;
});

const as = (role, body, using = worker) =>
  handleRequest({ ...body, adminToken: tokens[role] }, { db, worker: using });
const row = async (referenceId) =>
  (
    await db.query(
      `select coa_status, coa_link, coa_issue_key, verification_code, verification_url,
              coa_issued_details, coa_issued_at
       from csm.responses where reference_id = $1`,
      [referenceId],
    )
  )[0];
const pick = (predicate) => data.responses.find(predicate);

describe("the worker's door", () => {
  const post = (body) =>
    JSON.parse(
      gas.call("doPost({ postData: { contents: __c } }).text", {
        __c: JSON.stringify(body),
      }),
    );

  test("opens only to the worker token", () => {
    assert.equal(
      post({ action: "workerPing", workerToken }).data.mailQuota,
      100,
    );
    assert.equal(
      post({ action: "workerPing", workerToken: "guess" }).error,
      "Forbidden: invalid worker token.",
    );
    assert.equal(
      post({ action: "workerPing" }).error,
      "Forbidden: invalid worker token.",
    );
  });

  test("and the proxy's token does not open it", () => {
    gas.props.SUBMIT_SHARED_TOKEN_HASH = gas.call("sha256Base64_('proxy')");
    assert.equal(
      post({ action: "workerPing", proxyToken: "proxy" }).error,
      "Forbidden: invalid worker token.",
    );
  });

  test("says so when it has never been set up", () => {
    const fresh = appsScript({ services: SERVICES, google: google.globals });
    const reply = JSON.parse(
      fresh.call("doPost({ postData: { contents: __c } }).text", {
        __c: JSON.stringify({ action: "workerPing", workerToken: "x" }),
      }),
    );
    assert.equal(
      reply.error,
      "The worker is not configured. Run setupCsmWorker().",
    );
  });
});

describe("issuing a certificate", () => {
  let target;
  before(() => {
    target = pick(
      (r) => r.coaStatus === "REQUESTED" && r.coaDateFrom <= "2026-10-01",
    );
  });

  test("fills the template, files the PDF, records it, then emails it", async () => {
    const mailed = gas.mail.length;
    const reply = await as("admin", {
      action: "adminGenerateCoa",
      responseId: target.referenceId,
      issueKey: "key-1",
      expectedStatus: "REQUESTED",
    });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.data.verificationCode, target.verificationCode);
    assert.match(
      reply.data.certificateUrl,
      /^https:\/\/drive\.example\/file-\d+$/,
    );
    // Workspace refused link sharing, so the client gets the PDF attached.
    assert.equal(
      reply.data.emailStatus,
      `Emailed to ${target.email} with the certificate attached.`,
    );

    assert.equal(google.log.replaced["{{name_of_client}}"], target.coaName);
    assert.equal(google.log.replaced["{{signatory}}"], "Dr. Signatory");
    assert.equal(
      google.log.replaced["{{VerificationUrl}}"],
      `https://csm.example.ph/verification?code=${target.verificationCode}`,
    );
    assert.deepEqual(google.log.folders, ["OSDS Certificates of Appearance"]);
    assert.ok(
      google.log.trashed.includes("working-doc"),
      "the working Doc is binned",
    );

    const stored = await row(target.referenceId);
    assert.equal(stored.coa_status, "ISSUED");
    assert.equal(stored.coa_link, reply.data.certificateUrl);
    assert.equal(stored.coa_issue_key, "key-1");
    assert.equal(
      stored.coa_issued_details.name,
      `${target.coaTitle} ${target.coaName}`,
    );
    const [folder] = await db.query(
      "select value from csm.settings where key = 'coa_output_folder_id'",
    );
    assert.match(folder.value, /^folder-\d+$/);

    const mail = gas.mail.slice(mailed);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, target.email);
    assert.equal(mail[0].attachments.length, 1);

    const verified = await handleRequest(
      { action: "verifyCertificate", code: target.verificationCode },
      { db },
    );
    assert.equal(verified.data.valid, true);
  });

  test("a retried click hands back the same certificate and sends nothing", async () => {
    const mailed = gas.mail.length,
      filed = google.log.files.length;
    const reply = await as("admin", {
      action: "adminGenerateCoa",
      responseId: target.referenceId,
      issueKey: "key-1",
    });
    assert.equal(reply.data.duplicate, true);
    assert.match(
      reply.data.emailStatus,
      /^This certificate was already issued and emailed on /,
    );
    assert.equal(gas.mail.length, mailed);
    assert.equal(google.log.files.length, filed);
  });

  test("a second administrator's stale list is answered the same way", async () => {
    const reply = await as("admin", {
      action: "adminGenerateCoa",
      responseId: target.referenceId,
      issueKey: "key-2",
      expectedStatus: "REQUESTED",
    });
    assert.match(
      reply.data.emailStatus,
      / by another request, so nothing was sent again\.$/,
    );
  });

  test("a reissue after an edit gets a new code; the old one stops verifying", async () => {
    await as("admin", {
      action: "adminSaveCoaDetails",
      payload: {
        referenceId: target.referenceId,
        coaTitle: "Dr.",
        coaName: "Changed Name",
        coaAgency: "CHED",
        coaPurpose: "Travel",
        coaDateFrom: target.coaDateFrom,
      },
    });
    const reply = await as("admin", {
      action: "adminGenerateCoa",
      responseId: target.referenceId,
      issueKey: "key-3",
    });
    assert.equal(reply.ok, true, reply.error);
    assert.notEqual(reply.data.verificationCode, target.verificationCode);
    assert.match(
      reply.data.emailStatus,
      /has a new verification code and the earlier one \(OSDS-/,
    );
    const old = await handleRequest(
      { action: "verifyCertificate", code: target.verificationCode },
      { db },
    );
    assert.equal(old.data.valid, false);
  });

  test("refuses what issueCoa_ refused", async () => {
    const declined = pick((r) => r.coaStatus === "DECLINED");
    const none = pick((r) => !r.coaRequested);
    for (const [responseId, message] of [
      [
        declined.referenceId,
        /^This request was declined — .*Put it back in the queue first/,
      ],
      [
        none.referenceId,
        /^This response did not request a Certificate of Appearance\.$/,
      ],
      ["CSM-NOPE", /^Response CSM-NOPE was not found\.$/],
    ]) {
      const reply = await as("admin", {
        action: "adminGenerateCoa",
        responseId,
        issueKey: "k",
      });
      assert.match(reply.error, message);
    }
  });

  test("audits each issue, and each refusal", async () => {
    const entries = await db.query(
      `select outcome, target_id from csm.audit_log where action = 'COA_GENERATE' order by seq`,
    );
    assert.deepEqual(entries.slice(0, 2), [
      { outcome: "SUCCESS", target_id: target.referenceId },
      { outcome: "SUCCESS", target_id: target.referenceId },
    ]);
    assert.ok(
      entries.some(
        (e) => e.outcome === "FAILURE" && e.target_id === "CSM-NOPE",
      ),
    );
  });
});

describe("when the worker fails", () => {
  const scripted = (over) => ({ ...worker, ...over });
  const failingMint = scripted({
    mintCertificate: async () => {
      throw Object.assign(
        new Error("Template conversion failed (403): no access"),
      );
    },
  });

  test("a first issuance is left as ERROR, with the reason", async () => {
    const target = pick((r) => r.coaStatus === "PROCESSING");
    const reply = await as(
      "admin",
      { action: "adminGenerateCoa", responseId: target.referenceId },
      failingMint,
    );
    assert.equal(reply.ok, false);
    assert.equal(
      (await row(target.referenceId)).coa_status,
      "ERROR: Template conversion failed (403): no access",
    );
  });

  test("a reissue leaves the certificate already issued alone", async () => {
    const target = pick(
      (r) => r.coaStatus === "ISSUED" && r.coaDateFrom <= "2026-10-01",
    );
    await as(
      "admin",
      {
        action: "adminGenerateCoa",
        responseId: target.referenceId,
        issueKey: "new",
      },
      failingMint,
    );
    assert.equal((await row(target.referenceId)).coa_status, "ISSUED");
  });

  test("a failed email does not undo the issuance", async () => {
    const target = data.responses.filter((r) => r.coaStatus === "REQUESTED")[1];
    let statusWhenEmailed;
    const reply = await as(
      "admin",
      {
        action: "adminGenerateCoa",
        responseId: target.referenceId,
        issueKey: "m",
      },
      scripted({
        sendCertificateEmail: async () => {
          statusWhenEmailed = (await row(target.referenceId)).coa_status;
          throw new Error("Service invoked too many times");
        },
      }),
    );
    assert.equal(statusWhenEmailed, "ISSUED", "recorded before it was sent");
    assert.equal(
      reply.data.emailStatus,
      "The certificate was issued, but the email could not be sent (Service invoked too many times). Send the link manually.",
    );
  });

  test("with no worker connected, says what to set", async () => {
    const target = data.responses.filter((r) => r.coaStatus === "REQUESTED")[2];
    const reply = await handleRequest(
      {
        action: "adminGenerateCoa",
        responseId: target.referenceId,
        adminToken: tokens.admin,
      },
      { db },
    );
    assert.match(
      reply.error,
      /Set CSM_WORKER_URL and CSM_WORKER_TOKEN in Vercel\.$/,
    );
  });

  test("an issuance in progress elsewhere is waited on, then reported", async () => {
    const busy = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: (text, params) =>
              /for update/.test(text)
                ? Promise.reject(
                    Object.assign(new Error("lock timeout"), { code: "55P03" }),
                  )
                : tx.query(text, params),
          }),
        ),
    };
    const reply = await handleRequest(
      {
        action: "adminGenerateCoa",
        responseId: data.responses[0].referenceId,
        adminToken: tokens.admin,
      },
      { db: busy, worker },
    );
    assert.equal(
      reply.error,
      "Another certificate is being issued right now. Wait a moment, then refresh the list before trying again.",
    );
  });
});

describe("the decline email", () => {
  test("goes out through the worker", async () => {
    const target = data.responses.filter((r) => r.coaStatus === "REQUESTED")[3];
    const reply = await as("admin", {
      action: "adminDeclineCoa",
      payload: {
        referenceId: target.referenceId,
        reason: "Not an OSDS transaction",
      },
    });
    assert.equal(reply.data.emailStatus, "The client was emailed the reason.");
    assert.equal(gas.mail.at(-1).to, target.email);
    assert.match(gas.mail.at(-1).body, /Reason: Not an OSDS transaction/);
  });
});

describe("generating a report", () => {
  let sent;
  beforeEach(() => {
    sent = null;
    // The workbook builders are the same code the sheet path runs; here the
    // test only needs to see what reached them.
    gas.call(
      `buildReportWorkbook_ = function (period, settings, services, records, stats, folder, actorEmail, adminEmails) {
      __sent({ period: period, records: records, stats: stats, actorEmail: actorEmail, adminEmails: adminEmails, office: settings.office_name });
      return { file: folder.createFile(blob(period.label + '.xlsx')), accessNote: '' };
    }`,
      { __sent: (value) => (sent = JSON.parse(JSON.stringify(value))) },
    );
  });

  test("sends the quarter's records, read through the answer policy", async () => {
    const reply = await as("admin", {
      action: "adminGenerateReport",
      period: { type: "quarter", year: 2026, quarter: 3 },
    });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(sent.period.label, "3rd Quarter 2026");
    const inQuarter = data.responses.filter(
      (r) =>
        r.transactionDate >= "2026-07-01" && r.transactionDate < "2026-10-01",
    );
    assert.equal(sent.records.length, inQuarter.length);
    assert.ok(
      sent.records.every(
        (r) => r.serviceId === "S-CHARGES" || r.sqd5 === "N/A",
      ),
      "SQD5 reads as N/A wherever no fee is charged",
    );
    assert.deepEqual(sent.stats["S-CHARGES"], {
      clients: "40",
      transactions: "52",
      remarks: "Peak month",
    });
    assert.deepEqual(sent.adminEmails, [
      "host@ched.gov.ph",
      "staff@ched.gov.ph",
    ]);
    assert.equal(sent.actorEmail, "staff@ched.gov.ph");

    const list = await as("admin", { action: "adminGetReports" });
    assert.equal(list.data[0].report_id, reply.data.report_id);
    assert.equal(list.data[0].name, "3rd Quarter 2026.xlsx");
    assert.equal(list.data[0].created_by, "staff@ched.gov.ph");
  });

  test("refuses a period with no responses", async () => {
    const reply = await as("admin", {
      action: "adminGenerateReport",
      period: { type: "quarter", year: 2030, quarter: 1 },
    });
    assert.equal(
      reply.error,
      "There are no responses for 1st Quarter 2030 yet.",
    );
    assert.equal(sent, null);
  });
});

describe("uploads", () => {
  test("a template is filed, and its folder remembered", async () => {
    const reply = await as("superadmin", {
      action: "adminUploadCoaTemplate",
      payload: { base64: "AAAA", filename: "COA Template.docx", mimeType: "" },
    });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.data.name, "COA Template.docx");
    const [folder] = await db.query(
      "select value from csm.settings where key = 'coa_template_folder_id'",
    );
    const signature = await as("superadmin", {
      action: "adminUploadSignature",
      payload: { base64: "AAAA", filename: "sign.png", mimeType: "image/png" },
    });
    assert.equal(signature.ok, true, signature.error);
    const filed = google.log.files.filter((f) =>
      ["COA Template.docx", "sign.png"].includes(f.name),
    );
    assert.deepEqual(
      filed.map((f) => f.folder),
      [folder.value, folder.value],
    );
  });

  test("refuses what Apps Script refused, before anything travels", async () => {
    for (const [action, payload, message] of [
      ["adminUploadCoaTemplate", {}, "No file payload."],
      [
        "adminUploadCoaTemplate",
        { base64: "AAAA", filename: "x.pdf" },
        "The certificate template must be a Word (.doc or .docx) file.",
      ],
      [
        "adminUploadSignature",
        { base64: "AAAA", filename: "s.gif", mimeType: "image/gif" },
        "Please upload a PNG, JPG, or WebP signature image no larger than 2 MB.",
      ],
    ])
      assert.equal(
        (await as("superadmin", { action, payload })).error,
        message,
      );
    assert.equal(
      (
        await as("admin", {
          action: "adminUploadCoaTemplate",
          payload: { base64: "A", filename: "t.docx" },
        })
      ).error,
      "Forbidden: superadmin access required.",
    );
  });
});

describe("the sheet path's issue times", () => {
  test("are written as text, and an old date cell reads back the same way", () => {
    const target = data.responses.find(
      (r) => r.coaStatus === "REQUESTED" && r.coaDateFrom <= "2026-10-01",
    );
    gas.sheets.Settings.data.push(["coa_template_id", "TPL-1"]);
    const issued = gas.call("adminGenerateCoa(__r, 'sheet-key', 't', '')", {
      __r: target.referenceId,
    });
    assert.equal(issued.status, "OK");
    const cell = gas.cell(target.referenceId, "COAIssuedAt");
    assert.equal(typeof cell, "string", "Sheets was told it is text");
    assert.match(cell, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // A row issued before the fix holds a date cell; it reads as text too.
    const header = gas.headers.indexOf("COAIssuedAt");
    const old = data.responses.find((r) => r.coaStatus === "ISSUED");
    const rows = gas.sheets.Responses.data.map((row) =>
      row[gas.headers.indexOf("ResponseID")] === old.referenceId
        ? row.map((value, i) =>
            i === header ? new Date("2026-09-20T07:05:00Z") : value,
          )
        : row,
    );
    gas.setSheet("Responses", rows);
    gas.call(
      "ENSURED_SHEETS_ = {}; CacheService.getScriptCache().remove('COA_VERIFY_' + __c)",
      {
        __c: old.verificationCode,
      },
    );
    assert.equal(gas.record(old.referenceId).coaIssuedAt, "2026-09-20 15:05");
    assert.equal(
      gas.call("verifyCertificate(__c)", { __c: old.verificationCode })
        .issuedAt,
      "2026-09-20 15:05",
    );
  });
});
