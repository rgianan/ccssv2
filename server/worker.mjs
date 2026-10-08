import { explainNonJson } from "../api/gas-proxy.mjs";
import { UserError } from "./errors.mjs";

/**
 * The steps that need Google: certificate PDFs from the Docs template, email
 * through MailApp (free on the office's Workspace account), report workbooks,
 * and files kept in Drive. Apps Script does them, in Worker.gs; this calls it.
 *
 * The worker holds no records. Each call carries what the step needs and
 * returns what came of it, and the backend does the bookkeeping. It is
 * reached at CSM_WORKER_URL (the Apps Script /exec address, by default the
 * same one as GAS_WEB_APP_URL) with CSM_WORKER_TOKEN, which setupCsmWorker()
 * issues and which the browser-facing proxy never sends.
 */

/**
 * The worker's own failures — a template that will not convert, a quota, a
 * Drive error — are told to the administrator who asked, as Apps Script told
 * them before.
 */
export class WorkerError extends UserError {}

const NOT_CONNECTED = "the email service is not connected yet";
const NOT_CONFIGURED =
  "Certificates, reports and uploads need the Apps Script worker, which is not connected. Set CSM_WORKER_URL and CSM_WORKER_TOKEN in Vercel.";

export const disconnectedWorker = {
  async ping() {
    throw new WorkerError(NOT_CONFIGURED);
  },
  async mintCertificate() {
    throw new WorkerError(NOT_CONFIGURED);
  },
  async sendCertificateEmail() {
    throw new Error(NOT_CONNECTED);
  },
  async sendDeclineEmail() {
    throw new Error(NOT_CONNECTED);
  },
  async generateReport() {
    throw new WorkerError(NOT_CONFIGURED);
  },
  async uploadFile() {
    throw new WorkerError(NOT_CONFIGURED);
  },
};

/**
 * A worker at `url`. Requests wait up to `timeoutMs`: a report can take most
 * of a minute, and the function serving the request has sixty seconds.
 */
export function appsScriptWorker({ url, token, timeoutMs = 50_000 }) {
  async function call(action, data) {
    let response, text;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...data, action, workerToken: token }),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new WorkerError(
        `The Apps Script worker could not be reached (${String(error?.message || error).slice(0, 120)}). Try again in a moment.`,
      );
    }
    let reply;
    try {
      reply = JSON.parse(text);
    } catch {
      const { message, detail } = explainNonJson(response.status, text);
      console.error(`[csm-worker] ${action}: ${detail}`);
      throw new WorkerError(message);
    }
    if (!reply || reply.ok !== true)
      throw new WorkerError(
        reply?.error || "The Apps Script worker did not answer.",
      );
    return reply.data;
  }
  return {
    ping: () => call("workerPing", {}),
    mintCertificate: (data) => call("workerMintCertificate", data),
    sendCertificateEmail: async (data) =>
      (await call("workerSendCertificateEmail", data)).emailStatus,
    sendDeclineEmail: async (data) =>
      (await call("workerSendDeclineEmail", data)).emailStatus,
    generateReport: (data) => call("workerGenerateReport", data),
    uploadFile: (data) => call("workerUploadFile", data),
  };
}

export function defaultWorker() {
  const url = String(
    process.env.CSM_WORKER_URL || process.env.GAS_WEB_APP_URL || "",
  ).trim();
  const token = String(process.env.CSM_WORKER_TOKEN || "").trim();
  return url && token ? appsScriptWorker({ url, token }) : disconnectedWorker;
}
