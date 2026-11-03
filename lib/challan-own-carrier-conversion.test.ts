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
// "Convert to Own Carrier" action. These tests exercise its signed-net
// math and `blockers` logic against a fake `tx` - the one place a
// mistake here would either silently misstate the ledger (converting
// something it shouldn't, or reporting the wrong amount) or needlessly
// block a genuinely clean legacy Challan.

interface CarrierRentLine {
  debit: number;
  credit: number;
  category: string;
}

interface CarrierRentEntryFixture {
  id: string;
  referenceType: string;
  entryDate: Date;
  description: string;
  lines: CarrierRentLine[];
}

interface BookingIncomeLineFixture {
  journalEntryId: string;
  referenceType: string;
  entryDate: Date;
  debit: number;
  credit: number;
}

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
    carrierRent: number;
    transporterPartyName: string | null;
    transporterAccountId: string | null;
    bilties: { id: string; biltyNo: string; total: number; isDeleted: boolean }[];
  };
  carrierRentForwardEntries?: CarrierRentEntryFixture[];
  alreadyReversedForwardIds?: string[];
  bookingIncomeLinesByBilty?: Record<string, BookingIncomeLineFixture[]>;
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
        carrierRent: s.challan.carrierRent,
        transporterParty: s.challan.transporterPartyId
          ? { id: s.challan.transporterPartyId, partyName: s.challan.transporterPartyName, account: s.challan.transporterAccountId ? { id: s.challan.transporterAccountId } : null }
          : null,
        bilties: s.challan.bilties.map((b) => ({ bilty: b })),
      }),
    },
    journalEntry: {
      findMany: async ({ where }: any) => {
        if (where.referenceType?.in) {
          return (s.carrierRentForwardEntries ?? []).map((e) => ({
            ...e,
            lines: e.lines.map((l) => ({ debit: l.debit, credit: l.credit, account: { category: l.category } })),
          }));
        }
        if (where.reversesEntryId?.in) {
          return (s.alreadyReversedForwardIds ?? []).map((id) => ({ reversesEntryId: id }));
        }
        return [];
      },
      count: async () => s.settlementEntryCount ?? 0,
    },
    journalLine: {
      findMany: async ({ where }: any) => {
        if (where.account?.category === "BOOKING_INCOME") {
          const biltyId = where.sourceId as string;
          return (s.bookingIncomeLinesByBilty ?? {})[biltyId]?.map((l) => ({
            debit: l.debit,
            credit: l.credit,
            journalEntryId: l.journalEntryId,
            journalEntry: { referenceType: l.referenceType, entryDate: l.entryDate },
          })) ?? [];
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
    carrierRent: 0,
    transporterPartyName: "Al Naeem Cargo",
    transporterAccountId: "account-1",
    bilties: [{ id: "bilty-1", biltyNo: "B-1", total: 400000, isDeleted: false }],
    ...overrides,
  };
}

test("a clean, not-yet-settled legacy Challan is eligible (no blockers)", async () => {
  const tx = makeFakeTx({
    challan: baseChallan({ carrierRent: 150000 }),
    carrierRentForwardEntries: [
      {
        id: "je-1",
        referenceType: "CHALLAN_DISPATCH",
        entryDate: new Date("2026-09-10"),
        description: "Dispatch",
        lines: [
          { debit: 150000, credit: 0, category: "CARRIER_RENT" },
          { debit: 0, credit: 150000, category: "TRANSPORTER_PAYABLE" },
        ],
      },
    ],
    bookingIncomeLinesByBilty: {
      "bilty-1": [{ journalEntryId: "je-rec-1", referenceType: "BILTY_REVENUE_RECOGNITION", entryDate: new Date("2026-09-10"), debit: 0, credit: 400000 }],
    },
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
    bookingIncomeLinesByBilty: {
      "bilty-1": [{ journalEntryId: "je-rec-1", referenceType: "BILTY_REVENUE_RECOGNITION", entryDate: new Date("2026-09-10"), debit: 0, credit: 400000 }],
    },
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.ok(impact.blockers.some((b) => b.includes("Unsettle first")));
});

test("a Carrier Rent reduced by a correction nets to the CURRENT amount, not the unsigned sum of entries (production bug: Challan 6506 - 45,000 increase + 45,000 decrease = 0, not 90,000)", async () => {
  const tx = makeFakeTx({
    challan: baseChallan({ carrierRent: 0 }),
    carrierRentForwardEntries: [
      {
        id: "je-1", referenceType: "CHALLAN_DISPATCH", entryDate: new Date("2026-09-10"), description: "Dispatch - Carrier Rent",
        lines: [{ debit: 45000, credit: 0, category: "CARRIER_RENT" }, { debit: 0, credit: 45000, category: "TRANSPORTER_PAYABLE" }],
      },
      {
        id: "je-2", referenceType: "CHALLAN_DISPATCH_CORRECTION", entryDate: new Date("2026-09-10"), description: "Correction - Carrier Rent 45000 -> 0",
        lines: [{ debit: 0, credit: 45000, category: "CARRIER_RENT" }, { debit: 45000, credit: 0, category: "TRANSPORTER_PAYABLE" }],
      },
    ],
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.equal(impact.carrierRentEntries[0].amount, 45000);
  assert.equal(impact.carrierRentEntries[1].amount, -45000);
  assert.equal(impact.totalCarrierRentToReverse, 0);
  assert.equal(impact.challanCarrierRentField, 0);
});

test("a Carrier Rent with multiple reducing corrections nets correctly (production bug: Challan 6402 - 350,000 + (-50,000) + (-50,000) = 250,000, not 450,000)", async () => {
  const tx = makeFakeTx({
    challan: baseChallan({ carrierRent: 250000 }),
    carrierRentForwardEntries: [
      {
        id: "je-1", referenceType: "CHALLAN_DISPATCH", entryDate: new Date("2026-09-10"), description: "Dispatch",
        lines: [{ debit: 350000, credit: 0, category: "CARRIER_RENT" }, { debit: 0, credit: 350000, category: "TRANSPORTER_PAYABLE" }],
      },
      {
        id: "je-2", referenceType: "CHALLAN_DISPATCH_CORRECTION", entryDate: new Date("2026-09-10"), description: "Correction 1",
        lines: [{ debit: 0, credit: 50000, category: "CARRIER_RENT" }, { debit: 50000, credit: 0, category: "TRANSPORTER_PAYABLE" }],
      },
      {
        id: "je-3", referenceType: "CHALLAN_DISPATCH_CORRECTION", entryDate: new Date("2026-09-10"), description: "Correction 2",
        lines: [{ debit: 0, credit: 50000, category: "CARRIER_RENT" }, { debit: 50000, credit: 0, category: "TRANSPORTER_PAYABLE" }],
      },
    ],
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.equal(impact.totalCarrierRentToReverse, 250000);
  assert.equal(impact.challanCarrierRentField, 250000);
});

test("a legacy Bilty (booked before Unearned Revenue, Booking Income credited directly, later reduced by a correction) is NOT flagged - its current net is simply reversed", async () => {
  // Production case (Bilty 6508): rent was reduced from 40,000 to
  // 32,500 after a direct legacy booking credit - two source entries
  // (40000 - 7500 = 32500), neither of them a BILTY_REVENUE_RECOGNITION
  // entry at all. Must reverse exactly 32,500, never flag a mismatch.
  const tx = makeFakeTx({
    challan: baseChallan({ bilties: [{ id: "bilty-1", biltyNo: "6508", total: 32500, isDeleted: false }] }),
    bookingIncomeLinesByBilty: {
      "bilty-1": [
        { journalEntryId: "je-legacy-booking", referenceType: "BILTY_BOOKING", entryDate: new Date("2026-09-10"), debit: 0, credit: 40000 },
        { journalEntryId: "je-correction", referenceType: "BILTY_BOOKING_CORRECTION", entryDate: new Date("2026-09-15"), debit: 7500, credit: 0 },
      ],
    },
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.equal(impact.bilties[0].currentBookingIncomeNet, 32500);
  assert.equal(impact.bilties[0].needsManualReview, false);
  assert.equal(impact.bilties[0].sourceEntries.length, 2);
  assert.equal(impact.totalBookingIncomeToReverse, 32500);
  assert.deepEqual(impact.blockers, []);
});

test("Booking Income negative, or exceeding the Bilty's own total, is blocked for manual review", async () => {
  const txNegative = makeFakeTx({
    challan: baseChallan({ bilties: [{ id: "bilty-1", biltyNo: "B-1", total: 400000, isDeleted: false }] }),
    bookingIncomeLinesByBilty: {
      "bilty-1": [{ journalEntryId: "je-1", referenceType: "BILTY_BOOKING", entryDate: new Date(), debit: 10000, credit: 0 }],
    },
  });
  const impactNegative = await computeConversionImpact(txNegative, "challan-1");
  assert.equal(impactNegative.bilties[0].needsManualReview, true);

  const txExceeds = makeFakeTx({
    challan: baseChallan({ bilties: [{ id: "bilty-1", biltyNo: "B-1", total: 400000, isDeleted: false }] }),
    bookingIncomeLinesByBilty: {
      "bilty-1": [{ journalEntryId: "je-1", referenceType: "BILTY_BOOKING", entryDate: new Date(), debit: 0, credit: 420000 }],
    },
  });
  const impactExceeds = await computeConversionImpact(txExceeds, "challan-1");
  assert.equal(impactExceeds.bilties[0].needsManualReview, true);
  assert.ok(impactExceeds.blockers.some((b) => b.includes("needs manual review")));
});

test("active Daily Posting payment rows are kept (reported), never a blocker", async () => {
  const tx = makeFakeTx({
    challan: baseChallan(),
    bookingIncomeLinesByBilty: {
      "bilty-1": [{ journalEntryId: "je-1", referenceType: "BILTY_REVENUE_RECOGNITION", entryDate: new Date(), debit: 0, credit: 400000 }],
    },
    activeSettlementPaymentCount: 6,
  });

  const impact = await computeConversionImpact(tx, "challan-1");
  assert.equal(impact.activeSettlementPaymentCount, 6);
  assert.deepEqual(impact.blockers, []);
});

test("an already-reversed carrier-rent entry is excluded from what would be reversed again", async () => {
  const tx = makeFakeTx({
    challan: baseChallan({ carrierRent: 0 }),
    carrierRentForwardEntries: [
      {
        id: "je-1", referenceType: "CHALLAN_DISPATCH", entryDate: new Date("2026-09-10"), description: "Dispatch",
        lines: [{ debit: 150000, credit: 0, category: "CARRIER_RENT" }, { debit: 0, credit: 150000, category: "TRANSPORTER_PAYABLE" }],
      },
    ],
    alreadyReversedForwardIds: ["je-1"],
    bookingIncomeLinesByBilty: {
      "bilty-1": [{ journalEntryId: "je-rec-1", referenceType: "BILTY_REVENUE_RECOGNITION", entryDate: new Date(), debit: 0, credit: 400000 }],
    },
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
