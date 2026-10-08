import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { officeDay } from "./dates.mjs";
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
 *
 * Reads CSM_WORKER_URL (or GAS_WEB_APP_URL) and CSM_WORKER_TOKEN from .env or
 * .env.local.
 */

const { values: options } = parseArgs({
  options: {
    email: { type: "string" },
    template: { type: "string" },
    folder: { type: "string", default: "" },
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
  return `zone ${pong.timezone}, ${pong.mailQuota} emails left today`;
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
