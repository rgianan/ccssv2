import { officeDay } from "./dates.mjs";
import {
  AGE_BRACKETS,
  SQD_KEYS,
  ageBracketOf,
  meanOf,
  medianOf,
  ratingsOf,
  safeTrim,
} from "./records.mjs";
import { round2 } from "./scores.mjs";

/**
 * The CSM Summary Report workbook, in the ARTA layout the office files: a CSM
 * Summary sheet, one worksheet per main programme (and one for Other
 * Services), and a DATA sheet of the raw responses.
 *
 * Report.gs built it cell by cell in a scratch Google Sheet, then had Drive
 * export that as .xlsx. Every one of those cells was a call into Sheets, and
 * the build ran close to the minute a request may take. This writes the
 * .xlsx directly, the same sheets, rows, merges and formats, in a fraction of
 * a second; the worker only files the result in Drive. report.test.mjs holds
 * the two builders to the same workbook, cell for cell.
 *
 * Records arrive already read through applyAnswerPolicy, as Report.gs had
 * them, and every number on the sheets comes from the same rules the
 * dashboard uses.
 */

export const SQD_DIMENSIONS = [
  {
    key: "sqd0",
    number: "SQD0",
    dimension: "",
    en: "I am satisfied with the service that I availed.",
    tl: "Nasiyahan ako sa serbisyo na aking natanggap sa napuntahang tanggapan.",
  },
  {
    key: "sqd1",
    number: "SQD1",
    dimension: "Responsiveness",
    en: "I spent a reasonable amount of time for my transaction.",
    tl: "Makatwiran ang oras na aking ginugol para sa pagproseso ng aking transaksyon.",
  },
  {
    key: "sqd2",
    number: "SQD2",
    dimension: "Reliability (Quality)",
    en: "The office followed the transaction's requirements and steps based on the information provided.",
    tl: "Ang opisina ay sumusunod sa mga kinakailangang dokumento at mga hakbang batay sa impormasyong ibinigay.",
  },
  {
    key: "sqd3",
    number: "SQD3",
    dimension: "Access & Facilities",
    en: "The steps (including payment) I needed to do for my transaction were easy and simple.",
    tl: "Ang mga hakbang sa pagproseso, kasama na ang pagbabayad, ay madali at simple.",
  },
  {
    key: "sqd4",
    number: "SQD4",
    dimension: "Communication",
    en: "I easily found information about my transaction from the office or its website.",
    tl: "Mabilis at madali akong nakahanap ng impormasyon tungkol sa aking transaksyon mula sa opisina o sa website nito.",
  },
  {
    key: "sqd5",
    number: "SQD5",
    dimension: "Costs",
    en: "I paid a reasonable amount of fees for my transaction.",
    tl: "Nagbayad ako ng makatwirang halaga ng bayarin para sa aking transaksyon.",
  },
  {
    key: "sqd6",
    number: "SQD6",
    dimension: "Integrity",
    en: "I feel the office was fair to everyone, or walang palakasan, during my transaction.",
    tl: "Pakiramdam ko ay patas ang opisina sa lahat, o walang palakasan, sa aking transaksyon.",
  },
  {
    key: "sqd7",
    number: "SQD7",
    dimension: "Assurance",
    en: "I was treated courteously by the staff, and (if asked for help) the staff was helpful.",
    tl: "Magalang akong trinato ng mga tauhan, at (kung sakaling ako ay humingi ng tulong) alam ko na sila ay handang tumulong sa akin.",
  },
  {
    key: "sqd8",
    number: "SQD8",
    dimension: "Outcome",
    en: "I got what I needed from the government office, or (if denied) denial of request was sufficiently explained to me.",
    tl: "Nakuha ko ang klase ng serbisyo na kailangan ko mula sa tanggapang ito, o (kung tinanggihan) sapat na naipaliwanag sa akin ang dahilan.",
  },
];

/**
 * The numbered choices each Charter question offers, which must match
 * CC_QUESTIONS in src/lib/csm.js; N/A gets its own column, and only where the
 * question can be skipped. CC_LABELS_ in Report.gs explains why.
 */
