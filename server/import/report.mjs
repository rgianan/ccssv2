import { readFileSync } from "node:fs";

/** Reads an export file named on the command line. */
export function readExportFile(path) {
  if (!path)
    throw new Error(
      "Name the export file, for example: npm run db:import -- .import/export.json",
    );
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path} as an export (${error.message}).`);
  }
  return data;
}

/**
 * Problems grouped by kind, each with how many rows it touched and where —
 * row numbers and references only, never what the rows hold.
 */
export function printProblems(problems) {
  if (!problems.length) {
    console.log("Problems: none.");
    return;
  }
  const groups = new Map();
  for (const p of problems) {
    const ref = /^(CSM-[^:]+): /.exec(p.message);
    const message = ref ? p.message.slice(ref[0].length) : p.message;
    const key = `${p.level}|${p.sheet}|${p.field}|${message}`;
    if (!groups.has(key))
      groups.set(key, { ...p, message, rows: [], refs: [] });
    const group = groups.get(key);
    if (p.row) group.rows.push(p.row);
    if (ref) group.refs.push(ref[1]);
  }
  const order = { error: 0, warning: 1, fixed: 2 };
  const counts = { error: 0, warning: 0, fixed: 0 };
  for (const p of problems) counts[p.level]++;
  console.log(
    `Problems: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.fixed} fixed on the way in.`,
  );
  for (const g of [...groups.values()].sort(
    (a, b) => order[a.level] - order[b.level],
  )) {
    const n = Math.max(g.rows.length, g.refs.length, 1);
    const where = g.refs.length
      ? ` — ${g.refs.slice(0, 5).join(", ")}${g.refs.length > 5 ? ", …" : ""}`
      : g.rows.length
        ? ` — row${g.rows.length > 1 ? "s" : ""} ${g.rows.slice(0, 8).join(", ")}${g.rows.length > 8 ? ", …" : ""}`
        : "";
    console.log(
      `  [${g.level}] ${g.sheet} · ${g.field}: ${g.message} (${n})${where}`,
    );
  }
}
