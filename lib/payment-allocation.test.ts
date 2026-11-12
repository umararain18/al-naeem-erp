import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findPairedCashBankLine,
  capOpeningBalanceByCurrentBalance,
  isEligibleForAllocation,
  type PaymentLineInfo,
} from "./payment-allocation";

// ------------------------------------------------------------
// findPairedCashBankLine() - production bug fix: a single Daily
// Posting submission bundles every non-CHALLAN/BILTY-tagged line
// into ONE shared JournalEntry (app/api/daily-posting/route.ts's own
// DIRECT_GROUP), so a submission recording several different
// parties' lumpsum receipts in one go produces a >2-line entry. The
// old "entry must have EXACTLY TWO lines" rule silently excluded
// EVERY one of those real receipts from FIFO - confirmed as the
// dominant cause of near-zero matches on production. Fixed by
// pairing a line to its own counterpart via the exact (sourceType,
// sourceId, sourceNumber, description) signature buildLinePair()
// gives both members of a pair, plus an exact opposite-amount swap -
// mirroring app/api/cash-book/[id]/route.ts's own DELETE handler,
// which already re-identifies a bundled pair the same way.
// ------------------------------------------------------------

interface TestLine {
  id: string;
  debit: number;
  credit: number;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  description: string | null;
  account: { category: string };
}

function partyLine(overrides: Partial<TestLine> & { id: string }): TestLine {
  return {
    debit: 0,
    credit: 0,
    sourceType: null,
    sourceId: null,
    sourceNumber: null,
    description: null,
    account: { category: "PARTY" },
    ...overrides,
  };
}

function cashLine(overrides: Partial<TestLine> & { id: string }): TestLine {
  return {
    debit: 0,
    credit: 0,
    sourceType: null,
    sourceId: null,
    sourceNumber: null,
    description: null,
    account: { category: "CASH" },
    ...overrides,
  };
}

test("findPairedCashBankLine: simple 2-line entry pairs by elimination", () => {
  const party = partyLine({ id: "party-1", credit: 5000, description: "Receipt from Ansari And Sons" });
  const cash = cashLine({ id: "cash-1", debit: 5000, description: "Receipt from Ansari And Sons" });
  const result = findPairedCashBankLine(party, [party, cash]);
  assert.equal(result?.id, "cash-1");
});

test("findPairedCashBankLine: 2-line entry whose other line is NOT Cash/Bank is rejected", () => {
  const party = partyLine({ id: "party-1", credit: 5000 });
  const otherParty = partyLine({ id: "party-2", debit: 5000 });
  const result = findPairedCashBankLine(party, [party, otherParty]);
  assert.equal(result, null);
});

test("findPairedCashBankLine: bundled multi-line entry (several lumpsum receipts in one submission) - each line still uniquely pairs", () => {
  // One Daily Posting submission recording THREE different parties'
  // receipts at once - app/api/daily-posting/route.ts's DIRECT_GROUP
  // bundles all three into ONE 6-line JournalEntry (3 Cash legs + 3
  // Party legs). Each pair shares the SAME description/sourceType/
  // sourceId/sourceNumber and an exact opposite debit/credit swap.
  const ansariParty = partyLine({ id: "p-ansari", credit: 10000, description: "Ansari And Sons receipt" });
  const ansariCash = cashLine({ id: "c-ansari", debit: 10000, description: "Ansari And Sons receipt" });
  const nkbParty = partyLine({ id: "p-nkb", credit: 25000, description: "NKB receipt" });
  const nkbCash = cashLine({ id: "c-nkb", debit: 25000, description: "NKB receipt" });
  const jaeccoParty = partyLine({ id: "p-jaecco", credit: 7000, description: "Jaecco receipt" });
  const jaeccoCash = cashLine({ id: "c-jaecco", debit: 7000, description: "Jaecco receipt" });

  const allLines = [ansariParty, ansariCash, nkbParty, nkbCash, jaeccoParty, jaeccoCash];

  assert.equal(findPairedCashBankLine(ansariParty, allLines)?.id, "c-ansari");
  assert.equal(findPairedCashBankLine(nkbParty, allLines)?.id, "c-nkb");
  assert.equal(findPairedCashBankLine(jaeccoParty, allLines)?.id, "c-jaecco");
});

test("findPairedCashBankLine: bundled entry with a genuine signature collision is never guessed", () => {
  // Two different parties' receipts in the same bundled submission
  // happen to share the exact same description AND amount (no
  // sourceId/sourceNumber to disambiguate) - genuinely
  // unidentifiable, must be excluded rather than guessed.
  const partyA = partyLine({ id: "p-a", credit: 5000, description: "Cash receipt" });
  const partyB = partyLine({ id: "p-b", credit: 5000, description: "Cash receipt" });
  const cash1 = cashLine({ id: "c-1", debit: 5000, description: "Cash receipt" });
  const cash2 = cashLine({ id: "c-2", debit: 5000, description: "Cash receipt" });

  const allLines = [partyA, partyB, cash1, cash2];
  assert.equal(findPairedCashBankLine(partyA, allLines), null);
  assert.equal(findPairedCashBankLine(partyB, allLines), null);
});

