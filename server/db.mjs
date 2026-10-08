import postgres from "postgres";

/**
 * The database behind the new backend: Postgres, reached through Supabase's
 * transaction pooler from DATABASE_URL.
 *
 * Every caller sees the same three methods, whatever drives them, so the
 * tests run the same code against PGlite (Postgres compiled to run inside
 * Node) that production runs against Supabase:
 *
 *   query(text, params)  one statement with $1, $2… parameters; returns rows
 *   exec(script)         several statements, no parameters (migrations)
 *   transaction(work)    work({ query, exec }) inside BEGIN … COMMIT
 *
 * Tables are always named with their schema (csm.responses). The pooler
 * hands each transaction whichever connection is free, so a search_path set
 * on one connection is not there on the next.
 *
 * A parameter bound for a json or jsonb column is passed as JSON text and cast
 * through text: $1::text::jsonb, never $1::jsonb. Told a parameter is JSON,
 * postgres.js encodes it again — the text becomes one quoted string — while
 * PGlite passes it through, so only production would show the difference.
 */

let current = null;

/** One pool per function instance, reused by every request it serves. */
export function database() {
  if (current) return current;
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url)
    throw new Error(
      "The database is not configured. Set DATABASE_URL in Vercel to the Supabase transaction pooler connection string.",
    );
  current = fromPostgresJs(
    postgres(url, {
      // The pooler may run each statement on a different connection, where a
      // statement prepared on another one does not exist.
      prepare: false,
      // A function instance serves a handful of requests at once; the pooler,
      // not this, is what shares connections between instances.
      max: 4,
      idle_timeout: 20,
      connect_timeout: 10,
      // Queries that need a date cast it to text themselves, so no driver
      // ever turns a calendar day into an instant in some zone.
      onnotice: () => {},
    }),
  );
  return current;
}

/** For tests and scripts that bring their own connection. */
export function useDatabase(db) {
  current = db;
}

export function fromPostgresJs(sql) {
  const wrap = (handle) => ({
    query: (text, params = []) => handle.unsafe(text, params),
    exec: async (script) => {
      await handle.unsafe(script).simple();
    },
  });
  return {
    ...wrap(sql),
    transaction: (work) => sql.begin((tx) => work(wrap(tx))),
    end: () => sql.end({ timeout: 5 }),
  };
}

/** PGlite, for tests: the same methods over an in-process Postgres. */
export function fromPglite(pg) {
  const wrap = (handle) => ({
    query: async (text, params = []) => (await handle.query(text, params)).rows,
    exec: async (script) => {
      await handle.exec(script);
    },
  });
  return {
    ...wrap(pg),
    transaction: (work) => pg.transaction((tx) => work(wrap(tx))),
    end: () => pg.close(),
  };
}

/**
 * Counts the queries one request makes and the time they take, for the
 * timing record the proxy logs. The database's answer is unchanged.
 */
export function measured(db) {
  const stats = { queries: 0, dbMs: 0 };
  const time = (handle) => ({
    query: async (text, params) => {
      const started = performance.now();
      try {
        return await handle.query(text, params);
      } finally {
        stats.queries++;
        stats.dbMs += performance.now() - started;
      }
    },
    exec: handle.exec,
  });
  return {
    db: {
      ...time(db),
      transaction: (work) => db.transaction((tx) => work(time(tx))),
    },
    stats,
  };
}

/** Postgres's code for a lock not granted within lock_timeout. */
export const LOCK_NOT_AVAILABLE = "55P03";

/** Postgres's code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = "23505";

export const isUniqueViolation = (error, constraint) =>
  error?.code === UNIQUE_VIOLATION &&
  (!constraint ||
    error.constraint_name === constraint ||
    error.constraint === constraint);
