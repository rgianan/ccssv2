/**
 * Calendar days in the office's zone.
 *
 * Apps Script ran in Asia/Manila, so "today", a transaction's month and an
 * issue time all meant Manila's. Vercel runs in UTC, where from midnight to
 * 8 a.m. in Manila it is still yesterday. Nothing here reads the process's own
 * zone: every day is either parsed from text or taken from Manila's calendar.
 */

export const OFFICE_TIME_ZONE = "Asia/Manila";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const manilaParts = new Intl.DateTimeFormat("en-US", {
  timeZone: OFFICE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const partsOf = (instant) =>
  Object.fromEntries(
    manilaParts.formatToParts(instant).map((part) => [part.type, part.value]),
  );

/** yyyy-mm-dd: the day it is, or was at `instant`, in Manila. */
export function officeDay(instant = new Date()) {
  const p = partsOf(instant);
  return `${p.year}-${p.month}-${p.day}`;
}

/** yyyy-mm-dd HH:mm in Manila, the form certificates have always shown. */
export function officeMinute(instant) {
  const p = partsOf(instant);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** yyyy-mm-dd HH:mm:ss in Manila, as the audit log writes and hashes it. */
export function officeSecond(instant) {
  const p = partsOf(instant);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const pad = (value, width) => String(value).padStart(width, "0");

/**
 * A day typed into a form, as yyyy-mm-dd, or null.
 *
 * Matches parseDate_ in Code.gs, overflow included: 2026-02-31 is March 3,
 * as it was there. Anything not starting yyyy-mm-dd is read by Date and taken
 * as the Manila day of that instant.
 */
export function parseDay(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const date = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : officeDay(parsed);
}

/** "October 5, 2026", for a yyyy-mm-dd day. */
export function longDay(day) {
  const [year, month, date] = String(day).split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${date}, ${year}`;
}

/** What a certificate prints after "for the purpose of …". */
export function dateCoverage(from, to) {
  const start = parseDay(from),
    end = parseDay(to);
  if (!start) return "";
  if (!end || end === start) return `on ${longDay(start)}`;
  return `from ${longDay(start)} to ${longDay(end)}`;
}