const CC_LABELS = {
  cc1: {
    text: "CC1. Which of the following best describes your awareness of the CC?",
    options: ["1", "2", "3", "4"],
    na: false,
  },
  cc2: {
    text: "CC2. If aware of CC (answered 1-3 in CC1), would you say that the CC of this office was…",
    options: ["1", "2", "3", "4"],
    na: true,
  },
  cc3: {
    text: "CC3. If aware of CC (answered 1-3 in CC1), how much did the CC help you in your transaction?",
    options: ["1", "2", "3"],
    na: true,
  },
};

const REGION_ORDER = [
  "I",
  "II",
  "III",
  "IV-A",
  "IV-B",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "NCR",
  "CAR",
  "CARAGA",
  "BARMM",
  "NIR",
];

const DEFAULT_OFFICE = "Office of Student Development and Services (OSDS)";

const FONT = { name: "Arial", size: 10 };

// The portal's own blues, as Report.gs used them.
const BRAND = "FF0032A0";
const HEADER_FILL = "FFD2E1F7";
const BAND_FILL = "FFEBF4FC";
const WHITE = "FFFFFFFF";
const NOTE = "FF66748A";

// The SQD block on the CSM Summary sheet: column C starts a mean/median pair
// per dimension.
const SQD_FIRST_COLUMN = 3;
const OVERALL_COLUMN = SQD_FIRST_COLUMN + SQD_DIMENSIONS.length * 2; // U
const RESPONDENTS_COLUMN = OVERALL_COLUMN + 1; // V
const CLIENTS_COLUMN = OVERALL_COLUMN + 2; // W
const TRANSACTIONS_COLUMN = OVERALL_COLUMN + 3; // X
const REMARKS_COLUMN = OVERALL_COLUMN + 4; // Y

// ------------------------------ The figures -----------------------------------

/**
 * A dimension with no ratings behind it is a question that did not apply, not
 * a zero: printed as 0.00 it would read as the worst possible score.
 */
export const dimensionStat = (values, statistic) =>
  ratingsOf(values).length ? round2(statistic(values)) : "N/A";

/** The Overall Score cell, by the same rule as the dimension cells beside it. */
const overallStat = (records) =>
  dimensionStat(
    records.flatMap((record) => SQD_KEYS.map((key) => record[key])),
    meanOf,
  );

const blank = (value) => value === "" || value == null;

/**
 * The office counts for the Other Services row, pooled across every
 * 'other'-category programme as its responses are; a count nobody entered
 * stays blank rather than becoming 0.
 */
function pooledStat(serviceList, stats) {
  const pooled = { clients: "", transactions: "", remarks: "" };
  const remarks = [];
  for (const service of serviceList) {
    const stat = stats[service.service_id];
    if (!stat) continue;
    for (const key of ["clients", "transactions"])
      if (!blank(stat[key]))
        pooled[key] = (Number(pooled[key]) || 0) + (Number(stat[key]) || 0);
    if (stat.remarks)
      remarks.push(
        serviceList.length > 1
          ? `${service.code}: ${stat.remarks}`
          : stat.remarks,
      );
  }
  pooled.remarks = remarks.join("; ");
  return pooled;
}

/**
 * The main programmes given a row and a sheet: every active one, and a
 * withdrawn one only when the period shows it was still in use.
 */
export function reportedMainServices(services, records, stats) {
  return services.filter((service) => {
    if (service.category !== "main") return false;
    if (service.active !== false) return true;
    const stat = (stats || {})[service.service_id];
    const countsEntered =
      !!stat &&
      (safeTrim(stat.clients) !== "" || safeTrim(stat.transactions) !== "");
    return (
      countsEntered ||
      records.some((record) => record.serviceId === service.service_id)
    );
  });
}

/** Responses under no main programme, which the Other Services row pools. */
const otherRecordsOf = (services, records) =>
  records.filter(
    (record) =>
      !services.some(
        (service) =>
          service.category === "main" &&
          service.service_id === record.serviceId,
      ),
  );

