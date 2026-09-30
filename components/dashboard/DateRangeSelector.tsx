"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, Check, ChevronDown } from "lucide-react";

// ============================================================
// Dashboard Date Range Selector - a compact preset dropdown +
// custom-range inputs, in the same visual/interaction style as the
// existing Profit & Loss report's own date filter (app/reports/
// profit-loss/page.tsx). A CONTROLLED component: the parent
// (app/dashboard/page.tsx) owns the actual preset/from/to state and
// the URL sync, mirroring that page's own pattern of reading
// window.location.search directly instead of next/navigation's
// useSearchParams() (which would require a Suspense boundary this
// codebase's report pages deliberately avoid).
// ============================================================

const PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: "TODAY", label: "Today" },
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "THIS_WEEK", label: "This Week" },
  { value: "LAST_WEEK", label: "Last Week" },
  { value: "THIS_MONTH", label: "This Month" },
  { value: "LAST_MONTH", label: "Last Month" },
  { value: "THIS_QUARTER", label: "This Quarter" },
  { value: "LAST_QUARTER", label: "Last Quarter" },
  { value: "THIS_YEAR", label: "This Year" },
  { value: "LAST_YEAR", label: "Last Year" },
  { value: "ALL_TIME", label: "All Time" },
];

export interface DateRangeSelectorProps {
  preset: string;
  label: string;
  rangeLabel: string;
  compareEnabled: boolean;
  onCompareChange: (enabled: boolean) => void;
  onSelectPreset: (preset: string) => void;
  onApplyCustomRange: (from: string, to: string) => void;
  initialCustomFrom?: string;
  initialCustomTo?: string;
}

export default function DateRangeSelector({
  preset,
  label,
  rangeLabel,
  compareEnabled,
  onCompareChange,
  onSelectPreset,
  onApplyCustomRange,
  initialCustomFrom = "",
  initialCustomTo = "",
}: DateRangeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(initialCustomFrom);
  const [customTo, setCustomTo] = useState(initialCustomTo);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handlePresetClick(value: string) {
    onSelectPreset(value);
    setOpen(false);
  }

  function handleApplyCustom() {
    if (!customFrom || !customTo) return;
    onApplyCustomRange(customFrom, customTo);
    setOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
        >
          <Calendar className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <span className="flex flex-col items-start leading-tight">
            <span className="font-medium text-gray-900">{label}</span>
            <span className="text-xs text-gray-400">{rangeLabel}</span>
          </span>
          <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
        </button>

        {open && (
          <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
            <div className="max-h-64 overflow-y-auto">
              {PRESET_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handlePresetClick(opt.value)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                    preset === opt.value ? "font-medium text-blue-600" : "text-gray-700"
                  }`}
                >
                  {opt.label}
                  {preset === opt.value && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
            <div className="mt-2 border-t pt-2">
              <p className="px-3 pb-1 text-xs font-medium text-gray-500">Custom Range</p>
              <div className="flex flex-col gap-2 px-3 pb-1">
                <label className="text-xs text-gray-500">
                  From
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-gray-200 px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-gray-500">
                  To
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-gray-200 px-2 py-1 text-sm"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleApplyCustom}
                  disabled={!customFrom || !customTo}
                  className="mt-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
        <input
          type="checkbox"
          checked={compareEnabled}
          onChange={(e) => onCompareChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        Compare with Previous Period
      </label>
    </div>
  );
}
