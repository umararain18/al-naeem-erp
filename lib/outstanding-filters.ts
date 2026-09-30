import type { OutstandingRow, OutstandingDirection } from "@/lib/party-outstanding";

// ============================================================
// OUTSTANDING LEDGER FILTER PREDICATE - the SINGLE shared source of
// truth for "which Outstanding rows match the active
// Search/Type/Direction/Date filters", used identically by:
//   - the screen (app/parties/[id]/ledger/OutstandingView.tsx)
//   - the PDF export (app/api/parties/[id]/outstanding/pdf/route.ts)
//
// Deliberately a STANDALONE module with NO Prisma/server import (only
// a type-only import of OutstandingRow, erased at compile time) - so
// it can be safely imported from a "use client" component AND a
// server route without ever pulling Prisma into the browser bundle.
// This is what makes "the screen and export use the same source of
// truth" literally true, not just documented intent.
//
// Purely a read-side narrowing of an already-computed row list -
// never touches originalAmount/settledAmount/remainingAmount, and
// never re-derives which documents are outstanding in the first
// place. All options combine with AND semantics.
// ============================================================

export interface OutstandingFilterOptions {
  search?: string | null;
  documentType?: OutstandingRow["documentType"] | null;
  direction?: OutstandingDirection | null;
  /** Document-date range, YYYY-MM-DD (Asia/Karachi calendar day). Filters WHICH documents are included - the Outstanding engine has no as-of-date reconstruction, so this never changes Settled/Remaining, only which rows appear. */
  from?: string | null;
  to?: string | null;
}

/** Asia/Karachi calendar-day key. Accepts both a real Date (server-side, straight from Prisma) and an ISO string (client-side, after a JSON round-trip) - the two contexts this predicate runs in. */
export function documentDateKey(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(d);
}

interface FilterableRow {
  documentType: OutstandingRow["documentType"];
  direction: OutstandingDirection;
  documentDate: Date | string;
  documentNo: string;
  description: string;
}

export function filterOutstandingRows<T extends FilterableRow>(rows: T[], options: OutstandingFilterOptions): T[] {
  const q = (options.search || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (options.documentType && row.documentType !== options.documentType) return false;
    if (options.direction && row.direction !== options.direction) return false;
    if (options.from || options.to) {
      const key = documentDateKey(row.documentDate);
      if (options.from && key < options.from) return false;
      if (options.to && key > options.to) return false;
    }
    if (q) {
      const haystack = `${row.documentNo} ${row.description}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
