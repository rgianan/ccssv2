import React from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { QUARTERS } from "../lib/csm";

export const currentPeriod = () => {
  const now = new Date();
  return {
    type: "quarter",
    year: now.getFullYear(),
    quarter: String(Math.floor(now.getMonth() / 3) + 1),
  };
};

export const describePeriod = (period) =>
  period.type === "year"
    ? `CY ${period.year}`
    : `${["", "1st", "2nd", "3rd", "4th"][Number(period.quarter)]} Quarter ${period.year}`;

export function PeriodPicker({ period, onChange }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, index) => thisYear - index);
  return (
    <div className="period-picker">
      <CalendarRange size={16} />
      <div className="select-wrap compact">
        <select
          value={period.type}
          onChange={(event) => onChange({ ...period, type: event.target.value })}
          title="Report by quarter or for the whole year"
        >
          <option value="quarter">By quarter</option>
          <option value="year">By year</option>
        </select>
        <ChevronDown />
      </div>
      {period.type === "quarter" && (
        <div className="select-wrap compact">
          <select
            value={period.quarter}
            onChange={(event) =>
              onChange({ ...period, quarter: event.target.value })
            }
            title="Select the quarter"
          >
            {QUARTERS.map((quarter) => (
              <option key={quarter.value} value={quarter.value}>
                {quarter.label}
              </option>
            ))}
          </select>
          <ChevronDown />
        </div>
      )}
      <div className="select-wrap compact">
        <select
          value={period.year}
          onChange={(event) =>
            onChange({ ...period, year: Number(event.target.value) })
          }
          title="Select the year"
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
        <ChevronDown />
      </div>
    </div>
  );
}
