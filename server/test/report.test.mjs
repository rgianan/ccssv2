import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { reportInputs } from "../actions/google.mjs";
import { normalizePeriod } from "../periods.mjs";
import { buildReportWorkbook, sheetNameFor, wrappedLines } from "../report.mjs";
import { applyAnswerPolicy } from "../scores.mjs";
import { appsScript } from "./apps-script.mjs";
import { buildDataset, loadIntoDb } from "./dataset.mjs";
import { SERVICES, addServices, freshDatabase } from "./fixture.mjs";
import { googleStubs } from "./google-stubs.mjs";
import { spreadsheetStub } from "./sheet-stub.mjs";

/**
 * The CSM Summary Report built in Node (server/report.mjs) against the one
 * Report.gs builds in Sheets, from the same records: every sheet, in the same
 * order, with the same merges, freezes and column widths, and every visible
 * cell with the same value and the same look.
 *
 * Where the two can only differ in form, both are read the way the filed
 * workbook shows them: the apostrophe safeSheetValue_ puts before text that
 * starts like a formula is Sheets' own escape and never displayed; a number or
 * day Sheets made out of text is compared as that text; and the hidden cells
 * of a merge are not compared, since only the first one shows.
 */

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit";

let db, gas, sheets;

before(async () => {
  const data = buildDataset();
  db = await freshDatabase();
  await addServices(db);
  await loadIntoDb(db, data);
  await db.query(
    `insert into csm.settings (key, value) values
       ('report_reviewed_by', 'Reviewer'), ('report_reviewed_title', 'Chief'),
       ('report_approved_by', 'Director'), ('report_approved_title', 'Director IV')
     on conflict (key) do update set value = excluded.value`,
  );
  const google = googleStubs();
  sheets = spreadsheetStub();
  gas = appsScript({ services: SERVICES, google: google.globals });
  gas.call("SpreadsheetApp.create = __create", { __create: sheets.create });
});

// ------------------------------- Snapshots ------------------------------------

const hex = (color) =>
  color ? String(color).replace(/^#/, "").slice(-6).toUpperCase() : undefined;

/** The cells a merge hides: all but its first. */
function hiddenBy(merges) {
  const hidden = new Set();
  for (const m of merges)
    for (let r = m.top; r <= m.bottom; r++)
      for (let c = m.left; c <= m.right; c++)
        if (r !== m.top || c !== m.left) hidden.add(`${r},${c}`);
  return hidden;
}

const compact = (entry) =>
  Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) => value !== undefined && value !== false,
    ),
  );

function shown(value) {
  if (value === "" || value == null) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^'[=+\-@]/.test(value))
    return value.slice(1);
  return String(value);
}

function gasSnapshot(book) {
  return book.sheets.map((sheet) => {
    const hidden = hiddenBy(sheet.merges);
    const cells = {};
    for (const [at, cell] of sheet.cells) {
      if (hidden.has(at)) continue;
      const s = cell.style;
      const entry = compact({
        value: shown(cell.value),
        bold: s.bold,
        italic: s.italic,
        size: s.size,
        color: hex(s.color),
        fill: hex(s.fill),
        horizontal: s.horizontal,
        vertical: s.vertical,
        wrap: s.wrap,
        format: s.format,
      });
      if (Object.keys(entry).length) cells[at] = entry;
    }
    return {
      name: sheet.name,
      frozenRows: sheet.frozenRows,
      frozenColumns: sheet.frozenColumns,
      merges: sheet.merges
        .map((m) => `${m.top},${m.left}:${m.bottom},${m.right}`)
        .sort(),
      widths: sheet.widths,
      cells,
    };
  });
}

