import { readFileSync } from "node:fs";
import postgres from "postgres";
import { database } from "./db.mjs";
import {
  getPortalConfig,
  submitResponse,
  verifyCertificate,
} from "./actions/public.mjs";

/**
 * Is DATABASE_URL right, and how fast is the database from here?
 *
 * Reads, plus one test submission made inside a transaction that is rolled
 * back, so the database is left exactly as it was found.
 *
 *   npm run db:check          (reads DATABASE_URL from .env or .env.local)
 */

class RolledBack extends Error {}

// Every DATABASE_URL line in the files this reads, by user and host only.
// With two, the later one wins, which an edit to the earlier one never shows.
for (const file of [".env", ".env.local"]) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    continue;
  }
  const defined = lines
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => /^\s*(export\s+)?DATABASE_URL\s*=/.test(line));
  if (defined.length > 1)
    console.log(
      `${file} defines DATABASE_URL ${defined.length} times; the last one (line ${defined.at(-1).at}) is used:`,
    );
  if (defined.length > 1)
    for (const { line, at } of defined) {
      const value = line.replace(/^[^=]*=\s*/, "").replace(/^["']|["']$/g, "");
      let who = "an unreadable value";
      try {
        const url = new URL(value);
        who = `${decodeURIComponent(url.username)} at ${url.hostname}`;
      } catch {}
      console.log(`  line ${at}: ${who}`);
    }
}

// Who and where, never the password: enough to tell a pooler string from a
// direct one, or one project from another.
try {
  const url = new URL(String(process.env.DATABASE_URL || "").trim());
  console.log(
    `Connecting as ${decodeURIComponent(url.username)} to ${url.hostname}:${url.port || 5432}` +
      `${url.port === "6543" ? " (transaction pooler)" : url.hostname.startsWith("db.") ? " (direct connection — Vercel cannot reach this)" : ""}.`,
  );
  // The usual reasons a correct-looking string is refused, named without
  // showing the password.
  const password = url.password;
  if (!password) console.log("It has no password.");
  else if (/YOUR-PASSWORD|[[\]]/i.test(password))
    console.log("Its password is still the [YOUR-PASSWORD] placeholder.");
  else if (/[^A-Za-z0-9%._~-]/.test(password))
    console.log(
      "Its password has characters that must be percent-encoded in the string.",
    );
  else if (/%/.test(password)) console.log("Its password is percent-encoded.");
} catch {
  console.log("DATABASE_URL is not a readable connection string.");
}

const db = database();
const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];

async function timed(label, work, runs = 3) {
  const samples = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    result = await work();
    samples.push(Math.round(performance.now() - started));
  }
  console.log(
    `${label.padEnd(34)} ${String(median([...samples])).padStart(5)} ms  (${samples.join(", ")})`,
  );
  return result;
}

/**
 * A password the pooler refuses may be wrong, or newly reset and not yet
 * known to the pooler. The database itself, reached directly, tells the two
 * apart. Only whether it was accepted is reported.
 */
async function triedDirectly() {
  const url = new URL(String(process.env.DATABASE_URL).trim());
  const ref = decodeURIComponent(url.username).split(".")[1];
  if (!ref) return;
  const direct = postgres({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: url.pathname.slice(1) || "postgres",
    username: "postgres",
    password: decodeURIComponent(url.password),
    ssl: "require",
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    await direct`select 1`;
    console.log(
      "The database itself accepts this password: the pooler has not caught up with the reset yet. Wait a few minutes and run this again.",
    );
  } catch (error) {
    console.log(
      error.code === "28P01"
        ? "The database itself refuses this password too: it is not this project's password."
        : `The database could not be reached directly to compare (${error.code || error.message}); this network may lack IPv6.`,
    );
  } finally {
    await direct.end({ timeout: 1 });
  }
}

try {
  try {
    await timed("Connect and first query", () => db.query("select 1"), 1);
  } catch (error) {
    if (error.code === "28P01") await triedDirectly();
    throw error;
  }
  // Two queries at once need a second connection, which the pool opens on
  // demand; a cold function instance pays this on its first such request.
  await timed(
    "Second connection opened",
    () => Promise.all([db.query("select 1"), db.query("select 1")]),
    1,
  );
  await timed("One query on an open connection", () => db.query("select 1"));
  const [counts] = await db.query(`
    select (select count(*)::int from csm.services) as services,
           (select count(*)::int from csm.settings) as settings,
           (select count(*)::int from csm.responses) as responses,
           (select string_agg(name, ', ' order by name) from csm.schema_migrations) as migrations`);
  console.log(
    `Tables: ${counts.services} programmes, ${counts.settings} settings, ${counts.responses} responses` +
      ` (migrations: ${counts.migrations})`,
  );

  const config = await timed("Programme list (getPortalConfig)", () =>
    getPortalConfig({ db }),
  );
  await timed("Certificate check (unknown code)", () =>
    verifyCertificate({ db }, "OSDS-00000000000000000000"),
  );

  const service = config.services.find((s) => s.category === "main");
  if (!service) throw new Error("No active programme to submit against.");
  let stored;
  const started = performance.now();
  try {
    await db.transaction(async (tx) => {
      const reply = await submitResponse(
        { db: tx, now: new Date() },
        {
          email: "db-check@example.invalid",
          clientType: "Citizen",
          transactionDate: new Date().toISOString().slice(0, 10),
          region: "National Capital Region",
          serviceId: service.service_id,
          cc1: "1",
          cc2: "1",
          cc3: "1",
          sqd0: "5",
          sqd1: "5",
          sqd2: "5",
          sqd3: "5",
          sqd4: "5",
          sqd5: service.has_fees ? "5" : "N/A",
          sqd6: "5",
          sqd7: "5",
          sqd8: "5",
          wantsCoa: "yes",
          coaName: "Database Check",
          coaAgency: "OSDS",
          coaPurpose: "Connection test",
          coaDateFrom: new Date().toISOString().slice(0, 10),
          submissionId: `db-check-${Date.now()}`,
          privacyNoticeVersion: "1.1",
        },
      );
      if (reply.status !== "OK")
        throw new Error(`Submission refused: ${reply.message}`);
      [stored] = await tx.query(
        "select reference_id, verification_code, coa_status from csm.responses where reference_id = $1",
        [reply.referenceId],
      );
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  console.log(
    `${"Test submission, rolled back".padEnd(34)} ${String(Math.round(performance.now() - started)).padStart(5)} ms  ` +
      `(stored as ${stored.reference_id}, ${stored.coa_status}, ${stored.verification_code})`,
  );
  const [after] = await db.query(
    "select count(*)::int as n from csm.responses",
  );
  console.log(
    `Responses afterwards: ${after.n} (unchanged: ${after.n === counts.responses})`,
  );
} finally {
  await db.end();
}
