import { parseArgs } from "node:util";
import { database } from "./db.mjs";
import { loadImport } from "./import/load.mjs";
import { printProblems, readExportFile } from "./import/report.mjs";
import { transformExport } from "./import/transform.mjs";

/**
 * Phase 3 of the migration: loads an export from Export.gs into the database.
 *
 *   npm run db:import -- .import/export.json
 *     A dry run: what would be loaded, and every problem found. Writes nothing.
 *   npm run db:import -- .import/export.json --apply
 *     Loads it, all or nothing. Refuses if the database already holds data.
 *   npm run db:import -- .import/export.json --apply --replace
 *     Clears the portal's tables first — for a rehearsal's database, or the
 *     final import at cutover.
 *
 * Set AUDIT_HASH_SECRET (from the Apps Script project's script properties)
 * to have the audit chain checked on the way in. Then run npm run db:verify.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: "boolean", default: false },
    replace: { type: "boolean", default: false },
  },
});

try {
  const data = readExportFile(positionals[0]);
  const out = transformExport(data, {
    auditSecret: String(process.env.AUDIT_HASH_SECRET || ""),
  });
  const t = out.tables;
  const added = t.services.filter(
    (s) => s.sort_order === 9990 && !s.active,
  ).length;
  console.log(
    `Export of ${data.exportedAt} (script zone ${out.zones.script}, spreadsheet zone ${out.zones.spreadsheet}).`,
  );
  console.log(
    `To load: ${t.responses.length} responses, ${t.services.length} programs` +
      `${added ? ` (${added} added as withdrawn)` : ""}, ${t.settings.length} settings, ` +
      `${t.serviceStats.length} statistics rows, ${t.reports.length} reports, ` +
      `${t.adminUsers.length} administrators, ${t.auditLog.length} audit entries.`,
  );
  console.log(
    !out.chain.checked
      ? "Audit chain: not checked — set AUDIT_HASH_SECRET to check it."
      : out.chain.intact
        ? "Audit chain: intact, and it ends on the recorded head."
        : `Audit chain: already broken in the sheet (${out.chain.broken.reason}${out.chain.broken.row ? `, row ${out.chain.broken.row}` : ""}).`,
  );
  printProblems(out.problems);
  const errors = out.problems.filter((p) => p.level === "error").length;

  if (!options.apply) {
    console.log(
      errors
        ? "\nDry run only. Correct the errors in the sheet, export again, then run with --apply."
        : "\nDry run only. Run again with --apply to load it.",
    );
    process.exitCode = errors ? 1 : 0;
  } else if (errors) {
    console.log(
      "\nNot loaded: correct the errors above in the sheet and export again.",
    );
    process.exitCode = 1;
  } else {
    const db = database();
    try {
      const result = await loadImport(db, t, { replace: options.replace });
      if (result.replaced)
        console.log(`\nCleared first: ${JSON.stringify(result.replaced)}`);
      console.log(`Loaded: ${JSON.stringify(result.loaded)}`);
      console.log(`\nNext: npm run db:verify -- ${positionals[0]}`);
    } finally {
      await db.end();
    }
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
