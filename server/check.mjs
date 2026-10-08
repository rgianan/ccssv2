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

try {
  await timed("Connect and first query", () => db.query("select 1"), 1);
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
