import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDailySummaryPermissions, type DailySummaryPermissions } from "./daily-summary-permissions";
import type { DailySummaryResponse } from "./daily-summary";

function fullSummary(): DailySummaryResponse {
  return {
    meta: { period: "THIS_MONTH", periodLabel: "This Month", periodFromISO: "2026-11-01", periodToISO: "2026-11-30", rangeLabel: "1 Nov 2026 - 30 Nov 2026", comparisonLabel: null, generatedAt: "2026-11-18T00:00:00.000Z" },
    today: {
      biltyCount: 7, biltyBookingAmount: 412000, challanCount: 4, challanDispatchedCount: 3, billCount: 2, billAmount: 46500,
      showroomPhonchVehicleCount: 5, showroomPhonchDeliveryCharges: 6000, privatePhonchVehicleCount: 2, privatePhonchRent: 17000,
      cashIn: 186500, cashOut: 142360, netCash: 44140,
      cashByAccount: [{ accountId: "a1", accountName: "Office Cash", balance: 83410 }],
      totalCash: 1277017,
    },
    profit: { totalIncome: 3963581, totalExpense: 3232810, profit: 730771, incomeDeltaPct: null, expenseDeltaPct: null, profitDeltaPct: null, bookingIncome: 3612000, carrierRent: 2683500, grossMargin: 928500, grossMarginPct: 25.7, otherIncome: 351581 },
    wasooli: [{ partyId: "p1", name: "Jaecco", phone: null, amount: 127500, days: 48, oldestDocLabel: "CN 6571" }],
    wasooliTotal: 127500,
    denaHai: [{ partyId: "p2", name: "NAS", amount: 217000, oldestDocNo: "CN1", oldestDocDays: 7 }],
    denaHaiTotal: 217000,
    alerts: { lossChallanCount: 2, settlementPendingCount: 6, unearnedRevenueBalance: 471500, noPhoneBiltyCount: 4 },
    topCustomers: [{ partyId: "p3", name: "Ansari", count: 14, amount: 840000 }],
    topClearingAgents: [{ partyId: "p4", name: "Super Life", count: 12, amount: 216000 }],
    topShowroomTransporters: [{ partyId: "p5", name: "MRK", count: 15, amount: 18000 }],
    topChallanTransporters: [{ partyId: "p6", name: "Shoib", count: 13, amount: 1012000 }],
    routes: [{ route: "Karachi -> Multan", biltyCount: 18, booking: 1000000, carrierRent: 786000, margin: 214000, marginPct: 21.4, pendingBiltyCount: 0, pendingBooking: 0 }],
    emptyReturnCities: [{ city: "D.I.Khan", inbound: 10, outbound: 0 }],
    ownCarriers: [{ carrierId: "c1", carrierNumber: "CBM-191", activeTrip: null, recentTrips: [] }],
    marketing: { followUpsDueToday: 6, messagesSentThisPeriod: 142, leadsThisPeriod: 18, campaignBookingsCount: 5, campaignBookingsAmount: 286000 },
    charts: {
      incomeExpense6mo: [{ month: "Nov", income: 3963581, expense: 3232810 }],
      expenseBreakdown: [{ account: "Carrier Rent", amount: 2683500 }],
      receivableAgeing: [{ bucket: "1-30 Days", amount: 707016 }],
    },
    drilldowns: {
      cust: { title: "Top Customers", subtitle: "", columns: ["Customer", "Bilties", "Rs"], rows: [] },
      tb: { title: "Aaj ki bilties", subtitle: "", columns: ["Bilty", "Gaariyan", "Rs"], rows: [] },
      tc: { title: "Aaj ke challan", subtitle: "", columns: ["Challan", "Gaariyan", "Rs"], rows: [] },
      loss: { title: "Nuqsan", subtitle: "", columns: ["Challan", "Gaariyan", "Rs"], rows: [] },
      routes: { title: "Routes", subtitle: "", columns: ["Route", "Bilties", "Rs"], rows: [] },
    },
    ownerWhatsapp: "03001234567",
  };
}

const NO_PERMISSIONS: DailySummaryPermissions = { reports: false, bilty: false, challan: false, bill: false, phonch: false, privatePhonch: false };
const ALL_PERMISSIONS: DailySummaryPermissions = { reports: true, bilty: true, challan: true, bill: true, phonch: true, privatePhonch: true };