function countBy(records, accessor) {
  const counts = {};
  for (const record of records) {
    const key = accessor(record) || "N/A";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** A rating as the sheets print one: the number, or N/A. */
const ratingCell = (value) => {
  const score = Number(value);
  return score >= 1 && score <= 5 ? score : "N/A";
};

// ----------------------------- Writing cells ----------------------------------

/** Sheets measures columns in pixels and Excel in characters of about 7px. */
const widthOf = (pixels) => Math.round(((pixels - 5) / 7) * 100) / 100;
const SHEETS_DEFAULT_WIDTH = 100;

/**
 * Report.gs's sheet calls, over exceljs: getRange(row, column, rows, columns)
 * and the setters it chained, so each builder below reads as its original.
 * A value is stored as what it is. A string is a string and never a formula,
 * which is why nothing here needs the apostrophe safeSheetValue_ put in front
 * of text: Sheets read a leading "=" as a formula, an .xlsx string cell does
 * not.
 */
function sheetOf(worksheet) {
  const widths = {};
  const merges = [];
  // Every cell written or styled gets the whole font, Arial 10 as the Sheets
  // export had it: a font naming only "bold" leaves Excel to guess the rest,
  // and a cell given only a fill would show in Excel's own default.
  const cell = (row, column) => {
    const target = worksheet.getCell(row, column);
    if (!target.font) target.font = { ...FONT };
    return target;
  };
  const write = (target, value) => {
    target.value = blank(value) ? null : value;
  };
  function range(row, column, rows = 1, columns = 1) {
    const each = (work) => {
      for (let r = row; r < row + rows; r++)
        for (let c = column; c < column + columns; c++) work(cell(r, c));
    };
    const patch = (key, changes) =>
      each((target) => {
        target[key] = { ...(target[key] || {}), ...changes };
      });
    const self = {
      merge() {
        const bottom = row + rows - 1;
        const right = column + columns - 1;
        worksheet.mergeCells(row, column, bottom, right);
        merges.push({ top: row, left: column, bottom, right });
        return self;
      },
      setValue(value) {
        write(cell(row, column), value);
        return self;
      },
      setValues(grid) {
        grid.forEach((line, i) =>
          line.forEach((value, j) => write(cell(row + i, column + j), value)),
        );
        return self;
      },
      bold: () => (patch("font", { bold: true }), self),
      italic: () => (patch("font", { italic: true }), self),
      size: (points) => (patch("font", { size: points }), self),
      color: (argb) => (patch("font", { color: { argb } }), self),
      fill: (argb) => (
        each((target) => {
          target.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb },
          };
        }),
        self
      ),
      align: (horizontal, vertical) => (
        patch("alignment", {
          ...(horizontal && { horizontal }),
          ...(vertical && { vertical }),
        }),
        self
      ),
      wrap: () => (patch("alignment", { wrapText: true }), self),
      format: (numFmt) => (
        each((target) => {
          target.numFmt = numFmt;
        }),
        self
      ),
    };
    return self;
  }
  return {
    worksheet,
    range,
    widths,
    merges,
    setColumnWidth(column, pixels) {
      widths[column] = pixels;
      worksheet.getColumn(column).width = widthOf(pixels);
    },
    freeze(xSplit, ySplit) {
      worksheet.views = [{ state: "frozen", xSplit, ySplit }];
    },
  };
}

const writeRow = (sheet, row, column, values) =>
  values.length &&
  sheet.range(row, column, 1, values.length).setValues([values]);

const styleHeaderRow = (sheet, row, column, width) =>
  sheet
    .range(row, column, 1, width)
    .bold()
    .fill(HEADER_FILL)
    .color(BRAND)
    .align("center", "middle")
    .wrap();

const styleSectionRow = (sheet, row, width) =>
  sheet.range(row, 1, 1, width).bold().fill(BRAND).color(WHITE);

/**
 * Row heights for wrapped text. Sheets measured each row when it exported the
 * workbook; an .xlsx written directly carries none, and Excel does not grow a
 * row for text wrapping in a merged cell. This estimates each wrapped row's
 * lines from its text and its columns' widths: Arial 10 runs about 6.5px a
 * character and 13 points a line.
 */