async function nodeSnapshot(bytes, widthsOf) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook.worksheets.map((worksheet) => {
    const merges = worksheet.model.merges.map((range) => {
      const [first, last] = range.split(":");
      const a = worksheet.getCell(first);
      const b = worksheet.getCell(last);
      return { top: a.row, left: a.col, bottom: b.row, right: b.col };
    });
    const hidden = hiddenBy(merges);
    const cells = {};
    worksheet.eachRow({ includeEmpty: true }, (row, r) =>
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const at = `${r},${c}`;
        if (hidden.has(at)) return;
        const font = cell.font || {};
        const format = cell.numFmt;
        const entry = compact({
          value: shown(cell.value),
          bold: font.bold,
          italic: font.italic,
          size: font.size && font.size !== 10 ? font.size : undefined,
          color: hex(font.color?.argb),
          fill: hex(cell.fill?.fgColor?.argb),
          horizontal: cell.alignment?.horizontal,
          vertical: cell.alignment?.vertical,
          wrap: cell.alignment?.wrapText,
          // Sheets made the transaction dates days by itself.
          format:
            format && format !== "General" && format !== "yyyy-mm-dd"
              ? format
              : undefined,
        });
        if (Object.keys(entry).length) cells[at] = entry;
      }),
    );
    const view = worksheet.views?.[0] || {};
    const widths = Object.fromEntries(
      Object.keys(widthsOf(worksheet.name) || {}).map((column) => [
        column,
        Math.round(worksheet.getColumn(Number(column)).width * 7 + 5),
      ]),
    );
    return {
      name: worksheet.name,
      frozenRows: view.ySplit || 0,
      frozenColumns: view.xSplit || 0,
      merges: merges
        .map((m) => `${m.top},${m.left}:${m.bottom},${m.right}`)
        .sort(),
      widths,
      cells,
    };
  });
}

/** Differences, worded for a reader: at most a dozen. */
function differences(node, apps) {
  const found = [];
  const say = (text) => found.length < 12 && found.push(text);
  const names = (list) => list.map((sheet) => sheet.name).join(", ");
  if (names(node) !== names(apps))
    say(`sheets: Node ${names(node)} | Report.gs ${names(apps)}`);
  for (const ours of node) {
    const theirs = apps.find((sheet) => sheet.name === ours.name);
    if (!theirs) continue;
    for (const key of ["frozenRows", "frozenColumns"])
      if (ours[key] !== theirs[key])
        say(`${ours.name} ${key}: ${ours[key]} | ${theirs[key]}`);
    if (ours.merges.join(" ") !== theirs.merges.join(" "))
      say(`${ours.name} merges: ${ours.merges} | ${theirs.merges}`);
    for (const [column, pixels] of Object.entries(theirs.widths))
      if (ours.widths[column] !== pixels)
        say(
          `${ours.name} column ${column}: ${ours.widths[column]}px | ${pixels}px`,
        );
    const keys = new Set([
      ...Object.keys(ours.cells),
      ...Object.keys(theirs.cells),
    ]);
    for (const at of keys) {
      const a = JSON.stringify(ours.cells[at] || {});
      const b = JSON.stringify(theirs.cells[at] || {});
      if (a !== b) say(`${ours.name} R${at.replace(",", "C")}: ${a} | ${b}`);
    }
  }
  return found;
}

// --------------------------------- The tests ----------------------------------

async function bothWorkbooks(periodInput) {
  const period = normalizePeriod(periodInput);
  const inputs = await reportInputs(db, period);
  const { settings, services, stats } = inputs;

  const built = await buildReportWorkbook({
    period,
    settings,
    services,
    records: applyAnswerPolicy(inputs.records, services),
    stats,
  });

  const before = sheets.books.length;
  gas.call(
    `buildReportWorkbook_(normalizePeriod_(__period), __settings, __services,
       applyAnswerPolicy_(__records, __services), __stats,
       workerFolder_('', 'OSDS CSM Reports'), 'staff@ched.gov.ph', [])`,
    {
      // Through JSON, as the worker receives them.
      __period: JSON.parse(JSON.stringify(periodInput)),
      __settings: JSON.parse(JSON.stringify(settings)),
      __services: JSON.parse(JSON.stringify(services)),
      __records: JSON.parse(JSON.stringify(inputs.records)),
      __stats: JSON.parse(JSON.stringify(stats)),
    },
  );
  const book = sheets.books[before];
  const apps = gasSnapshot(book);
  const node = await nodeSnapshot(
    built.bytes,
    (name) => book.sheets.find((sheet) => sheet.name === name)?.widths,
  );
  return { built, node, apps, inputs, period, book };
}

describe("the workbook matches Report.gs's, cell for cell", () => {
  for (const period of [
    { type: "quarter", year: 2026, quarter: 3 },
    { type: "quarter", year: 2026, quarter: 2 },
    { type: "quarter", year: 2025, quarter: 4 },
    { type: "year", year: 2026 },
  ])
    test(JSON.stringify(period), async () => {
      const { built, node, apps, inputs, book } = await bothWorkbooks(period);
      assert.ok(inputs.records.length > 0, "the period has responses");
      assert.equal(built.name, `${book.name}.xlsx`);
      assert.deepEqual(differences(node, apps), []);
      // And it is the whole workbook, not two empty ones agreeing.
      const summary = node.find((sheet) => sheet.name === "CSM Summary");
      assert.ok(Object.keys(summary.cells).length > 200);
      const data = node.find((sheet) => sheet.name === "DATA");
      assert.equal(
        Object.keys(data.cells).filter((at) => at.endsWith(",21")).length,
        inputs.records.length + 1,
        "one DATA row per response, under the header",
      );
    });
});

