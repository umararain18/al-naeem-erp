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
// Field list is LOCKED per the finalized Ledger Details spec - do not
// add/remove/rename a field here without re-checking that spec.
// "Cheque No" is deliberately absent: no cheque field exists anywhere
// in this system yet.

import { useEffect, useState } from "react";

export type LedgerDetailColumn =
  | "date"
  | "description"
  | "amount"
  | "biltyNo"
  | "challanNo"
  | "privatePhonchNo"
  | "showroomPhonchNo"
  | "billNo"
  | "vehicle"
  | "registrationNo"
  | "transporter"
  | "clearingAgent"
  | "carrierNo"
  | "route"
  | "paymentType";

interface ColumnGroup {
  label: string;
  columns: LedgerDetailColumn[];
}

// Grouped for the picker's own layout only - LEDGER_DETAIL_COLUMNS
// (the flat list other code iterates) is derived from this below, so
// the two can never drift apart.
const COLUMN_GROUPS: ColumnGroup[] = [
  { label: "Documents / References", columns: ["biltyNo", "challanNo", "privatePhonchNo", "showroomPhonchNo", "billNo"] },
  { label: "Vehicle / Parties", columns: ["vehicle", "registrationNo", "transporter", "clearingAgent", "carrierNo"] },
  { label: "Other", columns: ["route", "paymentType", "description"] },
];

export const LEDGER_DETAIL_COLUMNS: LedgerDetailColumn[] = [
  "date",
  "amount",
  ...COLUMN_GROUPS.flatMap((g) => g.columns),
];

export const LEDGER_DETAIL_LABELS: Record<LedgerDetailColumn, string> = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  biltyNo: "Bilty No",
  challanNo: "Challan No",
  privatePhonchNo: "Private Phonch No",
  showroomPhonchNo: "Showroom Phonch No",
  billNo: "Bill No",
  vehicle: "Vehicle",
  registrationNo: "Registration No",
  transporter: "Transporter",
  clearingAgent: "Clearing Agent",
  carrierNo: "Carrier No",
  route: "Route",
  paymentType: "Payment Type",
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
          <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-xl p-3 max-h-96 overflow-y-auto">
            <label className="flex items-center gap-1.5 text-xs text-gray-700 pb-2 border-b mb-2">
              <input type="checkbox" checked={visible.has("date")} onChange={() => onToggle("date")} />
              {LEDGER_DETAIL_LABELS.date}
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-700 pb-2 border-b mb-2">
              <input type="checkbox" checked={visible.has("amount")} onChange={() => onToggle("amount")} />
              {LEDGER_DETAIL_LABELS.amount}
            </label>
            {COLUMN_GROUPS.map((group) => (
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

// A row's structured details, exactly mirroring
// lib/ledger-description.ts's LedgerRowDetails shape (duplicated here
// as a plain client-side type rather than imported, since this is a
// "use client" component and that module is server-only/Prisma-backed).
export interface LedgerRowDetailsLike {
  biltyNo?: string | null;
  challanNo?: string | null;
  privatePhonchNo?: string | null;
  showroomPhonchNo?: string | null;
  billNo?: string | null;
  vehicle?: string | null;
  registrationNo?: string | null;
  clearingAgent?: string | null;
  transporter?: string | null;
  carrierNo?: string | null;
  route?: string | null;
  paymentType?: "Received" | "Paid" | null;
}

/** Compact "chip" strings for whichever structured detail columns are both selected AND actually have a value for this row - never invented, never a fixed field order beyond LEDGER_DETAIL_COLUMNS'. */
export function ledgerDetailChips(details: LedgerRowDetailsLike | undefined, visible: Set<LedgerDetailColumn>): string[] {
  if (!details) return [];
  const chips: string[] = [];
  if (visible.has("biltyNo") && details.biltyNo) chips.push(`Bilty No ${details.biltyNo}`);
  if (visible.has("challanNo") && details.challanNo) chips.push(`Challan No ${details.challanNo}`);
  if (visible.has("privatePhonchNo") && details.privatePhonchNo) chips.push(`Private Phonch No ${details.privatePhonchNo}`);
  if (visible.has("showroomPhonchNo") && details.showroomPhonchNo) chips.push(`Phonch No ${details.showroomPhonchNo}`);
  if (visible.has("billNo") && details.billNo) chips.push(`Bill No ${details.billNo}`);
  if (visible.has("vehicle") && details.vehicle) chips.push(details.vehicle);
  if (visible.has("registrationNo") && details.registrationNo) chips.push(details.registrationNo);
  if (visible.has("transporter") && details.transporter) chips.push(details.transporter);
  if (visible.has("clearingAgent") && details.clearingAgent) chips.push(`CA: ${details.clearingAgent}`);
  if (visible.has("carrierNo") && details.carrierNo) chips.push(`Carrier: ${details.carrierNo}`);
  if (visible.has("route") && details.route) chips.push(details.route);
  if (visible.has("paymentType") && details.paymentType) chips.push(details.paymentType);
  return chips;
}
