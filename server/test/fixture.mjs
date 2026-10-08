import { PGlite } from "@electric-sql/pglite";
import { fromPglite } from "../db.mjs";
import { migrate } from "../migrate.mjs";

/**
 * A fresh Postgres, inside this process, with every migration applied: the
 * same schema files production runs, against the same engine.
 */
export async function freshDatabase() {
  const db = fromPglite(await PGlite.create());
  await migrate(db);
  return db;
}

/** Programmes with fixed ids, so a test can name them. */
export const SERVICES = [
  {
    service_id: "S-CHARGES",
    code: "CEM/CED",
    name_en: "Certification",
    category: "main",
    has_fees: true,
    sort_order: 10,
  },
  {
    service_id: "S-FREE",
    code: "SIAP 1",
    name_en: "Internship",
    category: "main",
    has_fees: false,
    sort_order: 20,
  },
  {
    service_id: "S-OTHER",
    code: "OTHER",
    name_en: "Other Services",
    category: "other",
    has_fees: false,
    sort_order: 30,
  },
  {
    service_id: "S-GONE",
    code: "OLD",
    name_en: "Withdrawn",
    category: "main",
    has_fees: false,
    sort_order: 40,
    active: false,
  },
];

export async function addServices(db, services = SERVICES) {
  for (const s of services)
    await db.query(
      `insert into csm.services (service_id, code, name_en, name_tl, category, active, has_fees, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        s.service_id,
        s.code,
        s.name_en,
        s.name_tl || "",
        s.category,
        s.active !== false,
        s.has_fees,
        s.sort_order,
      ],
    );
}

/** A form that passes every check; tests override what they are about. */
export const validForm = (over = {}) => ({
  email: "client@example.ph",
  clientType: "Citizen",
  transactionDate: "2026-09-16",
  sex: "Female",
  age: "30",
  region: "National Capital Region",
  serviceId: "S-FREE",
  cc1: "1",
  cc2: "2",
  cc3: "1",
  sqd0: "5",
  sqd1: "5",
  sqd2: "4",
  sqd3: "5",
  sqd4: "5",
  sqd5: "N/A",
  sqd6: "5",
  sqd7: "3",
  sqd8: "5",
  suggestions: "",
  language: "en",
  privacyNoticeVersion: "1.1",
  ...over,
});

/** 2026-10-08 10:00 in Manila. */
export const NOW = new Date("2026-10-08T02:00:00Z");
