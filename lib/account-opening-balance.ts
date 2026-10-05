import type { Prisma } from "@prisma/client";
import { parseISODateStart } from "@/lib/date-range";

// ============================================================
// ACCOUNT OPENING BALANCE - shared by app/api/accounts/route.ts and
// app/api/accounts/[id]/route.ts (kept here, not in either route
// file, so neither imports the other).
//
// Opening Balance has NO date of its own - it is, by definition, the
// amount that existed before every other transaction. Every Opening
// Balance JournalEntry (Account's own, created by the two routes
// above - NOT Party's own existing mechanism in app/api/parties/
// route.ts / app/api/parties/[id]/route.ts, which is untouched and
// keeps using its real creation date) is posted at this one fixed,
// internal-only date, never shown to the user.
// ============================================================

export const OPENING_BALANCE_SENTINEL_DATE = parseISODateStart("2000-01-01");

/** True for ANY Opening Balance JournalEntry/JournalLine, Account's own (sentinel-dated) or Party's own existing one (real creation date) - the one check every ledger/display/edit-guard below uses, never a date comparison. */
export function isOpeningBalanceReferenceType(referenceType: string | null | undefined): boolean {
  return referenceType === "OPENING_BALANCE";
}

export interface DerivedOpeningBalance {
  openingBalance: number;
  openingBalanceType: "DEBIT" | "CREDIT" | null;
}

// Single source of truth for turning an Account's existing (if any)
// active OPENING_BALANCE JournalEntry back into display/pre-fill
// values, since none of this is stored on Account itself ("Option A,
// no schema change").
export function deriveOpeningBalance(
  entry: { lines: { accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[] } | null,
  accountId: string
): DerivedOpeningBalance {
  const line = entry?.lines.find((l) => l.accountId === accountId) || null;
  if (!entry || !line) {
    return { openingBalance: 0, openingBalanceType: null };
  }
  const net = Number(line.debit) - Number(line.credit);
  return {
    openingBalance: Math.abs(net),
    openingBalanceType: net >= 0 ? "DEBIT" : "CREDIT",
  };
}