function fitWrappedRows(sheet) {
  const { worksheet, widths, merges } = sheet;
  const pixels = (column) => widths[column] ?? SHEETS_DEFAULT_WIDTH;
  const spans = new Map();
  const hidden = new Set();
  for (const merge of merges) {
    let width = 0;
    for (let c = merge.left; c <= merge.right; c++) width += pixels(c);
    spans.set(`${merge.top},${merge.left}`, {
      width,
      rows: merge.bottom - merge.top + 1,
    });
    for (let r = merge.top; r <= merge.bottom; r++)
      for (let c = merge.left; c <= merge.right; c++)
        if (r !== merge.top || c !== merge.left) hidden.add(`${r},${c}`);
  }
  worksheet.eachRow((row, rowNumber) => {
    let lines = 1;
    row.eachCell((target, column) => {
      const at = `${rowNumber},${column}`;
      if (!target.alignment?.wrapText || hidden.has(at)) return;
      const text = target.value == null ? "" : String(target.value);
      if (!text) return;
      const span = spans.get(at);
      const perLine = Math.max(
        1,
        Math.floor(((span?.width ?? pixels(column)) - 8) / 6.5),
      );
      const needed = text
        .split("\n")
        .reduce(
          (sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)),
          0,
        );
      lines = Math.max(lines, Math.ceil(needed / (span?.rows ?? 1)));
    });
    if (lines > 1) row.height = Math.max(15, lines * 13);
  });
}

// ---------------------------- CSM Summary sheet -------------------------------

