import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { officeDay } from "./dates.mjs";
import { normalizePeriod } from "./periods.mjs";
import { buildReportWorkbook } from "./report.mjs";
import { appsScriptWorker } from "./worker.mjs";

/**
 * Checks the Apps Script worker against a real deployment, outside the
 * portal: nothing here reads or writes the database.
 *
 *   npm run worker:check
 *     Whether the worker answers, and today's remaining email quota.
 *   npm run worker:check -- --email you@ched.gov.ph
 *     Also sends that address a test decline notice.
 *   npm run worker:check -- --email you@ched.gov.ph --template <Drive file id>
 *     Also makes a test certificate from that template, files it in Drive
 *     (a new "OSDS Certificates of Appearance" folder, unless --folder names
 *     one) and emails it there. Its verification code is not on record, so
 *     its QR code will report it as not valid.
 *   npm run worker:check -- --report [--email you@ched.gov.ph]
 *     Builds a sample report workbook here, from three made-up responses,
 *     and has the worker file it in Drive (a new "OSDS CSM Reports" folder,
 *     unless --folder names one), shared with --email if given. Delete it
 *     from Drive afterwards.
 *
 * Reads CSM_WORKER_URL (or GAS_WEB_APP_URL) and CSM_WORKER_TOKEN from .env or
 * .env.local.
 */

const { values: options } = parseArgs({
  options: {
    email: { type: "string" },
    template: { type: "string" },
    folder: { type: "string", default: "" },
    report: { type: "boolean", default: false },
  },
});

const url = String(
  process.env.CSM_WORKER_URL || process.env.GAS_WEB_APP_URL || "",
).trim();
const token = String(process.env.CSM_WORKER_TOKEN || "").trim();
if (!url || !token) {
  // Names only, never values: enough to spot a typo or the wrong file.
  const near = Object.keys(process.env).filter((name) =>
    /WORKER|^CSM_|GAS_WEB_APP_URL|DATABASE_URL/i.test(name),
  );
  console.error(
    `Set CSM_WORKER_URL and CSM_WORKER_TOKEN in .env first. ` +
      `Missing: ${[!url && "CSM_WORKER_URL", !token && "CSM_WORKER_TOKEN"].filter(Boolean).join(", ")}. ` +
      `Related names found: ${near.join(", ") || "none"}.`,
  );
  process.exit(1);
}
const worker = appsScriptWorker({ url, token, timeoutMs: 90_000 });
const settings = {
  office_name: "Office of Student Development and Services (OSDS)",
  coa_signatory: "Test Signatory",
  coa_designation: "Test only — not an issued certificate",
};

async function step(label, work) {
  const started = performance.now();
  try {
    const result = await work();
    console.log(
      `ok    ${label} (${Math.round(performance.now() - started)} ms)${result ? `: ${result}` : ""}`,
    );
    return true;
  } catch (error) {
    console.log(`FAIL  ${label}: ${error.message || error}`);
    process.exitCode = 1;
    return false;
  }
}

const reached = await step("worker answers", async () => {
  const pong = await worker.ping();
  const files = (pong.actions || []).includes("workerSaveReport");
  return `zone ${pong.timezone}, ${pong.mailQuota} emails left today, ${
    files
      ? "files the report workbooks built here"
      : "an older Worker.gs that builds reports itself — replace Worker.gs and deploy a new version"
  }`;
});

if (reached && options.email) {
  const record = {
    email: options.email,
    coaTitle: "",
    coaName: "Test Recipient",
    referenceId: `CSM-WORKERTEST`,
  };
  await step(`decline notice to ${options.email}`, () =>
    worker.sendDeclineEmail({
      record,
      reason:
        "This is a test of the CSM portal's email worker. No action is needed.",
      settings,
    }),
  );

  if (options.template) {
    const today = officeDay();
    const verificationCode = `OSDS-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
    const base = String(process.env.PORTAL_BASE_URL || "").replace(/\/$/, "");
    const verificationUrl = base
      ? `${base}/verification?code=${verificationCode}`
      : "";
    const certificate = {
      ...record,
      coaTitle: "Mx.",
      coaAgency: "CHED Office of Student Development and Services",
      coaPurpose: "testing the certificate worker",
      coaDateFrom: today,
      coaDateTo: "",
    };
    let minted;
    const made = await step("certificate made and filed in Drive", async () => {
      minted = await worker.mintCertificate({
        record: certificate,
        settings: { ...settings, coa_template_id: options.template },
        verificationCode,
        verificationUrl,
        issuedOn: new Date().toISOString(),
        outputFolderId: options.folder,
      });
      return `${minted.certificateUrl} (link sharing ${minted.shared ? "allowed" : "refused"}, folder ${minted.outputFolderId})`;
    });
    if (made)
      await step(`certificate emailed to ${options.email}`, () =>
        worker.sendCertificateEmail({
          record: certificate,
          fileId: minted.fileId,
          certificateUrl: minted.shared ? minted.certificateUrl : "",
          verificationCode,
          verificationUrl,
          settings,
        }),
      );
  }
}

if (reached && options.report) {
  const period = normalizePeriod({ type: "quarter" });
  const answers = (score) =>
    Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`sqd${i}`, i === 5 ? "N/A" : score]),
    );
  const records = ["5", "4", "5"].map((score, i) => ({
    referenceId: `CSM-WORKERTEST${i + 1}`,
    transactionDate: officeDay(),
    month: "TEST",
    clientType: "CITIZEN",
    sex: i % 2 ? "MALE" : "FEMALE",
    age: String(20 + i * 10),
    regionCode: "NCR",
    serviceId: "S-TEST",
    serviceCode: "TEST",
    cc1: "1",
    cc2: "1",
    cc3: "1",
    ...answers(score),
    email: `sample${i + 1}@example.invalid`,
    suggestions: i === 0 ? "Sample response, made up by worker:check." : "",
  }));
  await step("sample report built here and filed in Drive", async () => {
    const built = await buildReportWorkbook({
      period: { ...period, label: `${period.label} (worker check)` },
      settings,
      services: [
        {
          service_id: "S-TEST",
          code: "TEST",
          name_en: "Worker check — sample responses only",
          category: "main",
          active: true,
          has_fees: false,
        },
      ],
      records,
      stats: {},
    });
    const saved = await worker.saveReport({
      file: { base64: built.bytes.toString("base64"), filename: built.name },
      folderId: options.folder,
      actorEmail: options.email || "",
      adminEmails: [],
    });
    return `${saved.url} (folder ${saved.folderId})${saved.accessNote ? ` — ${saved.accessNote}` : ""}`;
  });
}
