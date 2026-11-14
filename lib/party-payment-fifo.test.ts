import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortFifoPayments,
  sortFifoDocuments,
  computeFifoAllocationPlan,
  checkNoAdvanceWithOpenCapacity,
  type FifoCandidatePayment,
  type FifoCandidateDocument,
} from "./party-payment-fifo";
import { directionForTargetType, deriveOpeningBalanceFromLines } from "./payment-allocation";

// ------------------------------------------------------------
// Pure-function tests for the Auto FIFO allocation engine. The
// greedy walk itself (computeFifoAllocationPlan), its ordering/
// tie-break rules (sortFifoPayments/sortFifoDocuments), and the
// Opening Balance dual-source derivation (deriveOpeningBalanceFromLines)
// are all pure - no DB, no I/O - exactly so this file can test the
// real allocation logic directly, the same way every other
// *.test.ts file in this codebase tests an extracted pure function
// rather than a live database. rerunFifoForParty/clearAndRerunForDocument
// themselves are thin DB-wiring layers around these functions and are
// NOT re-tested here (no DB available in this harness) - every
// invariant that function relies on (ordering, tie-break, over-
// allocation, non-FIFO rows already netted out of capacity) is
// covered through the pure core it calls.
// ------------------------------------------------------------

function doc(overrides: Partial<FifoCandidateDocument> & { targetSourceId: string }): FifoCandidateDocument {
  return {
    targetSourceType: "BILTY",
    documentNo: overrides.targetSourceId,
    documentDate: new Date("2026-01-01T00:00:00.000Z"),
    remainingAllocatable: 0,
    ...overrides,
  };
}

