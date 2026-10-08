import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { database } from "./db.mjs";

/**
 * Applies each file in server/schema that the database has not seen, in name
 * order, each in its own transaction, and records it in csm.schema_migrations.
 * A file is never edited once applied anywhere that matters; a change is a
 * new file.
 *
 *   npm run db:migrate          (reads DATABASE_URL from .env or .env.local)
 */

const SCHEMA_DIR = fileURLToPath(new URL("./schema/", import.meta.url));

export function migrationFiles() {
  return readdirSync(SCHEMA_DIR)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, sql: readFileSync(SCHEMA_DIR + name, "utf8") }));
}

export async function migrate(db) {
  await db.exec(`
    create schema if not exists csm;
    create table if not exists csm.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );`);
  const done = new Set(
    (await db.query("select name from csm.schema_migrations")).map(
      (row) => row.name,
    ),
  );
  const applied = [];
  for (const file of migrationFiles()) {
    if (done.has(file.name)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query("insert into csm.schema_migrations (name) values ($1)", [
        file.name,
      ]);
    });
    applied.push(file.name);
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = database();
  try {
    const applied = await migrate(db);
    console.log(
      applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.",
    );
  } finally {
    await db.end();
  }
}
