import { test } from "node:test";
import assert from "node:assert/strict";
import { applySettlementCorrection } from "./settlement-correction";

// Correction entries posted BEFORE Settlement (BILTY_BOOKING_CORRECTION /
// CHALLAN_DISPATCH_CORRECTION) must use the ORIGINAL document's own date,
// never today's date (the date the edit happened to be made) - same
// principle as Settlement itself always posting on the Challan date. See
// lib/settlement-correction.ts's applySettlementCorrection() "not yet
// settled" branch.

// Minimal fake `tx`: only the two calls applySettlementCorrection's
// not-yet-settled branch actually makes - tx.account.findFirst (used by
// lib/gross-accounts.ts to resolve the gross clearing account by code,
// pretending it already exists) and tx.journalEntry.create (captured so
// the test can inspect exactly what was posted).
function makeFakeTx() {
  const created: any[] = [];
  const tx = {
    account: {
      findFirst: async () => ({ id: "gross-account-id" }),
    },
    journalEntry: {
      create: async ({ data }: { data: any }) => {
        created.push(data);
        return { id: `je-${created.length}`, ...data };
      },
    },
  };
  return { tx: tx as any, created };
}

test("not-yet-settled COLLECTION correction uses the Bilty's own date, not today", async () => {
  const { tx, created } = makeFakeTx();
  const biltyDate = new Date("2026-10-16T00:00:00.000Z");

  await applySettlementCorrection({
    tx,
    component: "COLLECTION",
    delta: 1000,
    challanId: "challan-1",
    challanNo: "CH-1",
    challanLoadingDate: new Date("2026-10-20T00:00:00.000Z"), // unrelated to this branch
    documentDate: biltyDate,
    biltyId: "bilty-1",
    biltyNo: "B-1",
    incomeOrExpenseAccountId: "booking-income-id",
    isSettled: false,
    settlementJournalEntryId: null,
    createdById: "user-1",
    description: "Correction - Bilty B-1 - Rent 5000 -> 6000",
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].entryDate.getTime(), biltyDate.getTime());
  assert.equal(created[0].referenceType, "BILTY_BOOKING_CORRECTION");
});

test("not-yet-settled COMMISSION correction also uses the Bilty's own date", async () => {
  const { tx, created } = makeFakeTx();
  const biltyDate = new Date("2026-10-16T00:00:00.000Z");

  await applySettlementCorrection({
    tx,
    component: "COMMISSION",
    delta: -200,
    challanId: "challan-1",
    challanNo: "CH-1",
    challanLoadingDate: new Date("2026-10-20T00:00:00.000Z"),
    documentDate: biltyDate,
    biltyId: "bilty-1",
    biltyNo: "B-1",
    incomeOrExpenseAccountId: "commission-expense-id",
    isSettled: false,
    settlementJournalEntryId: null,
    createdById: "user-1",
    description: "Correction - Bilty B-1 - Commission 500 -> 300",
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].entryDate.getTime(), biltyDate.getTime());
  assert.equal(created[0].referenceType, "BILTY_BOOKING_CORRECTION");
});

test("not-yet-settled CARRIER_RENT correction uses the Challan's own date", async () => {
  const { tx, created } = makeFakeTx();
  const challanDate = new Date("2026-10-18T00:00:00.000Z");

  await applySettlementCorrection({
    tx,
    component: "CARRIER_RENT",
    delta: 3000,
    challanId: "challan-1",
    challanNo: "CH-1",
    challanLoadingDate: challanDate,
    documentDate: challanDate,
    biltyId: "",
    biltyNo: "",
    incomeOrExpenseAccountId: "carrier-rent-expense-id",
    isSettled: false,
    settlementJournalEntryId: null,
    createdById: "user-1",
    description: "Correction - CH-1 - Carrier Rent 10000 -> 13000",
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].entryDate.getTime(), challanDate.getTime());
  assert.equal(created[0].referenceType, "CHALLAN_DISPATCH_CORRECTION");
});

test("a correction edited again later still posts on the (new) document date, never today", async () => {
  // Simulates: Bilty dated 16-10 is edited on 26-10 (documentDate stays
  // 16-10, unrelated to "today"); then edited AGAIN later with its own
  // date also changed to 17-10 - the correction now posted uses that NEW
  // document date, per "if the document's own date is edited, new
  // corrections use the new date" - never today's date either way.
  const { tx, created } = makeFakeTx();
  const newBiltyDate = new Date("2026-10-17T00:00:00.000Z");
  const today = new Date();

  await applySettlementCorrection({
    tx,
    component: "COLLECTION",
    delta: 500,
    challanId: "challan-1",
    challanNo: "CH-1",
    challanLoadingDate: new Date("2026-10-20T00:00:00.000Z"),
    documentDate: newBiltyDate,
    biltyId: "bilty-1",
    biltyNo: "B-1",
    incomeOrExpenseAccountId: "booking-income-id",
    isSettled: false,
    settlementJournalEntryId: null,
    createdById: "user-1",
    description: "Correction - Bilty B-1 - Rent 6000 -> 6500",
  });

  assert.equal(created[0].entryDate.getTime(), newBiltyDate.getTime());
  assert.notEqual(created[0].entryDate.toDateString(), today.toDateString());
});

test("zero delta never posts any correction entry", async () => {
  const { tx, created } = makeFakeTx();

  await applySettlementCorrection({
    tx,
    component: "COLLECTION",
    delta: 0,
    challanId: "challan-1",
    challanNo: "CH-1",
    challanLoadingDate: new Date("2026-10-20T00:00:00.000Z"),
    documentDate: new Date("2026-10-16T00:00:00.000Z"),
    biltyId: "bilty-1",
    biltyNo: "B-1",
    incomeOrExpenseAccountId: "booking-income-id",
    isSettled: false,
    settlementJournalEntryId: null,
    createdById: "user-1",
    description: "no-op",
  });

  assert.equal(created.length, 0);
});
