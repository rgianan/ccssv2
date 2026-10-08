import { database } from "./db.mjs";
import { readExportFile } from "./import/report.mjs";
import { transformExport } from "./import/transform.mjs";
import { verifyImport } from "./import/verify.mjs";

/**
 * Phase 3 of the migration: after an import, asks Apps Script (over the
 * export) and the new backend (over the database) every admin read and
 * compares the answers. Writes nothing.
 *
 *   npm run db:verify -- .import/export.json
 *
 * Set AUDIT_HASH_SECRET as for the import, so both check the audit chain.
 */

try {
  const file = process.argv[2];
  const data = readExportFile(file);
  const auditSecret = String(process.env.AUDIT_HASH_SECRET || "");
  const transformed = transformExport(data, { auditSecret });
  const db = database();
  let outcome;
  try {
    outcome = await verifyImport({ db, data, transformed, auditSecret });
  } finally {
    await db.end();
  }
  let different = 0;
  for (const r of outcome.results) {
    if (r.same) console.log(`same       ${r.check}`);
    else {
      different++;
      console.log(
        `DIFFERENT  ${r.check}: ${r.differences} difference(s), e.g. ${r.examples.join("; ")}`,
      );
    }
  }
  const k = outcome.known;
  console.log(
    `\nKnown differences, already matched up: ` +
      `${k.longIssueTimes} certificate issue time(s) Apps Script showed as a long date, ` +
      `${k.blankAnswers} response(s) with blank answers now stored as N/A, ` +
      `${k.invalidAges} response(s) with an age outside 1–120 now N/A.`,
  );
  console.log(
    different
      ? `\n${different} of ${outcome.results.length} checks differ.`
      : `\nAll ${outcome.results.length} checks give the same answers.`,
  );
  process.exitCode = different ? 1 : 0;
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
