import { test } from "node:test";
import assert from "node:assert/strict";
import { calcOfficeCommission, calcCarrierProfit, isDriverCashReceipt, isDriverPaidCashExpense } from "./carrier-slip";

// ANC Office Commission - locked formula, kept separate from Carrier Profit.

test("calcOfficeCommission: Total Bilty Rent minus Carrier Rent", () => {
  assert.equal(calcOfficeCommission(280000, 280000), 0);
  assert.equal(calcOfficeCommission(160000, 140000), 20000);
});

test("calcOfficeCommission: never mixed into Carrier Profit even when both are computed from the same inputs", () => {
  const totalBiltyRent = 160000;
  const carrierRent = 140000;
  const totalExpenses = 62000;
  const commission = calcOfficeCommission(totalBiltyRent, carrierRent);
  const profit = calcCarrierProfit(carrierRent, totalExpenses);
  assert.equal(commission, 20000);
  assert.equal(profit, 78000);
  // Changing commission's own inputs must never move profit, and vice versa.
  assert.notEqual(commission, profit);
});

// Carrier Profit - locked formula.

test("calcCarrierProfit: Carrier Rent minus Total Carrier Expenses", () => {
  assert.equal(calcCarrierProfit(280000, 96000), 184000);
});

test("calcCarrierProfit: a loss-making trip returns a negative profit, never clamped", () => {
  assert.equal(calcCarrierProfit(50000, 80000), -30000);
});

// Driver Cash Received - Locked Rules #5-7.

test("isDriverCashReceipt: Driver + Cash increases driver cash", () => {
  assert.equal(isDriverCashReceipt("DRIVER", "CASH"), true);
});

test("isDriverCashReceipt: Office collection never counts, even in cash", () => {
  assert.equal(isDriverCashReceipt("OFFICE", "CASH"), false);
});

test("isDriverCashReceipt: Bank/Online never counts, even collected by the driver", () => {
  assert.equal(isDriverCashReceipt("DRIVER", "BANK_ONLINE"), false);
});

// Driver-Paid Cash Expenses - Locked Rules #8-10.

test("isDriverPaidCashExpense: Naqad reduces driver cash", () => {
  assert.equal(isDriverPaidCashExpense("NAQAD"), true);
});

test("isDriverPaidCashExpense: Office-paid never reduces driver cash", () => {
  assert.equal(isDriverPaidCashExpense("OFFICE_PAID"), false);
});

test("isDriverPaidCashExpense: unpaid Khata never reduces driver cash", () => {
  assert.equal(isDriverPaidCashExpense("KHATA"), false);
});
