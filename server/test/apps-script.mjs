import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { MONTH_NAMES } from "../dates.mjs";

/**
 * The Apps Script backend, run in Node: the real Code.gs, Certificate.gs and
 * Report.gs over a spreadsheet held in memory. Parity tests put the same
 * request to this and to the new backend and compare what comes back.
 *
 * Apps Script runs in the script's zone, Asia/Manila, so every call here is
 * made with the process in that zone and put back afterwards.
 */

const GAS_DIR = new URL("../../google-apps-script/", import.meta.url);

/** Utilities.formatDate for the patterns the backend uses. */
function formatDate(date, zone, pattern) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const two = (value) => String(value).padStart(2, "0");
  return pattern.replace(
    /yyyy|MMMM|MM|M|dd|d|HH|mm|ss|'[^']*'/g,
    (token) =>
      ({
        yyyy: String(p.year).padStart(4, "0"),
        MMMM: MONTH_NAMES[p.month - 1],
        MM: two(p.month),
        M: String(p.month),
        dd: two(p.day),
        d: String(p.day),
        HH: two(p.hour),
        mm: two(p.minute),
        ss: two(p.second),
      })[token] ?? token.slice(1, -1),
  );
}

/**
 * Utilities' digests take text (as UTF-8) or Java bytes, and return Java
 * bytes: signed, -128 to 127.
 */
const bytesOf = (value) =>
  Array.isArray(value)
    ? Buffer.from(value.map((b) => b & 255))
    : Buffer.from(String(value), "utf8");
const signed = (buffer) => [...buffer].map((b) => (b > 127 ? b - 256 : b));
const base64 = (bytes) =>
  Buffer.from(bytes.map((b) => b & 255)).toString("base64");

/**
 * A sheet as Sheets stores it, near enough: a leading apostrophe is taken as
 * "store this as text" and not kept, which is what safeSheetValue_ relies on;
 * text that reads as a number is stored as one, so "045" comes back as 45.
 */
function sheetOf(name, rows) {
  const data = rows.map((row) => row.slice());
  const cell = (value) => {
    if (typeof value !== "string") return value;
    if (value.startsWith("'")) return value.slice(1);
    return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  };
  const sheet = {
    data,
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => data[0].length,
    getMaxRows: () => Math.max(data.length, 1000),
    getMaxColumns: () => Math.max(data[0].length, 26),
    insertRowsAfter: () => {},
    setFrozenRows: () => {},
    appendRow: (row) => data.push(row.map(cell)),
    getDataRange: () => sheet.getRange(1, 1, data.length, data[0].length),
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () =>
        data
          .slice(r - 1, r - 1 + nr)
          .map((row) => row.slice(c - 1, c - 1 + nc)),
      getValue: () => (data[r - 1] || [])[c - 1],
      setValues: (values) =>
        values.forEach((row, i) => {
          while (data.length <= r - 1 + i)
            data.push(new Array(data[0].length).fill(""));
          row.forEach((value, j) => (data[r - 1 + i][c - 1 + j] = cell(value)));
        }),
      setValue: (value) => {
        while (data.length <= r - 1)
          data.push(new Array(data[0].length).fill(""));
        data[r - 1][c - 1] = cell(value);
      },
      setNumberFormat() {
        return this;
      },
      setFontWeight() {
        return this;
      },
      setBackground() {
        return this;
      },
      setFontColor() {
        return this;
      },
    }),
  };
  return sheet;
}

export const SERVICE_HEADERS = [
  "service_id",
  "code",
  "name_en",
  "name_tl",
  "category",
  "active",
  "has_fees",
  "sort_order",
  "created_at",
  "updated_at",
];

