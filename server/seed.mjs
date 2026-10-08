import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { database } from "./db.mjs";

/**
 * What setupCsmSheets puts in a new spreadsheet, for a new database: the
 * default programmes and the settings keys. Only what is missing is added —
 * programmes matched by code, settings by key — so running it again, or on a
 * database the import has filled, changes nothing.
 *
 *   npm run db:seed          (reads DATABASE_URL from .env or .env.local)
 */

export const DEFAULT_SERVICES = [
  {
    code: "CEM/CED",
    name_en:
      "Application for Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)",
    name_tl:
      "Aplikasyon para sa Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)",
    category: "main",
    has_fees: true,
  },
  {
    code: "SIAP 1",
    name_en: "Application for Student Internship Program (SIAP) Phase 1",
    name_tl: "Aplikasyon para sa Student Internship Program (SIAP) Phase 1",
    category: "main",
  },
  {
    code: "SIAP 2",
    name_en: "Application for Student Internship Program (SIAP) Phase 2",
    name_tl: "Aplikasyon para sa Student Internship Program (SIAP) Phase 2",
    category: "main",
  },
  {
    code: "BI INDORSEMENT",
    name_en:
      "Request for Endorsement for Conversion/Extension of Visa of Foreign Students to the Bureau of Immigration",
    name_tl:
      "Kahilingan para sa Endorsement para sa Conversion/Extension ng Visa ng mga Dayuhang Estudyante sa Bureau of Immigration",
    category: "main",
  },
  {
    code: "OTHER",
    name_en: "Other Services",
    name_tl: "Iba pang Serbisyo",
    category: "other",
  },
];

export const DEFAULT_SETTINGS = {
  office_name: "Office of Student Development and Services (OSDS)",
  coa_signatory: "",
  coa_designation: "",
  report_prepared_by: "",
  report_prepared_title: "",
  report_reviewed_by: "",
  report_reviewed_title: "",
  report_approved_by: "",
  report_approved_title: "",
};

export async function seed(db) {
  const added = { services: [], settings: [] };
  await db.transaction(async (tx) => {
    for (const [index, service] of DEFAULT_SERVICES.entries()) {
      const rows = await tx.query(
        `insert into csm.services (service_id, code, name_en, name_tl, category, has_fees, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (code) do nothing
         returning code`,
        [
          `S-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
          service.code,
          service.name_en,
          service.name_tl,
          service.category,
          service.has_fees === true,
          (index + 1) * 10,
        ],
      );
      if (rows.length) added.services.push(service.code);
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const rows = await tx.query(
        "insert into csm.settings (key, value) values ($1, $2) on conflict (key) do nothing returning key",
        [key, value],
      );
      if (rows.length) added.settings.push(key);
    }
  });
  return added;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = database();
  try {
    const added = await seed(db);
    console.log(
      `Programmes added: ${added.services.join(", ") || "none missing"}\n` +
        `Settings added: ${added.settings.join(", ") || "none missing"}`,
    );
  } finally {
    await db.end();
  }
}
