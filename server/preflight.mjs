import { database } from "./db.mjs";
import { migrationFiles } from "./migrate.mjs";
import { auditCanonical, auditHmac } from "./audit.mjs";
import { appsScriptWorker } from "./worker.mjs";

/**
 * Before flipping CSM_BACKEND: is everything the new backend needs in place?
 * Reads the same variables Vercel will hold, from .env, and changes nothing.
 *
 *   npm run cutover:check
 *
 * Keep .env's values the same as Vercel's for this to mean anything.
 */

let failed = 0;
const report = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};
const env = (name) => String(process.env[name] || "").trim();

report(
  /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(
    env("PORTAL_BASE_URL").replace(/\/$/, ""),
  ),
  "PORTAL_BASE_URL is the portal's https origin",
  env("PORTAL_BASE_URL") || "not set",
);
report(Boolean(env("TURNSTILE_SECRET_KEY")), "TURNSTILE_SECRET_KEY is set");
report(Boolean(env("AUDIT_HASH_SECRET")), "AUDIT_HASH_SECRET is set");

let db;
try {
  db = database();
  const applied = new Set(
    (await db.query("select name from csm.schema_migrations")).map(
      (r) => r.name,
    ),
  );
  const missing = migrationFiles()
    .map((f) => f.name)
    .filter((name) => !applied.has(name));
  report(
    !missing.length,
    "every migration is applied",
    missing.length ? `missing ${missing.join(", ")}` : "",
  );

  const [counts] = await db.query(`
    select (select count(*)::int from csm.responses) as responses,
           (select count(*)::int from csm.services where active) as programs,
           (select count(*)::int from csm.admin_users where active and role = 'superadmin') as superadmins`);
  report(counts.responses > 0, "responses are imported", `${counts.responses}`);
  report(
    counts.programs > 0,
    "the survey has programs to offer",
    `${counts.programs} active`,
  );
  report(
    counts.superadmins > 0,
    "a superadmin can sign in",
    `${counts.superadmins} active`,
  );

  const settings = Object.fromEntries(
    (await db.query("select key, value from csm.settings")).map((r) => [
      r.key,
      r.value.trim(),
    ]),
  );
  const unset = ["coa_template_id", "coa_signatory", "coa_designation"].filter(
    (k) => !settings[k],
  );
  report(
    !unset.length,
    "certificates can be issued",
    unset.length ? `Settings lacks ${unset.join(", ")}` : "",
  );

  const entries = await db.query(
    `select logged_at as timestamp, audit_id, actor_email, actor_role, action, target_type,
            target_id, outcome, details, request_id, previous_hash, entry_hash
     from csm.audit_log order by seq`,
  );
  const [state] = await db.query(
    "select head_hash, dropped_count from csm.audit_state",
  );
  let previous = null,
    intact = Boolean(env("AUDIT_HASH_SECRET"));
  for (const entry of entries) {
    if (
      auditHmac(auditCanonical(entry), env("AUDIT_HASH_SECRET")) !==
      entry.entry_hash
    )
      intact = false;
    if (previous !== null && entry.previous_hash !== previous) intact = false;
    previous = entry.entry_hash;
  }
  if (state.head_hash && previous !== state.head_hash) intact = false;
  report(
    intact,
    "the audit chain verifies with this AUDIT_HASH_SECRET",
    `${entries.length} entries`,
  );
} catch (error) {
  report(false, "the database answers at DATABASE_URL", error.message);
} finally {
  await db?.end();
}

// The worker is the production Apps Script project, at GAS_WEB_APP_URL.
report(
  /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(
    env("GAS_WEB_APP_URL"),
  ),
  "GAS_WEB_APP_URL is the production web app",
  env("GAS_WEB_APP_URL") ? "" : "not set — copy it from Vercel",
);
const workerUrl = env("CSM_WORKER_URL") || env("GAS_WEB_APP_URL");
if (!workerUrl || !env("CSM_WORKER_TOKEN"))
  report(
    false,
    "the Apps Script worker is configured",
    !env("CSM_WORKER_TOKEN")
      ? "CSM_WORKER_TOKEN is not set"
      : "no worker address: set GAS_WEB_APP_URL",
  );
else
  try {
    const pong = await appsScriptWorker({
      url: workerUrl,
      token: env("CSM_WORKER_TOKEN"),
    }).ping();
    report(
      true,
      "the Apps Script worker answers",
      `${pong.mailQuota} emails left today`,
    );
    report(
      !env("CSM_WORKER_URL") ||
        env("CSM_WORKER_URL") === env("GAS_WEB_APP_URL"),
      "the worker is the production project",
      env("CSM_WORKER_URL") !== env("GAS_WEB_APP_URL")
        ? "CSM_WORKER_URL points elsewhere — the staging copy?"
        : "",
    );
  } catch (error) {
    report(false, "the Apps Script worker answers", error.message);
  }

console.log(
  failed
    ? `\n${failed} check(s) failed. Fix them before switching.`
    : "\nReady to switch.",
);
process.exitCode = failed ? 1 : 0;
