// Shared, framework-agnostic "Ledger Details" column definitions -
// the SINGLE source of truth for which structured detail fields a
// user may select, used by:
//   - components/LedgerDetailsPicker.tsx (the on-screen checkbox UI
//     + localStorage persistence)
//   - app/ledger/page.tsx + app/parties/[id]/ledger/page.tsx (on-
//     screen rendering)
//   - every PDF/Excel export route for these two ledgers (server-
//     side, reading the SAME selection via a `details` query param)
//
// This file has no "use client" and no React/DOM dependency so it is
// safely importable from server route handlers. The allowed-key
// whitelist here is the ONLY place a client-supplied `details` query
// param is validated against - never trust the raw string.
//
// LOCKED field list - do not add/remove/rename without re-checking
// the finalized Ledger Details spec. "Cheque No" is deliberately
// absent: no cheque field exists anywhere in this system yet. Date,
// Reference, Debit/Credit, and Balance are core columns on every
// ledger screen/export and are NEVER part of this selectable list.

export type LedgerDetailColumn =
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
  | "paymentType"
  | "description";

export interface LedgerDetailColumnGroup {
  label: string;
  columns: LedgerDetailColumn[];
}

export const LEDGER_DETAIL_GROUPS: LedgerDetailColumnGroup[] = [
  { label: "Documents / References", columns: ["biltyNo", "challanNo", "privatePhonchNo", "showroomPhonchNo", "billNo"] },
  { label: "Vehicle / Parties", columns: ["vehicle", "registrationNo", "transporter", "clearingAgent", "carrierNo"] },
  { label: "Other", columns: ["route", "paymentType", "description"] },
];

export const LEDGER_DETAIL_COLUMNS: LedgerDetailColumn[] = LEDGER_DETAIL_GROUPS.flatMap((g) => g.columns);

const LEDGER_DETAIL_COLUMN_SET = new Set<string>(LEDGER_DETAIL_COLUMNS);

export const LEDGER_DETAIL_LABELS: Record<LedgerDetailColumn, string> = {
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
  description: "Description",
};

// Description only - every ledger already shows the sentence today,
// so turning this feature on changes nothing for a user who never
// opens the picker. Every structured field (Bilty No, Vehicle, etc.)
// is opt-in on top of that, never removing information the current
// screen already relies on.
export const LEDGER_DETAIL_DEFAULTS: LedgerDetailColumn[] = ["description"];

export const LEDGER_DETAIL_STORAGE_KEY = "anc-ledger-detail-columns";

/** Validates a comma-separated `details` query value against the whitelist - unknown/malformed keys are silently dropped, never trusted or echoed back. A missing/empty param falls back to LEDGER_DETAIL_DEFAULTS, the same baseline the on-screen ledger starts from, so an export link with no explicit selection still behaves sanely rather than showing nothing or everything. */
export function parseLedgerDetailColumns(raw: string | null | undefined): Set<LedgerDetailColumn> {
  if (!raw || !raw.trim()) return new Set(LEDGER_DETAIL_DEFAULTS);
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => LEDGER_DETAIL_COLUMN_SET.has(k)) as LedgerDetailColumn[];
  return new Set(keys);
}

export function serializeLedgerDetailColumns(visible: Set<LedgerDetailColumn>): string {
  return [...visible].join(",");
}

// A row's structured details, mirroring lib/ledger-description.ts's
// LedgerRowDetails shape exactly (duplicated here rather than
// imported, since that module is Prisma-backed and this one must
// stay safely importable from a "use client" component too).
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

const CHIP_LABELS: Partial<Record<LedgerDetailColumn, (value: string) => string>> = {
  biltyNo: (v) => `Bilty No ${v}`,
  challanNo: (v) => `Challan No ${v}`,
  privatePhonchNo: (v) => `Private Phonch No ${v}`,
  showroomPhonchNo: (v) => `Phonch No ${v}`,
  billNo: (v) => `Bill No ${v}`,
  vehicle: (v) => v,
  registrationNo: (v) => v,
  transporter: (v) => v,
  clearingAgent: (v) => `CA: ${v}`,
  carrierNo: (v) => `Carrier: ${v}`,
  route: (v) => v,
  paymentType: (v) => v,
};

const DETAIL_FIELD_ORDER: Exclude<LedgerDetailColumn, "description">[] = [
  "biltyNo",
  "challanNo",
  "privatePhonchNo",
  "showroomPhonchNo",
  "billNo",
  "vehicle",
  "registrationNo",
  "transporter",
  "clearingAgent",
  "carrierNo",
  "route",
  "paymentType",
];

/** Compact "chip" strings for whichever structured detail columns are both selected AND actually have a value for this row - never invented, never a fixed field beyond LEDGER_DETAIL_COLUMNS'. Never includes "description" (that is the sentence itself, rendered separately by the caller). Shared by the on-screen table, the PDF export, and the Excel export - the one place this logic lives. */
export function ledgerDetailChips(details: LedgerRowDetailsLike | undefined, visible: Set<LedgerDetailColumn>): string[] {
  if (!details) return [];
  const chips: string[] = [];
  for (const key of DETAIL_FIELD_ORDER) {
    if (!visible.has(key)) continue;
    const value = details[key];
    if (!value) continue;
    chips.push(CHIP_LABELS[key]!(value));
  }
  return chips;
}