function buildSummarySheet(
  workbook,
  period,
  settings,
  services,
  records,
  stats,
) {
  const sheet = sheetOf(workbook.addWorksheet("CSM Summary"));
  const width = REMARKS_COLUMN;

  // Two merges with the seam at the frozen columns, as in Report.gs: Sheets
  // would not freeze a column that cut a merged title in half.
  sheet
    .range(1, 1, 1, SQD_FIRST_COLUMN - 1)
    .merge()
    .fill(BRAND);
  sheet
    .range(1, SQD_FIRST_COLUMN, 1, width - SQD_FIRST_COLUMN + 1)
    .merge()
    .setValue("CHED CLIENT SATISFACTION MEASUREMENT REPORT")
    .size(14)
    .bold()
    .align("center")
    .fill(BRAND)
    .color(WHITE);
  // The 14-point title sits in merged cells, which Excel does not grow for.
  sheet.worksheet.getRow(1).height = 22;
  sheet
    .range(3, 2)
    .setValue(`OFFICE:   ${settings.office_name || DEFAULT_OFFICE}`)
    .bold();
  sheet
    .range(4, 2)
    .setValue(
      `${period.type === "year" ? "PERIOD:   " : "QUARTER:   "}${period.label}`,
    )
    .bold();

  // ---- I. Demographic questions ----
  sheet.range(6, 1).setValue("I.").bold();
  sheet.range(6, 2).setValue("DEMOGRAPHIC QUESTIONS");
  styleSectionRow(sheet, 6, width);

  const clientTypes = countBy(records, (record) => record.clientType);
  writeRow(sheet, 7, 3, [
    "No. of Citizen",
    "No. of Business",
    "No. of Government",
    "N/A",
    "Total",
  ]);
  styleHeaderRow(sheet, 7, 3, 5);
  sheet.range(8, 2).setValue("1. Client Type").bold();
  writeRow(sheet, 8, 3, [
    clientTypes.CITIZEN || 0,
    clientTypes.BUSINESS || 0,
    clientTypes.GOVERNMENT || 0,
    clientTypes["N/A"] || 0,
    records.length,
  ]);

  const sexes = countBy(records, (record) => record.sex);
  writeRow(sheet, 10, 3, ["No. of Male", "No. of Female", "N/A", "Total"]);
  styleHeaderRow(sheet, 10, 3, 4);
  sheet.range(11, 2).setValue("2. Sex").bold();
  writeRow(sheet, 11, 3, [
    sexes.MALE || 0,
    sexes.FEMALE || 0,
    sexes["N/A"] || 0,
    records.length,
  ]);

  const brackets = countBy(records, (record) => ageBracketOf(record.age));
  const bracketLabels = AGE_BRACKETS.map((bracket) => bracket.label);
  writeRow(sheet, 13, 3, [
    ...bracketLabels.map((label) => `No. of ${label}`),
    "N/A",
    "Total",
  ]);
  styleHeaderRow(sheet, 13, 3, 6);
  sheet.range(14, 2).setValue("3. Age").bold();
  writeRow(sheet, 14, 3, [
    ...bracketLabels.map((label) => brackets[label] || 0),
    brackets["N/A"] || 0,
    records.length,
  ]);

  const regions = countBy(records, (record) => record.regionCode);
  writeRow(sheet, 16, 3, [...REGION_ORDER, "N/A", "Total"]);
  styleHeaderRow(sheet, 16, 3, REGION_ORDER.length + 2);
  sheet.range(17, 2).setValue("4. Region of Residence").bold();
  writeRow(sheet, 17, 3, [
    ...REGION_ORDER.map((code) => regions[code] || 0),
    regions["N/A"] || 0,
    records.length,
  ]);

  // ---- II. Citizen's Charter ----
  sheet.range(19, 1).setValue("II.").bold();
  sheet.range(19, 2).setValue("QUESTIONS RELATED TO THE CITIZEN'S CHARTER");
  styleSectionRow(sheet, 19, width);
  sheet.range(20, 2).setValue("*Opt stands for Option").italic();

  let row = 21;
  for (const key of ["cc1", "cc2", "cc3"]) {
    const meta = CC_LABELS[key];
    const counts = countBy(records, (record) => record[key] || "N/A");
    const counted = meta.options.map((option) => counts[option] || 0);
    if (meta.na) counted.push(counts["N/A"] || 0);
    counted.push(records.length);
    const headers = [
      ...meta.options.map((option) => `Opt ${option}`),
      ...(meta.na ? ["N/A", "Total"] : ["Total"]),
    ];
    writeRow(sheet, row, 3, headers);
    styleHeaderRow(sheet, row, 3, headers.length);
    sheet
      .range(row + 1, 2)
      .setValue(meta.text)
      .wrap();
    writeRow(sheet, row + 1, 3, counted);
    row += 3;
  }

  // ---- III. Service Quality Dimensions ----
  const sqdSectionRow = row;
  sheet.range(sqdSectionRow, 1).setValue("III.").bold();
  sheet.range(sqdSectionRow, 2).setValue("SERVICE QUALITY DIMENSIONS (SQD)");
  styleSectionRow(sheet, sqdSectionRow, width);

  const titleRow = sqdSectionRow + 1;
  const headerRow = titleRow + 1;
  const subRow = headerRow + 1;
  const firstDataRow = subRow + 1;
  sheet.range(titleRow, 2).setValue("Service Name").bold();
  sheet
    .range(titleRow, SQD_FIRST_COLUMN, 1, SQD_DIMENSIONS.length * 2)
    .merge()
    .setValue("Nine (9) service dimensions rating (1-5 Likert Scale)")
    .bold()
    .align("center")
    .fill(BAND_FILL);

  SQD_DIMENSIONS.forEach((dimension, index) => {
    const column = SQD_FIRST_COLUMN + index * 2;
    sheet
      .range(headerRow, column, 1, 2)
      .merge()
      .setValue(
        `${dimension.dimension ? `${dimension.dimension}\n` : ""}(${dimension.number})`,
      );
    sheet.range(subRow, column).setValue("Mean");
    sheet.range(subRow, column + 1).setValue("Median");
  });
  for (const [column, label] of [
    [OVERALL_COLUMN, "Overall Score"],
    [RESPONDENTS_COLUMN, "¹No. of Respondents"],
    [CLIENTS_COLUMN, "²No. of Clients"],
    [TRANSACTIONS_COLUMN, "³Volume of Transactions"],
    [REMARKS_COLUMN, "Remarks"],
  ])
    sheet.range(headerRow, column, 2, 1).merge().setValue(label);
  styleHeaderRow(sheet, headerRow, 1, width);
  styleHeaderRow(sheet, subRow, 1, width);

  const reportRows = reportedMainServices(services, records, stats).map(
    (service) => ({
      name: service.name_en,
      stat: stats[service.service_id] || {},
      records: records.filter(
        (record) => record.serviceId === service.service_id,
      ),
    }),
  );
  const otherRecords = otherRecordsOf(services, records);
  const otherServices = services.filter(
    (service) => service.category === "other",
  );
  if (otherRecords.length || otherServices.length)
    reportRows.push({
      name: "Other Services",
      stat: pooledStat(otherServices, stats),
      records: otherRecords,
    });

  const countOrBlank = (value) => (blank(value) ? "" : Number(value));
  let dataRow = firstDataRow;
  reportRows.forEach((entry, index) => {
    const pairs = SQD_DIMENSIONS.flatMap((dimension) => {
      const scores = entry.records.map((record) => record[dimension.key]);
      return [dimensionStat(scores, meanOf), dimensionStat(scores, medianOf)];
    });
    sheet
      .range(dataRow, 1, 1, 2 + pairs.length + 5)
      .setValues([
        [
          index + 1,
          entry.name,
          ...pairs,
          overallStat(entry.records),
          entry.records.length,
          countOrBlank(entry.stat.clients),
          countOrBlank(entry.stat.transactions),
          entry.stat.remarks || "",
        ],
      ]);
    dataRow++;
  });
  if (reportRows.length) {
    sheet.range(firstDataRow, 2, reportRows.length, 1).wrap();
    sheet.range(firstDataRow, REMARKS_COLUMN, reportRows.length, 1).wrap();
  }

  // Every figure in the OVERALL RATING row is drawn from the individual
  // answers, as the programme rows are: each respondent counts once.
  const totalRow = dataRow;
  const totals = [
    "",
    "OVERALL RATING",
    ...SQD_DIMENSIONS.flatMap((dimension) => {
      const values = records.map((record) => record[dimension.key]);
      return [dimensionStat(values, meanOf), dimensionStat(values, medianOf)];
    }),
    overallStat(records),
    records.length,
    reportRows.reduce(
      (sum, entry) => sum + (Number(entry.stat.clients) || 0),
      0,
    ),
    reportRows.reduce(
      (sum, entry) => sum + (Number(entry.stat.transactions) || 0),
      0,
    ),
    "",
  ];
  sheet.range(totalRow, 1, 1, totals.length).setValues([totals]);
  sheet.range(totalRow, 1, 1, width).bold().fill(BAND_FILL);
  sheet
    .range(
      firstDataRow,
      SQD_FIRST_COLUMN,
      totalRow - firstDataRow + 1,
      OVERALL_COLUMN - SQD_FIRST_COLUMN + 1,
    )
    .format("0.00");

  // ---- IV. Client feedback ----
  const feedbackRow = totalRow + 2;
  sheet.range(feedbackRow, 1).setValue("IV.").bold();
  sheet
    .range(feedbackRow, 2)
    .setValue(
      "Summarize the feedback gathered from the clients who availed of the different services",
    );
  styleSectionRow(sheet, feedbackRow, width);
  const suggestions = records.filter((record) => record.suggestions);
  if (suggestions.length)
    sheet
      .range(feedbackRow + 1, 2, suggestions.length, 1)
      .setValues(
        suggestions.map((record) => [
          `• [${record.serviceCode}] ${record.suggestions}`,
        ]),
      )
      .wrap();
  else
    sheet
      .range(feedbackRow + 1, 2)
      .setValue("No written feedback was submitted for this period.")
      .italic();

  const footnoteRow = feedbackRow + Math.max(suggestions.length, 1) + 2;
  sheet
    .range(footnoteRow, 2, 3, 1)
    .setValues([
      [
        "¹No. of Respondents - refers to the number of clients that opted to rate the service received through the CSM questionnaire",
      ],
      [
        "²No. of Clients - refers to the number of clients served for the service",
      ],
      [
        "³Volume of Transactions - refers to the number of transactions that have been made for the service",
      ],
    ])
    .size(9)
    .color(NOTE);

  sheet.setColumnWidth(1, 34);
  sheet.setColumnWidth(2, 320);
  for (let column = SQD_FIRST_COLUMN; column <= OVERALL_COLUMN; column++)
    sheet.setColumnWidth(column, 62);
  sheet.setColumnWidth(RESPONDENTS_COLUMN, 82);
  sheet.setColumnWidth(CLIENTS_COLUMN, 82);
  sheet.setColumnWidth(TRANSACTIONS_COLUMN, 95);
  sheet.setColumnWidth(REMARKS_COLUMN, 200);
  sheet.freeze(SQD_FIRST_COLUMN - 1, 0);
  return sheet;
}

