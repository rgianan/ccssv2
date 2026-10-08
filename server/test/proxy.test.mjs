import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import handler from "../../api/gas-proxy.mjs";
import { useDatabase } from "../db.mjs";
import { addServices, freshDatabase, validForm } from "./fixture.mjs";

/**
 * /api/gas-proxy with CSM_BACKEND=postgres: the browser's request, Turnstile
 * included, answered from the database in the reply shape it already reads.
 */

let db, fetched;
const ENV = [
  "CSM_BACKEND",
  "GAS_WEB_APP_URL",
  "SUBMIT_SHARED_TOKEN",
  "TURNSTILE_SECRET_KEY",
  "PORTAL_BASE_URL",
  "DATABASE_URL",
];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

before(async () => {
  db = await freshDatabase();
  await addServices(db);
});
after(() => {
  for (const key of ENV)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  globalThis.fetch = realFetch;
  useDatabase(null);
});
beforeEach(() => {
  for (const key of ENV) delete process.env[key];
  process.env.CSM_BACKEND = "postgres";
  process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
  useDatabase(db);
  fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("turnstile"))
      return {
        json: async () => ({
          success: true,
          action: "client_submit",
          hostname: "portal.example",
        }),
      };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ ok: true, data: { from: "apps-script" } }),
    };
  };
});

async function post(body) {
  const res = { status: 0, headers: {}, body: "" };
  await handler(
    {
      method: "POST",
      headers: { "x-vercel-id": "sin1::test", "x-real-ip": "203.0.113.9" },
      body,
    },
    {
      writeHead: (status, headers) => Object.assign(res, { status, headers }),
      end: (text) => {
        res.body = text;
      },
    },
  );
  return { ...res, json: JSON.parse(res.body) };
}

const quietly = async (work) => {
  const log = console.log,
    error = console.error;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  console.error = () => {};
  try {
    return { result: await work(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
};

describe("CSM_BACKEND=postgres", () => {
  test("answers from the database, needing neither Apps Script setting", async () => {
    const { result: res, lines } = await quietly(() =>
      post({ action: "getPortalConfig" }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.data.services.length, 3);
    assert.equal("perf" in res.json, false);
    assert.equal(fetched.length, 0);
    assert.match(
      res.headers["server-timing"],
      /^total;dur=\d+;desc="Inside the backend", db;dur=\d+;desc="Database \(2 queries\)"$/,
    );
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    const perf = JSON.parse(
      lines.find((line) => line.startsWith("[csm-perf] ")).slice(11),
    );
    assert.equal(perf.backend, "postgres");
    assert.equal(perf.requestId, "sin1::test");
    assert.equal(perf.queries, 2);
  });

  test("still requires Turnstile for a submission", async () => {
    const res = await post({ action: "submitResponse", payload: validForm() });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "Please complete the security verification.");
  });

  test("stores a verified submission", async () => {
    const { result: res } = await quietly(() =>
      post({
        action: "submitResponse",
        payload: validForm({
          submissionId: "via-proxy",
          turnstileToken: "tok",
        }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.data.status, "OK");
    assert.equal(fetched.length, 1);
    assert.match(fetched[0].url, /turnstile/);
    const [row] = await db.query(
      "select reference_id from csm.responses where submission_id = 'via-proxy'",
    );
    assert.equal(row.reference_id, res.json.data.referenceId);
  });

  test("a worker action from a browser is not an action at all", async () => {
    for (const backend of ["postgres", ""]) {
      process.env.CSM_BACKEND = backend;
      process.env.GAS_WEB_APP_URL =
        "https://script.google.com/macros/s/AKfyc-test/exec";
      process.env.SUBMIT_SHARED_TOKEN = "s".repeat(64);
      const res = await post({
        action: "workerMintCertificate",
        workerToken: "guess",
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "Unknown action: workerMintCertificate");
    }
    assert.equal(fetched.length, 0, "nothing reached Apps Script");
  });

  test("a browser cannot slip a worker token through", async () => {
    delete process.env.CSM_BACKEND;
    process.env.GAS_WEB_APP_URL =
      "https://script.google.com/macros/s/AKfyc-test/exec";
    process.env.SUBMIT_SHARED_TOKEN = "s".repeat(64);
    await post({ action: "getPortalConfig", workerToken: "guess" });
    assert.equal("workerToken" in fetched[0].body, false);
  });

  test("says what is missing when the database is not configured", async () => {
    useDatabase(null);
    const { result: res } = await quietly(() =>
      post({ action: "getPortalConfig" }),
    );
    assert.equal(res.status, 500);
    assert.match(res.json.error, /Set DATABASE_URL in Vercel/);
  });
});

describe("without CSM_BACKEND", () => {
  test("everything still goes to Apps Script", async () => {
    delete process.env.CSM_BACKEND;
    process.env.GAS_WEB_APP_URL =
      "https://script.google.com/macros/s/AKfyc-test/exec";
    process.env.SUBMIT_SHARED_TOKEN = "s".repeat(64);
    const res = await post({ action: "getPortalConfig" });
    assert.deepEqual(res.json, { ok: true, data: { from: "apps-script" } });
    assert.equal(fetched[0].url, process.env.GAS_WEB_APP_URL);
    assert.equal(fetched[0].body.proxyToken, "s".repeat(64));
  });

  test("and still insists on its settings", async () => {
    delete process.env.CSM_BACKEND;
    const res = await post({ action: "getPortalConfig" });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /GAS_WEB_APP_URL/);
  });
});