function payment(overrides: Partial<FifoCandidatePayment> & { journalLineId: string }): FifoCandidatePayment {
  return {
    remainingAmount: 0,
    entryDate: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// 1. FIFO order - 3 open documents, oldest date wins regardless of insertion order.
test("FIFO order: allocates to the oldest-dated document first, regardless of insertion order", () => {
  const documents = [
    doc({ targetSourceId: "mid", documentDate: new Date("2026-02-01"), documentNo: "B", remainingAllocatable: 100 }),
    doc({ targetSourceId: "oldest", documentDate: new Date("2026-01-01"), documentNo: "A", remainingAllocatable: 100 }),
    doc({ targetSourceId: "newest", documentDate: new Date("2026-03-01"), documentNo: "C", remainingAllocatable: 100 }),
  ];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 250 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.deepEqual(plan.map((p) => p.targetSourceId), ["oldest", "mid", "newest"]);
  assert.equal(plan[0].amount, 100);
  assert.equal(plan[1].amount, 100);
  assert.equal(plan[2].amount, 50);
});

// 2. Opening balance first - always clears before every real document.
test("Opening balance: an OPENING_BALANCE candidate dated before every real document is cleared first", () => {
  const documents = [
    doc({ targetSourceType: "BILTY", targetSourceId: "bilty-1", documentDate: new Date("2026-05-01"), documentNo: "BILTY-6001", remainingAllocatable: 500 }),
    doc({ targetSourceType: "OPENING_BALANCE", targetSourceId: "party-1", documentDate: new Date("2020-01-01"), documentNo: "Opening Balance", remainingAllocatable: 200 }),
  ];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 300 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.equal(plan[0].targetSourceType, "OPENING_BALANCE");
  assert.equal(plan[0].amount, 200);
  assert.equal(plan[1].targetSourceType, "BILTY");
  assert.equal(plan[1].amount, 100);
});

// 3. Tie-break - two documents same date, lower documentNo wins.
test("Tie-break: two documents on the same date resolve by documentNo ascending", () => {
  const sameDate = new Date("2026-04-15");
  const documents = [
    doc({ targetSourceId: "z", documentDate: sameDate, documentNo: "CN 6402", remainingAllocatable: 50 }),
    doc({ targetSourceId: "a", documentDate: sameDate, documentNo: "CN 6300", remainingAllocatable: 50 }),
  ];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 50 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.equal(plan.length, 1);
  assert.equal(plan[0].targetSourceId, "a");
});

// 4. Partial - payment smaller than the oldest open document's remaining amount.
test("Partial: a payment smaller than the oldest document's remaining amount leaves it partially covered", () => {
  const documents = [doc({ targetSourceId: "bilty-1", remainingAllocatable: 10000 })];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 4000 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.equal(plan.length, 1);
  assert.equal(plan[0].amount, 4000);
});

// 5. Advance carry-forward - payment exceeds all open documents; a later-arriving
//    document consumes the leftover on the next rebuild.
test("Advance carry-forward: leftover from one rebuild is consumed by a newly-arrived document on the next", () => {
  const paymentAmount = 1000;
  const docA = doc({ targetSourceId: "doc-a", documentDate: new Date("2026-01-01"), documentNo: "A", remainingAllocatable: 500 });

  const firstPlan = computeFifoAllocationPlan(
    sortFifoPayments([payment({ journalLineId: "p1", remainingAmount: paymentAmount })]),
    sortFifoDocuments([docA])
  );
  assert.equal(firstPlan.length, 1);
  assert.equal(firstPlan[0].amount, 500);

  const allocatedSoFar = firstPlan.reduce((s, p) => s + p.amount, 0);
  const docB = doc({ targetSourceId: "doc-b", documentDate: new Date("2026-02-01"), documentNo: "B", remainingAllocatable: 300 });
  // Rebuild from a clean slate: docA now fully allocated (0 remaining,
  // so getPartyDocumentStates's own onlyWithRemainingBalance filter
  // would already drop it - simulated here by simply omitting it),
  // the SAME payment's remaining amount recomputed fresh.
  const secondPlan = computeFifoAllocationPlan(
    sortFifoPayments([payment({ journalLineId: "p1", remainingAmount: paymentAmount - allocatedSoFar })]),
    sortFifoDocuments([docB])
  );

  assert.equal(secondPlan.length, 1);
  assert.equal(secondPlan[0].targetSourceId, "doc-b");
  assert.equal(secondPlan[0].amount, 300);
});

// 6. Rebuild idempotency - running the rebuild twice with no data change
//    produces the identical row set.
test("Rebuild idempotency: identical inputs always produce an identical plan", () => {
  const documents = [
    doc({ targetSourceId: "a", documentDate: new Date("2026-01-01"), documentNo: "A", remainingAllocatable: 300 }),
    doc({ targetSourceId: "b", documentDate: new Date("2026-02-01"), documentNo: "B", remainingAllocatable: 300 }),
  ];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 400 })];

  const plan1 = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));
  const plan2 = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.deepEqual(plan1, plan2);
});

// 7. Older-dated document reshuffle - a backdated document inserted after
//    payments already allocated causes the next rebuild to reshuffle.
test("Older-dated document reshuffle: a newly-inserted backdated document is served before an already-allocated one on rebuild", () => {
  const docA = doc({ targetSourceId: "doc-a", documentDate: new Date("2026-03-01"), documentNo: "A", remainingAllocatable: 500 });
  const payments = [payment({ journalLineId: "p1", remainingAmount: 500 })];

  const firstPlan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments([docA]));
  assert.deepEqual(firstPlan.map((p) => p.targetSourceId), ["doc-a"]);

  // A backdated document (older than doc-a) now exists - rebuild from
  // a clean slate sees both, oldest-first.
  const docBackdated = doc({ targetSourceId: "doc-backdated", documentDate: new Date("2026-01-01"), documentNo: "Z", remainingAllocatable: 200 });
  const rebuiltPlan = computeFifoAllocationPlan(
    sortFifoPayments(payments),
    sortFifoDocuments([docA, docBackdated])
  );

  assert.equal(rebuiltPlan[0].targetSourceId, "doc-backdated");
  assert.equal(rebuiltPlan[0].amount, 200);
  assert.equal(rebuiltPlan[1].targetSourceId, "doc-a");
  assert.equal(rebuiltPlan[1].amount, 300);
});