// ------------------------------ Programme sheets -------------------------------

/**
 * A sheet name: the code in capitals, letters and digits only, at most 26
 * characters, and unique — Excel, like Sheets, compares names without regard
 * to case, and DATA is taken by the raw-responses sheet that comes last.
 */
export function sheetNameFor(code, existingNames) {
  const taken = [...existingNames.map((name) => name.toUpperCase()), "DATA"];
  const base =
    safeTrim(code)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 26) || "SERVICE";
  let name = base;
  let suffix = 2;
  while (taken.includes(name)) name = base.slice(0, 24) + suffix++;
  existingNames.push(name);
  return name;
}

function buildServiceSheet(workbook, period, settings, service, records) {
  const names = workbook.worksheets.map((worksheet) => worksheet.name);
  const sheet = sheetOf(
    workbook.addWorksheet(sheetNameFor(service.code, names)),
  );

  sheet.range(1, 1).setValue("OFFICE:").bold();
  sheet.range(1, 2).setValue(settings.office_name || DEFAULT_OFFICE);
  sheet
    .range(2, 1)
    .setValue(period.type === "year" ? "PERIOD:" : "QUARTER:")
    .bold();
  sheet.range(2, 2).setValue(period.label);
  sheet.range(3, 1).setValue("SERVICE NAME:").bold();
  sheet.range(3, 2, 1, 9).merge().setValue(service.name_en).wrap();

  sheet
    .range(5, 1, 3, 1)
    .merge()
    .setValue("Client #")
    .bold()
    .align("center", "middle");
  sheet
    .range(5, 3, 1, 8)
    .merge()
    .setValue("Service Quality Dimensions Rating (1-5 Likert Scale)")
    .bold()
    .align("center");
  sheet
    .range(6, 2, 2, 1)
    .merge()
    .setValue("SQD0")
    .bold()
    .align("center", "middle");
  const subHeaders = SQD_DIMENSIONS.slice(1);
  sheet
    .range(6, 3, 1, subHeaders.length)
    .setValues([subHeaders.map((dimension) => dimension.dimension)]);
  sheet
    .range(7, 3, 1, subHeaders.length)
    .setValues([subHeaders.map((dimension) => dimension.number)]);
  styleHeaderRow(sheet, 5, 1, 10);
  styleHeaderRow(sheet, 6, 1, 10);
  styleHeaderRow(sheet, 7, 1, 10);

  const firstDataRow = 8;
  if (records.length)
    sheet
      .range(firstDataRow, 1, records.length, SQD_DIMENSIONS.length + 1)
      .setValues(
        records.map((record, index) => [
          `Client ${index + 1}`,
          ...SQD_DIMENSIONS.map((dimension) =>
            ratingCell(record[dimension.key]),
          ),
        ]),
      );

  const meanRow = firstDataRow + Math.max(records.length, 1);
  const medianRow = meanRow + 1;
  sheet.range(meanRow, 1).setValue("Mean").bold();
  sheet.range(medianRow, 1).setValue("Median").bold();
  const stat = (statistic) =>
    SQD_DIMENSIONS.map((dimension) =>
      dimensionStat(
        records.map((record) => record[dimension.key]),
        statistic,
      ),
    );
  sheet
    .range(meanRow, 2, 2, SQD_DIMENSIONS.length)
    .setValues([stat(meanOf), stat(medianOf)])
    .format("0.00")
    .bold()
    .fill(BAND_FILL);

  const tallyRow = medianRow + 2;
  sheet
    .range(tallyRow, 1)
    .setValue("In each SQD, how many clients have a rating of:")
    .bold();
  const ratings = ["5", "4", "3", "2", "1", "0 or N/A"];
  sheet
    .range(tallyRow + 1, 1, ratings.length, 1)
    .setValues(ratings.map((rating) => [rating]));
  sheet.range(tallyRow + 1, 2, ratings.length, SQD_DIMENSIONS.length).setValues(
    ratings.map((rating) =>
      SQD_DIMENSIONS.map(
        (dimension) =>
          records.filter((record) => {
            const value = safeTrim(record[dimension.key]);
            return rating === "0 or N/A"
              ? value === "N/A" || value === "" || value === "0"
              : value === rating;
          }).length,
      ),
    ),
  );

  const signRow = tallyRow + 9;
  for (const [label, name, title, column] of [
    [
      "Prepared by:",
      settings.report_prepared_by,
      settings.report_prepared_title,
      1,
    ],
    [
      "Reviewed by:",
      settings.report_reviewed_by,
      settings.report_reviewed_title,
      5,
    ],
    [
      "Approved by:",
      settings.report_approved_by,
      settings.report_approved_title,
      8,
    ],
  ]) {
    sheet.range(signRow, column).setValue(label).bold();
    sheet
      .range(signRow + 2, column)
      .setValue(name || "")
      .bold();
    sheet.range(signRow + 3, column).setValue(title || "");
  }

  sheet.setColumnWidth(1, 110);
  for (let column = 2; column <= 10; column++) sheet.setColumnWidth(column, 92);
  sheet.freeze(0, 7);
  return sheet;
}

