import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCollectionFloorForBilty } from "./settlement-payments";

// RH International Goods forensic report (Challan #6423): a PAID row
// created/raised AFTER explicit new-engine COLLECTION rows already
// exist for the same Bilty must not re-claim the slice those rows
// already cover for the OLD single-payer default. Before the fix,
// the floor was biltyTotal - paidAmount alone (ignoring active
// COLLECTION rows), which re-attributed a Rupee already explicitly
// collected back to the OLD default's party too - understating the
// real payable by exactly the double-counted amount.

test("no Paid row, no active Collection rows - floor is the full Bilty total", () => {
  assert.equal(computeCollectionFloorForBilty(300000, 0, 0), 300000);
});

test("Paid row only (no active Collection rows) - floor is total minus Paid", () => {
  assert.equal(computeCollectionFloorForBilty(300000, 200000, 0), 100000);
});

test("active Collection rows only (no Paid row) - floor is total minus active rows", () => {
  assert.equal(computeCollectionFloorForBilty(300000, 0, 100000), 200000);
});

test("Paid row AND active Collection rows together - both are carved out (the exact RH bug)", () => {
  // total=300,000, Paid=200,000 (toPay dropped to 100,000), and
  // 65,000+35,000=100,000 already explicitly collected against this
  // same Bilty. The old default must retain NOTHING (0) - not
  // 100,000 (total - Paid alone, the pre-fix bug), since the full
  // remaining 100,000 is already covered by the active rows.
  assert.equal(computeCollectionFloorForBilty(300000, 200000, 100000), 0);
});

test("over-attribution (Paid + active rows exceed total) never returns negative", () => {
  assert.equal(computeCollectionFloorForBilty(300000, 200000, 150000), 0);
});

test("partial coverage - only the uncovered remainder stays with the old default", () => {
  assert.equal(computeCollectionFloorForBilty(300000, 150000, 50000), 100000);
});