describe("the workbook itself", () => {
  test("text that starts like a formula is text, never a formula", async () => {
    const { built } = await bothWorkbooks({
      type: "quarter",
      year: 2026,
      quarter: 3,
    });
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(built.bytes);
    let formulas = 0;
    let suggestion = null;
    for (const worksheet of workbook.worksheets)
      worksheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (cell.formula || cell.type === ExcelJS.ValueType.Formula)
            formulas++;
          if (String(cell.value).includes("=SUM(A1)")) suggestion = cell;
        }),
      );
    assert.equal(formulas, 0);
    assert.ok(suggestion, "the dataset's =SUM(A1) suggestion is in it");
    assert.equal(suggestion.type, ExcelJS.ValueType.String);
  });

  test("numbers are numbers, and transaction dates are days", async () => {
    const { built } = await bothWorkbooks({
      type: "quarter",
      year: 2026,
      quarter: 3,
    });
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(built.bytes);
    const data = workbook.getWorksheet("DATA");
    const row = data.getRow(2);
    assert.equal(typeof row.getCell(7).value, "number", "CC1");
    assert.ok(row.getCell(22).value instanceof Date, "Transaction Date");
    assert.equal(row.getCell(22).numFmt, "yyyy-mm-dd");
    const summary = workbook.getWorksheet("CSM Summary");
    assert.equal(summary.getCell(8, 7).type, ExcelJS.ValueType.Number);
  });

  test("a heading that wraps in merged cells is given the rows it needs", async () => {
    const { built } = await bothWorkbooks({ type: "year", year: 2026 });
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(built.bytes);
    const summary = workbook.getWorksheet("CSM Summary");
    let headerRow = 0;
    summary.eachRow((row, number) => {
      if (row.getCell(3).value === "(SQD0)") headerRow = number;
    });
    assert.ok(headerRow, "the dimension headings are on the sheet");
    assert.ok(
      summary.getRow(headerRow).height >= 39,
      "three lines for Reliability (Quality) over (SQD2)",
    );
    assert.ok(summary.getRow(1).height >= 20, "the 14-point title");
  });

  test("sheet names stay unique, short and clear of DATA", () => {
    const taken = ["CSM Summary"];
    assert.equal(sheetNameFor("data", taken), "DATA2");
    assert.equal(sheetNameFor("E-CAV", taken), "ECAV");
    assert.equal(sheetNameFor("ecav", taken), "ECAV2");
    assert.equal(sheetNameFor("", taken), "SERVICE");
    assert.equal(sheetNameFor("x".repeat(40), taken), "X".repeat(26));
    assert.equal(sheetNameFor("X".repeat(30), taken), `${"X".repeat(24)}2`);
  });

  test("wrapping is counted word by word", () => {
    assert.equal(wrappedLines("Reliability (Quality)", 17), 2);
    assert.equal(wrappedLines("Reliability (Quality)\n(SQD2)", 17), 3);
    assert.equal(wrappedLines("short", 17), 1);
    assert.equal(wrappedLines("", 17), 1);
    // A word longer than a line runs on over as many lines as it needs.
    assert.equal(wrappedLines("x".repeat(40), 17), 3);
    assert.equal(wrappedLines(`ab ${"x".repeat(40)}`, 17), 4);
  });

  test("no row is taller than Excel allows, even for the longest suggestion", async () => {
    const period = normalizePeriod({ type: "quarter", year: 2026, quarter: 3 });
    const inputs = await reportInputs(db, period);
    const records = applyAnswerPolicy(inputs.records, inputs.services);
    // The form keeps 1,500 characters.
    records[0] = {
      ...records[0],
      suggestions: "Please add more chairs. ".repeat(63).slice(0, 1500),
    };
    const built = await buildReportWorkbook({
      period,
      settings: inputs.settings,
      services: inputs.services,
      records,
      stats: inputs.stats,
    });
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(built.bytes);
    let tallest = 0;
    for (const worksheet of workbook.worksheets)
      worksheet.eachRow((row) => {
        tallest = Math.max(tallest, row.height || 0);
      });
    assert.equal(tallest, 409);
  });
});
