"use client";

// Shared filter bar for every ledger screen (General Ledger, Party
// Ledger, Employee Ledger, Cash Book) - transaction search, date
// range, presets, and reset, all with the same visual treatment and
// behavior. Does NOT own an account selector - each ledger's own
// account/party/employee context (already fixed by the URL, a
// SearchableSelect, etc.) stays exactly where it already is; this
// component only ever renders the parts that are genuinely identical
// across all four ledgers.

type PresetKey = "TODAY" | "YESTERDAY" | "THIS_WEEK" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "ALL_TIME";

function toDateInput(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(d);
}

export function presetRange(key: PresetKey): { from: string; to: string } {
  const now = new Date();
  const today = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Karachi" }));

  switch (key) {
    case "TODAY":
      return { from: toDateInput(today), to: toDateInput(today) };
    case "YESTERDAY": {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { from: toDateInput(y), to: toDateInput(y) };
    }
    case "THIS_WEEK": {
      const start = new Date(today);
      start.setDate(start.getDate() - start.getDay());
      return { from: toDateInput(start), to: toDateInput(today) };
    }
    case "THIS_MONTH": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: toDateInput(start), to: toDateInput(today) };
    }
    case "LAST_MONTH": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: toDateInput(start), to: toDateInput(end) };
    }
    case "THIS_YEAR": {
      const start = new Date(today.getFullYear(), 0, 1);
      return { from: toDateInput(start), to: toDateInput(today) };
    }
    case "ALL_TIME":
    default:
      return { from: "", to: "" };
  }
}

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "TODAY", label: "Today" },
  { key: "YESTERDAY", label: "Yesterday" },
  { key: "THIS_WEEK", label: "This Week" },
  { key: "THIS_MONTH", label: "This Month" },
  { key: "LAST_MONTH", label: "Last Month" },
  { key: "THIS_YEAR", label: "This Year" },
  { key: "ALL_TIME", label: "All Time" },
];

export function LedgerFilters({
  search,
  onSearchChange,
  from,
  to,
  onFromChange,
  onToChange,
  onReset,
  resultLabel,
  searchPlaceholder = "Search transactions...",
  extra,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onReset: () => void;
  /** e.g. "12 transactions found" / "No transactions found" - shown only when a search term is active. */
  resultLabel?: string | null;
  searchPlaceholder?: string;
  /** Slot for a ledger-specific account/party/employee selector, rendered above the shared row. */
  extra?: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
      {extra}

      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={searchPlaceholder}
        className="w-full border rounded-lg px-3 py-2 text-sm mb-3"
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input
          type="date"
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => onToChange(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        />
        <button type="button" onClick={onReset} className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
          Reset
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => {
              const range = presetRange(p.key);
              onFromChange(range.from);
              onToChange(range.to);
            }}
            className="text-xs border rounded-lg px-3 py-1.5 hover:bg-gray-50 text-gray-600"
          >
            {p.label}
          </button>
        ))}
      </div>

      {search.trim() && resultLabel && <p className="text-xs text-gray-500 mt-3">{resultLabel}</p>}
    </div>
  );
}