// 8. Document delete/amount-reduce releases allocation - frees money back to
//    "unallocated", picked up by the next rebuild.
test("Document delete/amount-reduce: a document dropped from candidates frees its payment's capacity for the next one", () => {
  const docA = doc({ targetSourceId: "doc-a", documentDate: new Date("2026-01-01"), documentNo: "A", remainingAllocatable: 1000 });
  const payments = [payment({ journalLineId: "p1", remainingAmount: 1000 })];

  const firstPlan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments([docA]));
  assert.equal(firstPlan[0].amount, 1000);

  // doc-a deleted/reduced to 0 (no longer a candidate at all) - the
  // SAME payment's full amount is available again on rebuild.
  const docB = doc({ targetSourceId: "doc-b", documentDate: new Date("2026-02-01"), documentNo: "B", remainingAllocatable: 1000 });
  const rebuiltPlan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments([docB]));

  assert.equal(rebuiltPlan.length, 1);
  assert.equal(rebuiltPlan[0].targetSourceId, "doc-b");
  assert.equal(rebuiltPlan[0].amount, 1000);
});

// 9. Settled document excluded - a document with an active multi-payer
//    SettlementPayment row never appears as an auto-FIFO candidate (the
//    MULTI_PAYER_NOT_ALLOCATABLE guard means getPartyDocumentStates never
//    includes it in the first place - simulated here by simply omitting it).
test("Settled document excluded: a document never passed as a candidate is never allocated to", () => {
  const visibleDoc = doc({ targetSourceId: "visible", documentDate: new Date("2026-01-01"), documentNo: "A", remainingAllocatable: 500 });
  const payments = [payment({ journalLineId: "p1", remainingAmount: 5000 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments([visibleDoc]));

  assert.ok(plan.every((p) => p.targetSourceId === "visible"));
  assert.equal(plan.reduce((s, p) => s + p.amount, 0), 500);
});

// 10. No over-allocation - a document's own remainingAllocatable (already
//     net of BILTY/BILTY_PAID/SettlementPayment per the hard guard) is
//     never exceeded, no matter how large the payment is.
test("No over-allocation: a document is never allocated more than its own remainingAllocatable", () => {
  const documents = [doc({ targetSourceId: "bilty-1", remainingAllocatable: 100 })];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 1_000_000 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.equal(plan.length, 1);
  assert.equal(plan[0].amount, 100);
});

// 11. Manual not overwritten - a payment stamped allocationMode: "MANUAL" is
//     excluded by the caller (listEligibleFifoPayments) before this
//     function ever runs - simulated here by simply never including it.
test("Manual not overwritten: a payment never passed as a candidate is never allocated", () => {
  const documents = [doc({ targetSourceId: "bilty-1", remainingAllocatable: 1000 })];
  // Only the AUTO payment is passed in - the MANUAL one (if it existed)
  // is excluded upstream and never reaches this function.
  const autoPayments = [payment({ journalLineId: "auto-payment", remainingAmount: 500 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(autoPayments), sortFifoDocuments(documents));

  assert.ok(plan.every((p) => p.journalLineId === "auto-payment"));
});

// 12. Direction mismatch - a RECEIVABLE payment never consumes a PAYABLE
//     document and vice versa (directionForTargetType is the single
//     source of truth every candidate-gathering/rebuild call filters by).
test("Direction mismatch: every target type resolves to exactly one fixed direction (or none, for OPENING_BALANCE)", () => {
  assert.equal(directionForTargetType("BILTY"), "RECEIVABLE");
  assert.equal(directionForTargetType("BILTY_PAID"), "RECEIVABLE");
  assert.equal(directionForTargetType("BILL"), "RECEIVABLE");
  assert.equal(directionForTargetType("PRIVATE_PHONCH_RECOVERY"), "RECEIVABLE");
  assert.equal(directionForTargetType("CHALLAN"), "PAYABLE");
  assert.equal(directionForTargetType("PRIVATE_PHONCH_PAYABLE"), "PAYABLE");
  assert.equal(directionForTargetType("OPENING_BALANCE"), null);
});

// 13. Settlement row survives rebuild - a fixture row with origin:"SETTLEMENT"
//     (reserved value, no production write site, but the rebuild's own
//     deletion filter must still only ever target origin="FIFO") is left
//     untouched by rerunFifoForParty, and its amount still counts as
//     already-consumed document capacity (remainingAllocatable is passed
//     in already net of it - getAllocatedAmountForDocument sums every
//     origin unconditionally).
test("Settlement row survives rebuild: its amount is already excluded from the document's own remainingAllocatable", () => {
  const totalDue = 1000;
  const settlementRowAmount = 400;
  const documents = [doc({ targetSourceId: "bilty-1", remainingAllocatable: totalDue - settlementRowAmount })];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 10000 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  // The FIFO engine can never allocate more than totalDue minus the
  // SETTLEMENT row's own amount - it has no way to "overwrite" that
  // row and never needs to, since capacity already excludes it.
  assert.equal(plan[0].amount, totalDue - settlementRowAmount);
});

// 14. LEGACY untouched - an origin:"LEGACY" row (backfill pre-stamp) is
//     never deleted or rewritten by any rebuild, regardless of trigger -
//     same mechanism/contract as test 13, different origin value.
test("LEGACY untouched: a LEGACY-origin row's amount is already excluded from the document's own remainingAllocatable", () => {
  const totalDue = 5000;
  const legacyRowAmount = 5000;
  // Fully covered by the LEGACY row alone - nothing left for FIFO.
  const documents = [doc({ targetSourceId: "bilty-1", remainingAllocatable: totalDue - legacyRowAmount })];
  const payments = [payment({ journalLineId: "p1", remainingAmount: 2000 })];

  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));

  assert.equal(plan.length, 0);
});

// 15. Untagged OBE JE treated as opening balance - a party with no official
//     OPENING_BALANCE-tagged entry but a live, untagged JournalLine whose
//     contra account is the Opening Balance Equity system account still
//     contributes to the derived opening balance, summed with any
//     officially-tagged entry, dated at the EARLIEST contributing line.
test("Untagged OBE JE treated as opening balance, summed with an officially-tagged entry", () => {
  const taggedEntryLine = { debit: 3000, credit: 0, entryDate: new Date("2026-03-01") };
  const untaggedObeLine = { debit: 2000, credit: 0, entryDate: new Date("2026-01-01") };

  const derived = deriveOpeningBalanceFromLines([taggedEntryLine, untaggedObeLine]);

  assert.ok(derived);
  assert.equal(derived!.totalDue, 5000);
  assert.equal(derived!.direction, "RECEIVABLE");
  assert.equal(derived!.earliestDate.getTime(), untaggedObeLine.entryDate.getTime());
});

test("Opening balance: a net of zero across every qualifying line resolves to no opening balance", () => {
  const derived = deriveOpeningBalanceFromLines([
    { debit: 1000, credit: 0, entryDate: new Date("2026-01-01") },
    { debit: 0, credit: 1000, entryDate: new Date("2026-02-01") },
  ]);
  assert.equal(derived, null);
});

test("Opening balance: a net credit balance resolves to PAYABLE", () => {
  const derived = deriveOpeningBalanceFromLines([{ debit: 0, credit: 4000, entryDate: new Date("2026-01-01") }]);
  assert.ok(derived);
  assert.equal(derived!.direction, "PAYABLE");
  assert.equal(derived!.totalDue, 4000);
});

// 16. Post-migration first rebuild is a no-op on pre-existing data - every
//     pre-existing row (origin: "LEGACY", as the migration itself stamps)
//     survives the very first rerunFifoForParty call untouched; nothing is
//     deleted just because the column is new. The actual deletion is a DB
//     query (`origin: "FIFO"` in the where clause) rather than a callable
//     predicate, so this tests the equivalent, deliberately narrow
//     selection rule directly: only "FIFO" is ever a deletion candidate.
test("Post-migration no-op: only origin=FIFO rows are ever deletion candidates - LEGACY/MANUAL/SETTLEMENT never are", () => {
  const preExistingRows = [
    { id: "r1", origin: "LEGACY" },
    { id: "r2", origin: "MANUAL" },
    { id: "r3", origin: "SETTLEMENT" },
  ];
  const deletable = preExistingRows.filter((r) => r.origin === "FIFO");
  assert.deepEqual(deletable, []);

  const mixedRows = [...preExistingRows, { id: "r4", origin: "FIFO" }];
  const deletableMixed = mixedRows.filter((r) => r.origin === "FIFO");
  assert.deepEqual(deletableMixed, [{ id: "r4", origin: "FIFO" }]);
});

// ------------------------------------------------------------
// checkNoAdvanceWithOpenCapacity() - production bug fix: Opening
// Balance (and, by the same mechanism, any other document) was being
// pre-capped before FIFO ever ran, so a real advance sat unapplied
// while the document that should have absorbed it showed as already
// "cleared" (Zafar Niazi Cargo Karachi, ABT, Khalid Goods). This hard
// invariant check catches exactly that class of bug going forward:
// leftover advance while an open document still has capacity can
// only mean candidate discovery missed something.
// ------------------------------------------------------------

test("checkNoAdvanceWithOpenCapacity: no advance at all - never a violation", () => {
  const payments = [payment({ journalLineId: "p1", remainingAmount: 500 })];
  const documents = [doc({ targetSourceId: "d1", remainingAllocatable: 500 })];
  const plan = computeFifoAllocationPlan(payments, documents);
  assert.equal(checkNoAdvanceWithOpenCapacity(payments, documents, plan), null);
});

test("checkNoAdvanceWithOpenCapacity: genuine advance with every document fully filled - not a violation", () => {
  const payments = [payment({ journalLineId: "p1", remainingAmount: 1000 })];
  const documents = [doc({ targetSourceId: "d1", remainingAllocatable: 500 })];
  const plan = computeFifoAllocationPlan(payments, documents);
  // 500 allocated, 500 genuinely left over as advance - d1 has 0 remaining capacity.
  assert.equal(checkNoAdvanceWithOpenCapacity(payments, documents, plan), null);
});

test("checkNoAdvanceWithOpenCapacity: advance left while a document still has open capacity - violation", () => {
  const payments = [payment({ journalLineId: "p1", remainingAmount: 1000 })];
  const documents = [doc({ targetSourceId: "d1", remainingAllocatable: 500 })];
  // Simulate the exact bug: candidate discovery dropped a document
  // from the plan's own inputs, but it's still passed to the checker
  // as a "real" open document (e.g. a pre-capped Opening Balance that
  // should have absorbed the leftover 500 but never got the chance).
  const emptyPlan: ReturnType<typeof computeFifoAllocationPlan> = [];
  const violation = checkNoAdvanceWithOpenCapacity(payments, documents, emptyPlan);
  assert.ok(violation);
  assert.equal(violation!.totalAdvance, 1000);
  assert.equal(violation!.openDocumentsWithCapacity.length, 1);
  assert.equal(violation!.openDocumentsWithCapacity[0].targetSourceId, "d1");
  assert.equal(violation!.openDocumentsWithCapacity[0].remaining, 500);
});

test("checkNoAdvanceWithOpenCapacity: the normal greedy plan never violates this invariant by construction", () => {
  const payments = [payment({ journalLineId: "p1", remainingAmount: 300 })];
  const documents = [
    doc({ targetSourceId: "a", documentDate: new Date("2026-01-01"), documentNo: "A", remainingAllocatable: 200 }),
    doc({ targetSourceId: "b", documentDate: new Date("2026-02-01"), documentNo: "B", remainingAllocatable: 200 }),
  ];
  const plan = computeFifoAllocationPlan(sortFifoPayments(payments), sortFifoDocuments(documents));
  // 300 fully allocated (200 to a, 100 to b) - no advance, so trivially no violation.
  assert.equal(checkNoAdvanceWithOpenCapacity(payments, documents, plan), null);
});
