import { test } from "node:test";
import assert from "node:assert/strict";
import { computeConversionImpact, normalizeCarrierNumber } from "./challan-own-carrier-conversion";

test("normalizeCarrierNumber strips punctuation and uppercases", () => {
  assert.equal(normalizeCarrierNumber("CBM-191"), "CBM191");
  assert.equal(normalizeCarrierNumber("cbm 191"), "CBM191");
});

test("normalizeCarrierNumber fixes the documented CMB/CBM transposition typo", () => {
  assert.equal(normalizeCarrierNumber("CMB-191"), "CBM191");
  assert.equal(normalizeCarrierNumber("CMB191"), "CBM191");
});

test("normalizeCarrierNumber never touches an unrelated prefix", () => {
  assert.equal(normalizeCarrierNumber("ABC-191"), "ABC191");
  // "CMB" only at the start, immediately before digits - a real
  // carrier number that happens to contain "CMB" elsewhere is never
  // rewritten.
  assert.equal(normalizeCarrierNumber("XCMB-191"), "XCMB191");
});

// computeConversionImpact() is the read-only engine behind the scan
// script, the bulk script's --dry-run/--apply, and the single-Challan
// "Convert to Own Carrier" action. These tests exercise its
// `blockers` logic against a fake `tx` - the one place a mistake here
// would either silently misstate the ledger (converting something it
// shouldn't) or needlessly block a genuinely clean legacy Challan.

interface Scenario {
  challan: {
    id: string;
    isDeleted: boolean;
    ownCarrierId: string | null;
    transporterPartyId: string | null;
    isSettled: boolean;
    challanNo: string;
    loadingDate: Date;
    status: string;
    transporterPartyName: string | null;
    transporterAccountId: string | null;
    bilties: { id: string; biltyNo: string; total: number; isDeleted: boolean }[];
  };
  carrierRentForwardEntries?: { id: string; referenceType: string; entryDate: Date; description: string; lines: { debit: number; credit: number }[] }[];
  alreadyReversedForwardIds?: string[];
  bookingIncomeLinesByBilty?: Record<string, { debit: number; credit: number }[]>;
  latestRecognitionByBilty?: Record<string, { lines: { debit: number; credit: number }[] } | null>;
  activeSettlementPaymentCount?: number;
  settlementEntryCount?: number;
}

function makeFakeTx(s: Scenario) {
  const tx = {
    challan: {
      findUnique: async () => ({
        id: s.challan.id,
        isDeleted: s.challan.isDeleted,
        ownCarrierId: s.challan.ownCarrierId,
        transporterPartyId: s.challan.transporterPartyId,
        isSettled: s.challan.isSettled,
        challanNo: s.challan.challanNo,
        loadingDate: s.challan.loadingDate,
        status: s.challan.status,
        transporterParty: s.challan.transporterPartyId
          ? { id: s.challan.transporterPartyId, partyName: s.challan.transporterPartyName, account: s.challan.transporterAccountId ? { id: s.challan.transporterAccountId } : null }
          : null,
        bilties: s.challan.bilties.map((b) => ({ bilty: b })),
      }),
    },
    journalEntry: {
      findMany: async ({ where }: any) => {
        if (where.referenceType?.in) {
          // Carrier Rent dispatch forward entries
          return (s.carrierRentForwardEntries ?? []).map((e) => ({ ...e, lines: e.lines }));
        }
        if (where.reversesEntryId?.in) {
          return (s.alreadyReversedForwardIds ?? []).map((id) => ({ reversesEntryId: id }));
        }
        return [];
      },
      findFirst: async ({ where }: any) => {
        // BILTY_REVENUE_RECOGNITION lookup for one Bilty
        const biltyId = where.referenceId as string;
        const entry = (s.latestRecognitionByBilty ?? {})[biltyId];
        return entry ?? null;
      },
      count: async () => s.settlementEntryCount ?? 0,
    },
    journalLine: {
      findMany: async ({ where }: any) => {
        if (where.account?.category === "BOOKING_INCOME") {
          const biltyId = where.sourceId as string;
          return (s.bookingIncomeLinesByBilty ?? {})[biltyId] ?? [];
        }
        // getPartyNetFromSettlement's own lookup (by accountId)
        return [];
      },
    },
    settlementPayment: {
      count: async () => s.activeSettlementPaymentCount ?? 0,
    },
    challanBilty: {
      findMany: async () => s.challan.bilties.map((b) => ({ biltyId: b.id })),
    },
  };
  return tx as any;
}

function baseChallan(overrides: Partial<Scenario["challan"]> = {}): Scenario["challan"] {
  return {
    id: "challan-1",
    isDeleted: false,
    ownCarrierId: null,
    transporterPartyId: "party-1",
    isSettled: false,
    challanNo: "CH-1",
    loadingDate: new Date("2026-09-10T00:00:00.000Z"),
    status: "IN_TRANSIT",
    transporterPartyName: "Al Naeem Cargo",
    transporterAccountId: "account-1",
    bilties: [{ id: "bilty-1", biltyNo: "B-1", total: 400000, isDeleted: false }],
    ...overrides,
  };
}

