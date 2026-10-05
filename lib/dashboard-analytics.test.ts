import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePrivatePhonchVehicleAmounts } from "./dashboard-analytics";
import { ageingBucketForDays, bucketAgeing, PartyBalanceRow } from "./receivable-payable";

test("derivePrivatePhonchVehicleAmounts - normal vehicle (Total Rent > 0)", () => {
  const result = derivePrivatePhonchVehicleAmounts({ totalRent: 10000, deliveryCharges: 1000, carrierPayable: 7000 });
  assert.equal(result.netRent, 9000);
  assert.equal(result.caPayable, 2000);
  assert.equal(result.deliveryRecovery, 0);
});

test("derivePrivatePhonchVehicleAmounts - fully-paid vehicle (Total Rent = 0) becomes a Delivery Recovery, never negative Net Rent", () => {
  const result = derivePrivatePhonchVehicleAmounts({ totalRent: 0, deliveryCharges: 1500, carrierPayable: 0 });
  assert.equal(result.netRent, 0);
  assert.equal(result.caPayable, 0);
  assert.equal(result.deliveryRecovery, 1500);
});

test("derivePrivatePhonchVehicleAmounts - Carrier Payable equals Net Rent leaves zero CA Payable", () => {
  const result = derivePrivatePhonchVehicleAmounts({ totalRent: 5000, deliveryCharges: 0, carrierPayable: 5000 });
  assert.equal(result.netRent, 5000);
  assert.equal(result.caPayable, 0);
});

test("ageingBucketForDays - boundaries", () => {
  assert.equal(ageingBucketForDays(0), "Current");
  assert.equal(ageingBucketForDays(1), "1-30 Days");
  assert.equal(ageingBucketForDays(30), "1-30 Days");
  assert.equal(ageingBucketForDays(31), "31-60 Days");
  assert.equal(ageingBucketForDays(90), "61-90 Days");
  assert.equal(ageingBucketForDays(91), "90+ Days");
  assert.equal(ageingBucketForDays(Infinity), "90+ Days");
});

function row(balance: number, lastActivityDate: Date | null): PartyBalanceRow {
  return {
    partyId: "p1",
    partyName: "Test Party",
    accountId: "a1",
    accountName: "Test Account",
    accountCode: null,
    totalDebit: balance,
    totalCredit: 0,
    balance,
    lastActivityDate,
    isSystemAccount: false,
    isActive: true,
    phone: null,
  };
}

test("bucketAgeing - groups by days since last activity, empty balance-with-no-activity falls into 90+ (safe direction)", () => {
  const asOf = new Date(2026, 8, 27);
  const rows = [
    row(1000, new Date(2026, 8, 27)), // Current
    row(2000, new Date(2026, 8, 10)), // 17 days -> 1-30
    row(3000, new Date(2026, 6, 1)), // ~88 days -> 61-90
    row(4000, null), // no activity -> 90+ (safe)
  ];
  const buckets = bucketAgeing(rows, asOf);
  const byLabel = Object.fromEntries(buckets.map((b) => [b.bucket, b]));
  assert.equal(byLabel["Current"].amount, 1000);
  assert.equal(byLabel["1-30 Days"].amount, 2000);
  assert.equal(byLabel["61-90 Days"].amount, 3000);
  assert.equal(byLabel["90+ Days"].amount, 4000);
  assert.equal(byLabel["31-60 Days"].amount, 0);
  assert.equal(byLabel["31-60 Days"].partyCount, 0);
});

test("bucketAgeing - empty input returns all-zero buckets, never fabricated data", () => {
  const buckets = bucketAgeing([], new Date());
  for (const b of buckets) {
    assert.equal(b.amount, 0);
    assert.equal(b.partyCount, 0);
  }
});