test("no permissions at all - every gated field is null, ungated fields untouched", () => {
  const masked = applyDailySummaryPermissions(fullSummary(), NO_PERMISSIONS);

  assert.equal(masked.today.biltyCount, null);
  assert.equal(masked.today.challanCount, null);
  assert.equal(masked.today.billCount, null);
  assert.equal(masked.today.showroomPhonchVehicleCount, null);
  assert.equal(masked.today.privatePhonchVehicleCount, null);
  assert.equal(masked.today.cashIn, null);
  assert.equal(masked.today.cashByAccount, null);
  assert.equal(masked.today.totalCash, null);

  assert.equal(masked.profit, null);
  assert.equal(masked.wasooli, null);
  assert.equal(masked.wasooliTotal, null);
  assert.equal(masked.denaHai, null);
  assert.equal(masked.topCustomers, null);
  assert.equal(masked.topClearingAgents, null);
  assert.equal(masked.topShowroomTransporters, null);
  assert.equal(masked.topChallanTransporters, null);
  assert.equal(masked.charts, null);
  assert.equal(masked.ownerWhatsapp, null);

  // Ungated per the user's own explicit instruction - never masked.
  assert.deepEqual(masked.alerts, fullSummary().alerts);
  assert.deepEqual(masked.routes, fullSummary().routes);
  assert.deepEqual(masked.emptyReturnCities, fullSummary().emptyReturnCities);
  assert.deepEqual(masked.ownCarriers, fullSummary().ownCarriers);
  assert.deepEqual(masked.marketing, fullSummary().marketing);
});

test("no permissions - gated drilldown keys are absent (not null) from the JSON-serializable object; ungated ones survive", () => {
  const masked = applyDailySummaryPermissions(fullSummary(), NO_PERMISSIONS);
  assert.equal("cust" in masked.drilldowns, false);
  assert.equal("tb" in masked.drilldowns, false);
  assert.equal("tc" in masked.drilldowns, false);
  assert.equal("loss" in masked.drilldowns, true); // ungated
  assert.equal("routes" in masked.drilldowns, true); // ungated
});

test("all permissions - nothing is masked, identical to the input", () => {
  const full = fullSummary();
  const masked = applyDailySummaryPermissions(full, ALL_PERMISSIONS);
  assert.deepEqual(masked.today, full.today);
  assert.deepEqual(masked.profit, full.profit);
  assert.deepEqual(masked.wasooli, full.wasooli);
  assert.deepEqual(masked.topCustomers, full.topCustomers);
  assert.deepEqual(masked.charts, full.charts);
  assert.deepEqual(masked.drilldowns, full.drilldowns);
});

test("reports only - financial sections visible, operational counts (bilty/challan/bill/phonch) still null", () => {
  const masked = applyDailySummaryPermissions(fullSummary(), { ...NO_PERMISSIONS, reports: true });
  assert.notEqual(masked.profit, null);
  assert.notEqual(masked.wasooli, null);
  assert.notEqual(masked.topCustomers, null);
  assert.notEqual(masked.charts, null);
  assert.notEqual(masked.today.cashIn, null);
  assert.notEqual(masked.ownerWhatsapp, null);

  assert.equal(masked.today.biltyCount, null);
  assert.equal(masked.today.challanCount, null);
  assert.equal("cust" in masked.drilldowns, true); // reports-gated, now visible
  assert.equal("tb" in masked.drilldowns, false); // bilty-gated, still hidden
});

test("bilty.view only - bilty counts and the bilty drilldown unlock, nothing financial does", () => {
  const masked = applyDailySummaryPermissions(fullSummary(), { ...NO_PERMISSIONS, bilty: true });
  assert.notEqual(masked.today.biltyCount, null);
  assert.equal("tb" in masked.drilldowns, true);

  assert.equal(masked.today.challanCount, null);
  assert.equal(masked.profit, null);
  assert.equal("tc" in masked.drilldowns, false);
});

test("challan.view only - challan count unlocks", () => {
  const masked = applyDailySummaryPermissions(fullSummary(), { ...NO_PERMISSIONS, challan: true });
  assert.notEqual(masked.today.challanCount, null);
  assert.equal("tc" in masked.drilldowns, true);

  assert.equal(masked.today.biltyCount, null);
});