// ---------------------------------- DATA ---------------------------------------

/** "4", as the form stores an answer, back to the number Sheets made of it. */
const answerCell = (value) =>
  /^\d+$/.test(safeTrim(value)) ? Number(value) : value;

/** A YYYY-MM-DD day as the date Sheets made of it, at midnight UTC. */
const dayCell = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(safeTrim(value))
    ? new Date(`${value}T00:00:00Z`)
    : value;

function buildDataSheet(workbook, records) {
  const sheet = sheetOf(workbook.addWorksheet("DATA"));
  const headers = [
    "Month",
    "1. Client Type",
    "2. Sex",
    "3. Age",
    "4. Region of Residence",
    "5. Service Availed",
    "CC1",
    "CC2",
    "CC3",
    ...SQD_DIMENSIONS.map(
      (dimension) => `${dimension.number}. ${dimension.en} / ${dimension.tl}`,
    ),
    "Email",
    "Comments/Suggestions",
    "Reference",
    "Transaction Date",
  ];
  sheet
    .range(1, 1, 1, headers.length)
    .setValues([headers])
    .bold()
    .fill(BRAND)
    .color(WHITE)
    .wrap();

  if (records.length) {
    sheet
      .range(2, 1, records.length, headers.length)
      .setValues(
        records.map((record) => [
          record.month,
          record.clientType,
          record.sex,
          answerCell(record.age || "N/A"),
          record.regionCode,
          record.serviceCode,
          answerCell(record.cc1),
          answerCell(record.cc2),
          answerCell(record.cc3),
          ...SQD_DIMENSIONS.map((dimension) =>
            ratingCell(record[dimension.key]),
          ),
          record.email,
          record.suggestions,
          record.referenceId,
          dayCell(record.transactionDate),
        ]),
      );
    sheet.range(2, headers.length, records.length, 1).format("yyyy-mm-dd");
  }
  sheet.freeze(0, 1);
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(6, 150);
  return sheet;
}

