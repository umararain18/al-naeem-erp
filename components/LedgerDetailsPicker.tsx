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

import { useEffect, useState } from "react";

export type LedgerDetailColumn =
  | "date"
  | "description"
  | "amount"
  | "biltyNo"
  | "challanNo"
  | "vehicle"
  | "clearingAgent"
  | "transporter"
  | "carrierNo"
  | "from"
  | "to"
  | "paymentType";

export const LEDGER_DETAIL_COLUMNS: LedgerDetailColumn[] = [
  "date",
  "description",
  "amount",
  "biltyNo",
  "challanNo",
  "vehicle",
  "clearingAgent",
  "transporter",
  "carrierNo",
  "from",
  "to",
  "paymentType",
];

export const LEDGER_DETAIL_LABELS: Record<LedgerDetailColumn, string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  biltyNo: "Bilty No",
  challanNo: "Challan No",
  vehicle: "Vehicle",
  clearingAgent: "Clearing Agent",
  transporter: "Transporter",
  carrierNo: "Carrier No",
  from: "From",
  to: "To",
  paymentType: "Payment/Receipt",
};

// Date, Description, Amount - the exact set every ledger already
// shows today, so turning this feature on changes nothing for a user
// who never opens the picker. Every structured detail field (Bilty
// No, Vehicle, etc.) is opt-in on top of that, never removing
// information the current screen already relies on.
export const LEDGER_DETAIL_DEFAULTS: LedgerDetailColumn[] = ["date", "description", "amount"];

const STORAGE_KEY = "anc-ledger-detail-columns";

export function useLedgerDetailColumns() {
  const [visible, setVisible] = useState<Set<LedgerDetailColumn>>(new Set(LEDGER_DETAIL_DEFAULTS));

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
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
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
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
          <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-xl p-3">
            <p className="text-xs font-semibold text-gray-500 mb-2">Ledger Details</p>
            <div className="grid grid-cols-2 gap-2">
              {LEDGER_DETAIL_COLUMNS.map((col) => (
                <label key={col} className="flex items-center gap-1.5 text-xs text-gray-700">
                  <input type="checkbox" checked={visible.has(col)} onChange={() => onToggle(col)} />
                  {LEDGER_DETAIL_LABELS[col]}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// A row's structured details, exactly mirroring
// lib/ledger-description.ts's LedgerRowDetails shape (duplicated here
// as a plain client-side type rather than imported, since this is a
// "use client" component and that module is server-only/Prisma-backed).
export interface LedgerRowDetailsLike {
  biltyNo?: string | null;
  challanNo?: string | null;
  vehicle?: string | null;
  clearingAgent?: string | null;
  transporter?: string | null;
  carrierNo?: string | null;
  from?: string | null;
  to?: string | null;
  paymentType?: "Received" | "Paid" | null;
}

/** Compact "chip" strings for whichever structured detail columns are both selected AND actually have a value for this row - never invented, never a fixed field order beyond LEDGER_DETAIL_COLUMNS'. */
export function ledgerDetailChips(details: LedgerRowDetailsLike | undefined, visible: Set<LedgerDetailColumn>): string[] {
  if (!details) return [];
  const chips: string[] = [];
  if (visible.has("biltyNo") && details.biltyNo) chips.push(`Bilty No ${details.biltyNo}`);
  if (visible.has("challanNo") && details.challanNo) chips.push(`Challan No ${details.challanNo}`);
  if (visible.has("vehicle") && details.vehicle) chips.push(details.vehicle);
  if (visible.has("clearingAgent") && details.clearingAgent) chips.push(`Clearing Agent ${details.clearingAgent}`);
  if (visible.has("transporter") && details.transporter) chips.push(`Transporter ${details.transporter}`);
  if (visible.has("carrierNo") && details.carrierNo) chips.push(`Carrier No ${details.carrierNo}`);
  if (visible.has("from") && details.from) chips.push(`From ${details.from}`);
  if (visible.has("to") && details.to) chips.push(`To ${details.to}`);
  if (visible.has("paymentType") && details.paymentType) chips.push(details.paymentType);
  return chips;
}