test("findPairedCashBankLine: bundled entry disambiguates by sourceNumber when descriptions collide", () => {
  const partyA = partyLine({ id: "p-a", credit: 5000, description: "Cash receipt", sourceNumber: "A" });
  const partyB = partyLine({ id: "p-b", credit: 5000, description: "Cash receipt", sourceNumber: "B" });
  const cashA = cashLine({ id: "c-a", debit: 5000, description: "Cash receipt", sourceNumber: "A" });
  const cashB = cashLine({ id: "c-b", debit: 5000, description: "Cash receipt", sourceNumber: "B" });

  const allLines = [partyA, partyB, cashA, cashB];
  assert.equal(findPairedCashBankLine(partyA, allLines)?.id, "c-a");
  assert.equal(findPairedCashBankLine(partyB, allLines)?.id, "c-b");
});

// ------------------------------------------------------------
// capOpeningBalanceByCurrentBalance() - a party's historical opening
// figure must never stay "open" once the account's REAL current
// balance (every live line, not just FIFO-tracked ones) shows it has
// already been offset by other activity (bundled receipts, direct
// fuel/trip expense postings, etc.).
// ------------------------------------------------------------

test("Opening balance cap: current balance fully offsets the opening (opposite direction) -> cleared (null)", () => {
  const derived = { totalDue: 50000, direction: "RECEIVABLE" as const, earliestDate: new Date("2024-01-01") };
  // Opening was a RECEIVABLE (party owed ANC), but the account's
  // current live balance has flipped to a net CREDIT (payable) -
  // the opening has been more than fully repaid via other channels.
  const capped = capOpeningBalanceByCurrentBalance(derived, -20000);
  assert.equal(capped, null);
});

test("Opening balance cap: current balance is exactly zero -> cleared (null)", () => {
  const derived = { totalDue: 50000, direction: "RECEIVABLE" as const, earliestDate: new Date("2024-01-01") };
  const capped = capOpeningBalanceByCurrentBalance(derived, 0);
  assert.equal(capped, null);
});

test("Opening balance cap: current balance same direction but smaller -> capped down to the current balance", () => {
  const derived = { totalDue: 50000, direction: "RECEIVABLE" as const, earliestDate: new Date("2024-01-01") };
  const capped = capOpeningBalanceByCurrentBalance(derived, 12000);
  assert.ok(capped);
  assert.equal(capped!.totalDue, 12000);
  assert.equal(capped!.direction, "RECEIVABLE");
});

test("Opening balance cap: current balance same direction and larger -> stays capped at the original opening amount", () => {
  const derived = { totalDue: 50000, direction: "RECEIVABLE" as const, earliestDate: new Date("2024-01-01") };
  // The party has accumulated MORE debt since opening via unrelated
  // channels (real Bilty/Bill dues, their own separate FIFO targets)
  // - the opening itself never inflates beyond its own original figure.
  const capped = capOpeningBalanceByCurrentBalance(derived, 200000);
  assert.ok(capped);
  assert.equal(capped!.totalDue, 50000);
});

test("Opening balance cap: PAYABLE direction mirrors the same rule", () => {
  const derived = { totalDue: 30000, direction: "PAYABLE" as const, earliestDate: new Date("2024-01-01") };
  const partiallyOffset = capOpeningBalanceByCurrentBalance(derived, -10000);
  assert.ok(partiallyOffset);
  assert.equal(partiallyOffset!.totalDue, 10000);

  const fullyOffset = capOpeningBalanceByCurrentBalance(derived, 5000);
  assert.equal(fullyOffset, null);
});

// ------------------------------------------------------------
// isEligibleForAllocation() - every sourceType whose own document
// already reads its tagged Daily Posting lines for an "already
// received/paid" figure must be excluded from generic FIFO
// allocation, or that same money double-counts against both
// mechanisms.
// ------------------------------------------------------------

function payment(sourceType: string | null): PaymentLineInfo {
  return {
    journalLineId: "line-1",
    amount: 1000,
    direction: "CREDIT",
    partyAccountId: "acct-1",
    partyId: "party-1",
    entryDate: new Date(),
    isDeleted: false,
    sourceType,
  };
}

test("isEligibleForAllocation: document-linked sourceTypes (CHALLAN/BILTY/BILL/PRIVATE_PHONCH/PHONCH) are never eligible", () => {
  for (const sourceType of ["CHALLAN", "BILTY", "BILL", "PRIVATE_PHONCH", "PHONCH"]) {
    assert.equal(isEligibleForAllocation(payment(sourceType)), false, `${sourceType} should not be eligible`);
  }
});

test("isEligibleForAllocation: a lumpsum payment with no document (null/DIRECT/PARTY/ACCOUNT) is eligible", () => {
  for (const sourceType of [null, "DIRECT", "PARTY", "ACCOUNT"]) {
    assert.equal(isEligibleForAllocation(payment(sourceType)), true, `${sourceType} should be eligible`);
  }
});