// -------------------------------- The workbook ---------------------------------

export const reportFileName = (period) =>
  `CSM Summary Report — OSDS — ${period.label}.xlsx`;

/**
 * The finished .xlsx, as bytes, for records already put through
 * applyAnswerPolicy. `stats` holds each programme's office counts by
 * service_id, as clients, transactions and remarks text.
 */
export async function buildReportWorkbook({
  period,
  settings,
  services,
  records,
  stats,
  now = new Date(),
}) {
  // Loaded here rather than at the top: only this action needs it, and no
  // other request should pay for reading it.
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CHED-OSDS CSM Portal";
  workbook.created = now;
  workbook.modified = now;
  workbook.title = reportFileName(period).replace(/\.xlsx$/, "");
  workbook.subject = `CSM Summary Report, ${period.label}, generated ${officeDay(now)}`;

  const sheets = [
    buildSummarySheet(workbook, period, settings, services, records, stats),
  ];
  for (const service of reportedMainServices(services, records, stats))
    sheets.push(
      buildServiceSheet(
        workbook,
        period,
        settings,
        service,
        records.filter((record) => record.serviceId === service.service_id),
      ),
    );
  const otherRecords = otherRecordsOf(services, records);
  if (otherRecords.length)
    sheets.push(
      buildServiceSheet(
        workbook,
        period,
        settings,
        { code: "OTHER", name_en: "Other Services" },
        otherRecords,
      ),
    );
  sheets.push(buildDataSheet(workbook, records));
  for (const sheet of sheets) {
    sheet.worksheet.properties.defaultColWidth = widthOf(SHEETS_DEFAULT_WIDTH);
    fitWrappedRows(sheet);
  }

  return {
    name: reportFileName(period),
    bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
}
