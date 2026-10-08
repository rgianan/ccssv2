import { officeDay } from "./dates.mjs";
import { safeTrim } from "./records.mjs";

/**
 * Reporting periods: a calendar quarter or a whole year, as normalizePeriod_
 * and inPeriod_ in Code.gs define them. A response belongs to the period its
 * transaction date falls in.
 */

const ORDINALS = ["", "1st", "2nd", "3rd", "4th"];

export function normalizePeriod(period, now = new Date()) {
  period = period || {};
  const year = Number(period.year) || Number(officeDay(now).slice(0, 4));
  const type =
    safeTrim(period.type).toLowerCase() === "year" ? "year" : "quarter";
  let quarter = String(period.quarter || "1");
  if (!["1", "2", "3", "4"].includes(quarter)) quarter = "1";
  return {
    type,
    year,
    quarter,
    key: type === "year" ? `${year}-FY` : `${year}-Q${quarter}`,
    label:
      type === "year"
        ? `CY ${year}`
        : `${ORDINALS[Number(quarter)]} Quarter ${year}`,
    shortLabel: type === "year" ? `CY ${year}` : `Q${quarter} ${year}`,
  };
}

/**
 * The period as a half-open range of transaction dates, [from, to), or null
 * for a year no response can have — inPeriod_ compared years exactly, so a
 * year like 2026.5 matched nothing.
 */
export function periodRange(period) {
  const { year } = period;
  if (!Number.isInteger(year) || year < 1 || year > 9998) return null;
  const day = (y, month) =>
    `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  if (period.type === "year")
    return { from: day(year, 1), to: day(year + 1, 1) };
  const first = (Number(period.quarter) - 1) * 3 + 1;
  return {
    from: day(year, first),
    to: first === 10 ? day(year + 1, 1) : day(year, first + 3),
  };
}
