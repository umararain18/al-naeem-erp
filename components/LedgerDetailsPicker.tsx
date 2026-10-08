"use client";

// Configurable "Ledger Details" columns, shared by General Ledger
// (app/ledger/page.tsx) and Party Ledger (app/parties/[id]/ledger/
// page.tsx) - the two screens that render lib/ledger-description.ts's
// FinalLedgerRow.details. Presentation-only: this never reads or
// writes any accounting data, only which already-resolved detail
// fields a user wants rendered. Mirrors the existing column-picker-
// with-localStorage pattern already used by
// app/parties/[id]/ledger/DocumentsView.tsx (a different tab), under
// its own storage key so the two pickers never collide.
//
// The field list, labels, grouping, defaults, and chip-building logic
// all live in lib/ledger-detail-columns.ts (framework-agnostic) so
// the PDF/Excel export routes can use the EXACT SAME definitions
// server-side, reading the same selection via a `details` query
// param - never a second, independently-maintained field list.

import { useEffect, useState } from "react";
import {
  LEDGER_DETAIL_GROUPS,
  LEDGER_DETAIL_LABELS,
  LEDGER_DETAIL_DEFAULTS,
  LEDGER_DETAIL_STORAGE_KEY,
  type LedgerDetailColumn,
} from "@/lib/ledger-detail-columns";

export type { LedgerDetailColumn };
export { ledgerDetailChips, type LedgerRowDetailsLike } from "@/lib/ledger-detail-columns";

export function useLedgerDetailColumns() {
  const [visible, setVisible] = useState<Set<LedgerDetailColumn>>(new Set(LEDGER_DETAIL_DEFAULTS));

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LEDGER_DETAIL_STORAGE_KEY);
      if (stored) setVisible(new Set(JSON.parse(stored)));
    } catch {
      // ignore - falls back to the defaults already set above
    }
  }, []);

  function toggle(col: LedgerDetailColumn) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      try {
        window.localStorage.setItem(LEDGER_DETAIL_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  }

  return { visible, toggle };
}

export function LedgerDetailsPicker({
  visible,
  onToggle,
}: {
  visible: Set<LedgerDetailColumn>;
  onToggle: (col: LedgerDetailColumn) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="border rounded-lg px-3 py-2 text-sm hover:bg-gray-50 whitespace-nowrap"
      >
        Ledger Details
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-xl p-3 max-h-96 overflow-y-auto">
            {LEDGER_DETAIL_GROUPS.map((group) => (
              <div key={group.label} className="mb-3">
                <p className="text-xs font-semibold text-gray-500 mb-1.5">{group.label}</p>
                <div className="grid grid-cols-2 gap-2">
                  {group.columns.map((col) => (
                    <label key={col} className="flex items-center gap-1.5 text-xs text-gray-700">
                      <input type="checkbox" checked={visible.has(col)} onChange={() => onToggle(col)} />
                      {LEDGER_DETAIL_LABELS[col]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