test("a clean, not-yet-settled legacy Challan is eligible (no blockers)", async () => {
  const tx = makeFakeTx({
    challan: baseChallan(),
    carrierRentForwardEntries: [
      { id: "je-1", referenceType: "CHALLAN_DISPATCH", entryDate: new Date("2026-09-10"), description: "Dispatch", lines: [{ debit: 150000, credit: 0 }, { debit: 0, credit: 150000 }] },
    ],
    bookingIncomeLinesByBilty: { "bilty-1": [{ debit: 0, credit: 400000 }] },
    latestRecognitionByBilty: { "bilty-1": { lines: [{ debit: 400000, credit: 0 }, { debit: 0, credit: 400000 }] } },
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.deepEqual(impact.blockers, []);
  assert.equal(impact.totalCarrierRentToReverse, 150000);
  assert.equal(impact.totalBookingIncomeToReverse, 400000);
  assert.equal(impact.bilties[0].needsManualReview, false);
});

test("a settled Challan is blocked - needs Unsettle first", async () => {
  const tx = makeFakeTx({
    challan: baseChallan({ isSettled: true }),
    carrierRentForwardEntries: [],
    bookingIncomeLinesByBilty: { "bilty-1": [{ debit: 0, credit: 400000 }] },
    latestRecognitionByBilty: { "bilty-1": { lines: [{ debit: 400000, credit: 0 }, { debit: 0, credit: 400000 }] } },
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.ok(impact.blockers.some((b) => b.includes("Unsettle first")));
});

test("a Bilty whose Booking Income no longer matches its plain dispatch recognition is flagged for manual review", async () => {
  // Simulates a post-dispatch rent correction that landed directly on
  // Booking Income (420000 currently sitting there) while the plain
  // recognition entry itself only ever credited 400000 - the gap
  // (20000) would be silently lost if reverseBiltyBookingIncome() were
  // trusted blindly, so this must block instead of auto-converting.
  const tx = makeFakeTx({
    challan: baseChallan(),
    carrierRentForwardEntries: [],
    bookingIncomeLinesByBilty: { "bilty-1": [{ debit: 0, credit: 420000 }] },
    latestRecognitionByBilty: { "bilty-1": { lines: [{ debit: 400000, credit: 0 }, { debit: 0, credit: 400000 }] } },
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.equal(impact.bilties[0].needsManualReview, true);
  assert.ok(impact.blockers.some((b) => b.includes("needs manual review")));
});

test("active Daily Posting payment rows block automatic conversion", async () => {
  const tx = makeFakeTx({
    challan: baseChallan(),
    carrierRentForwardEntries: [],
    bookingIncomeLinesByBilty: { "bilty-1": [{ debit: 0, credit: 400000 }] },
    latestRecognitionByBilty: { "bilty-1": { lines: [{ debit: 400000, credit: 0 }, { debit: 0, credit: 400000 }] } },
    activeSettlementPaymentCount: 1,
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.ok(impact.blockers.some((b) => b.includes("Daily Posting payment")));
});

test("an already-reversed carrier-rent entry is excluded from what would be reversed again", async () => {
  const tx = makeFakeTx({
    challan: baseChallan(),
    carrierRentForwardEntries: [
      { id: "je-1", referenceType: "CHALLAN_DISPATCH", entryDate: new Date("2026-09-10"), description: "Dispatch", lines: [{ debit: 150000, credit: 0 }, { debit: 0, credit: 150000 }] },
    ],
    alreadyReversedForwardIds: ["je-1"],
    bookingIncomeLinesByBilty: { "bilty-1": [{ debit: 0, credit: 400000 }] },
    latestRecognitionByBilty: { "bilty-1": { lines: [{ debit: 400000, credit: 0 }, { debit: 0, credit: 400000 }] } },
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.equal(impact.carrierRentEntries.length, 0);
  assert.equal(impact.totalCarrierRentToReverse, 0);
});

test("already an Own Carrier dispatch, or no Transporter at all, is blocked", async () => {
  const tx1 = makeFakeTx({ challan: baseChallan({ ownCarrierId: "carrier-1" }) });
  const impact1 = await computeConversionImpact(tx1, "challan-1");
  assert.ok(impact1.blockers.some((b) => b.includes("already an Own Carrier")));

  const tx2 = makeFakeTx({ challan: baseChallan({ transporterPartyId: null, transporterAccountId: null }) });
  const impact2 = await computeConversionImpact(tx2, "challan-1");
  assert.ok(impact2.blockers.some((b) => b.includes("no Transporter")));
});