export function appsScript({ services = [], settings = {}, google = {} } = {}) {
  const sheets = {};
  const cache = new Map();
  const props = { AUDIT_HASH_SECRET: "audit", SESSION_HASH_SECRET: "session" };
  const mail = [];
  const lock = () => ({
    tryLock: () => true,
    waitLock: () => {},
    releaseLock: () => {},
  });
  const ctx = createContext({
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    Session: { getScriptTimeZone: () => "Asia/Manila" },
    ScriptApp: { getProjectTriggers: () => [] },
    DriveApp: {},
    DocumentApp: {},
    UrlFetchApp: {},
    MimeType: {},
    HtmlService: {},
    MailApp: {
      getRemainingDailyQuota: () => 100,
      sendEmail: (message) => mail.push({ ...message }),
    },
    Logger: { log: () => {} },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text) => ({
        text,
        setMimeType() {
          return this;
        },
      }),
    },
    Utilities: {
      getUuid: () => randomUUID(),
      formatDate,
      Charset: { UTF_8: "utf-8" },
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (algorithm, value) =>
        signed(createHash("sha256").update(bytesOf(value)).digest()),
      computeHmacSha256Signature: (value, key) =>
        signed(
          createHmac("sha256", bytesOf(key)).update(bytesOf(value)).digest(),
        ),
      base64Encode: base64,
      base64EncodeWebSafe: (bytes) =>
        base64(bytes).replace(/\+/g, "-").replace(/\//g, "_"),
      base64Decode: (text) => signed(Buffer.from(String(text), "base64")),
      newBlob: (bytes, contentType, name) =>
        google.blob ? google.blob(name, contentType, bytes) : null,
    },
    LockService: { getScriptLock: lock, getDocumentLock: lock },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        getAll: (keys) =>
          Object.fromEntries(
            keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)]),
          ),
        put: (k, v) => cache.set(k, v),
        putAll: (o) => Object.entries(o).forEach(([k, v]) => cache.set(k, v)),
        remove: (k) => cache.delete(k),
        removeAll: (keys) => keys.forEach((k) => cache.delete(k)),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => {
          props[k] = String(v);
        },
        deleteProperty: (k) => {
          delete props[k];
        },
        getProperties: () => ({ ...props }),
      }),
    },
    SpreadsheetApp: {
      flush: () => {},
      getActiveSpreadsheet: () => ({
        getUrl: () => "https://sheet",
        getSpreadsheetTimeZone: () => "Asia/Manila",
        getSheetByName: (n) => sheets[n] || null,
        getSheets: () => Object.values(sheets),
        insertSheet: (n) => (sheets[n] = sheetOf(n, [[""]])),
      }),
    },
    // Drive, Docs and the like, for tests that need them (google-stubs.mjs).
    ...google,
  });
  for (const file of [
    "Code.gs",
    "Certificate.gs",
    "Report.gs",
    "Worker.gs",
    "Export.gs",
  ])
    runInContext(readFileSync(new URL(file, GAS_DIR), "utf8"), ctx);

  const inManila = (work) => {
    const zone = process.env.TZ;
    process.env.TZ = "Asia/Manila";
    try {
      return work();
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  };
  // Results are copied out through JSON: objects made inside the sandbox have
  // its own Object prototype, which strict comparisons count as a difference.
  const call = (expression, args = {}) =>
    inManila(() => {
      Object.assign(ctx, args);
      const result = runInContext(expression, ctx);
      return result && typeof result === "object"
        ? JSON.parse(JSON.stringify(result))
        : result;
    });

  // Sheets hands the script its own Dates; one made out here would fail the
  // script's `instanceof Date`, which Report.gs relies on.
  const ScriptDate = runInContext("Date", ctx);
  const inRealm = (value) =>
    value instanceof Date ? new ScriptDate(value.getTime()) : value;

  const headers = call(
    "responseColumns_().map(function (c) { return c.header; })",
  );
  sheets.Responses = sheetOf("Responses", [headers]);
  sheets.Services = sheetOf("Services", [
    SERVICE_HEADERS,
    ...services.map((s) => [
      s.service_id,
      s.code,
      s.name_en,
      s.name_tl || "",
      s.category,
      s.active !== false,
      s.has_fees === true,
      s.sort_order,
      "",
      "",
    ]),
  ]);
  sheets.Settings = sheetOf("Settings", [
    ["key", "value"],
    ...Object.entries(settings),
  ]);

  return {
    sheets,
    mail,
    props,
    headers,
    call,
    /** Adds or replaces a whole sheet, header row first. */
    setSheet: (name, rows) =>
      (sheets[name] = sheetOf(
        name,
        rows.map((row) => row.map(inRealm)),
      )),
    /** A response row as buildResponseRecord_ reads it back. */
    record: (referenceId) =>
      call(
        `(function () {
        var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Responses');
        var col = responseFieldColumns_(getHeaderMap_(sh));
        return findResponseByColumn_(sh, col, col.referenceId, __ref);
      })()`,
        { __ref: referenceId },
      ),
    /** The raw cell, for columns buildResponseRecord_ does not read. */
    cell: (referenceId, header) => {
      const rows = sheets.Responses.data;
      const row = rows.find(
        (r) => r[headers.indexOf("ResponseID")] === referenceId,
      );
      return row ? row[headers.indexOf(header)] : undefined;
    },
    /** Appends a row by header name, for state the tests set up. */
    addResponse: (values) => {
      const row = headers.map((h) => (h in values ? inRealm(values[h]) : ""));
      sheets.Responses.data.push(row);
    },
  };
}
