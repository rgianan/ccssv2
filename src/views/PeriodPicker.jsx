import React from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { QUARTERS, portalPeriodNow } from "../lib/csm";
import { Tip } from "./ui";

// The reporting period follows the office's calendar, not the browser's, so an
// administrator abroad still lands on the quarter the backend is filing.
export const currentPeriod = () => ({ type: "quarter", ...portalPeriodNow() });

export const describePeriod = (period) =>
  period.type === "year"
    ? `CY ${period.year}`
    : `${["", "1st", "2nd", "3rd", "4th"][Number(period.quarter)]} Quarter ${period.year}`;

export function PeriodPicker({ period, onChange }) {
  const thisYear = portalPeriodNow().year;
  const years = Array.from({ length: 6 }, (_, index) => thisYear - index);
  return (
    <div className="period-picker">
      <CalendarRange size={16} />
      <Tip
        placement="bottom"
        align="start"
        text="File by quarter, or roll the whole calendar year into one report"
      >
        <div className="select-wrap compact">
          <select
            value={period.type}
            onChange={(event) =>
              onChange({ ...period, type: event.target.value })
            }
          >
            <option value="quarter">By quarter</option>
            <option value="year">By year</option>
          </select>
          <ChevronDown />
        </div>
      </Tip>
      {period.type === "quarter" && (
        <Tip placement="bottom" text="Which quarter the figures cover">
          <div className="select-wrap compact">
            <select
              value={period.quarter}
              onChange={(event) =>
                onChange({ ...period, quarter: event.target.value })
              }
            >
              {QUARTERS.map((quarter) => (
                <option key={quarter.value} value={quarter.value}>
                  {quarter.label}
                </option>
              ))}
            </select>
            <ChevronDown />
          </div>
        </Tip>
      )}
      <Tip placement="bottom" align="end" text="Reporting year">
        <div className="select-wrap compact">
          <select
            value={period.year}
            onChange={(event) =>
              onChange({ ...period, year: Number(event.target.value) })
            }
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
          <ChevronDown />
        </div>
      </Tip>
    </div>
  );
}
