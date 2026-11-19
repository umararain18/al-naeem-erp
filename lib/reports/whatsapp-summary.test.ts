import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWhatsAppSummaryText, buildWaMeLink } from "./whatsapp-summary";
import type { DailySummaryResponse } from "./daily-summary";

function baseSummary(): DailySummaryResponse {
  return {
    meta: { todayISO: "2026-11-18", latestPostedDateISO: "2026-11-18", period: "THIS_MONTH", periodLabel: "This Month", periodFromISO: "2026-11-01", periodToISO: "2026-11-30", comparisonLabel: null, generatedAt: "2026-11-18T00:00:00.000Z" },
    today: {
      biltyCount: 7, biltyBookingAmount: 412000, challanCount: 4, challanDispatchedCount: 3, billCount: 2, billAmount: 46500,
      showroomPhonchVehicleCount: 5, showroomPhonchDeliveryCharges: 6000, privatePhonchVehicleCount: 2, privatePhonchRent: 17000,
      cashIn: 186500, cashOut: 142360, netCash: 44140,
      cashByAccount: [{ accountId: "a1", accountName: "Office Cash", balance: 83410 }, { accountId: "a2", accountName: "Umar Bank", balance: 1193607 }],
      totalCash: 1277017,
    },
    profit: { totalIncome: 3963581, totalExpense: 3232810, profit: 730771, incomeDeltaPct: -53.8, expenseDeltaPct: -56.1, profitDeltaPct: -39.6, bookingIncome: 3612000, carrierRent: 2683500, grossMargin: 928500, grossMarginPct: 25.7, otherIncome: 351581 },
    wasooli: [
      { partyId: "p1", name: "Jaecco Hyderabad", phone: null, amount: 127500, days: 48 },
      { partyId: "p2", name: "Nawab Broker", phone: null, amount: 105000, days: 41 },
      { partyId: "p3", name: "NKB", phone: null, amount: 98000, days: 35 },
    ],
    wasooliTotal: 330500,
    denaHai: [],
    denaHaiTotal: 0,
    alerts: { lossChallanCount: 2, settlementPendingCount: 6, unearnedRevenueBalance: 471500, noPhoneBiltyCount: 4 },
    topCustomers: [], topClearingAgents: [], topShowroomTransporters: [], topChallanTransporters: [],
    routes: [], emptyReturnCities: [], ownCarriers: [],
    marketing: { followUpsDueToday: 0, messagesSentThisPeriod: 0, leadsThisPeriod: 0, campaignBookingsCount: 0, campaignBookingsAmount: 0 },
    charts: { incomeExpense6mo: [], expenseBreakdown: [], receivableAgeing: [] },
    drilldowns: {} as DailySummaryResponse["drilldowns"],
    ownerWhatsapp: null,
  };
}

test("buildWhatsAppSummaryText - includes today counts, cash, profit, top wasooli, alerts", () => {
  const text = buildWhatsAppSummaryText(baseSummary());
  assert.match(text, /Bilty: 7 \(Rs 412,000\)/);
  assert.match(text, /Challan: 4/);
  assert.match(text, /Bill: 2 \(Rs 46,500\)/);
  assert.match(text, /Paise aaye: Rs 186,500/);
  assert.match(text, /Paise gaye: Rs 142,360/);
  assert.match(text, /Office Cash: Rs 83,410/);
  assert.match(text, /\*Kul cash: Rs 1,277,017\*/);
  assert.match(text, /Profit Rs 730,771/);
  assert.match(text, /Gross margin: 25\.7%/);
  assert.match(text, /Wasooli: Jaecco Hyderabad Rs 127,500 \(48 din\), Nawab Broker Rs 105,000 \(41 din\), NKB Rs 98,000 \(35 din\)/);
  assert.match(text, /Alerts: 2 nuqsan wale challan, 6 settlement baaqi/);
});

test("buildWhatsAppSummaryText - no wasooli, no alerts omits those lines cleanly", () => {
  const summary = baseSummary();
  summary.wasooli = [];
  summary.alerts = { ...summary.alerts, lossChallanCount: 0, settlementPendingCount: 0 };
  const text = buildWhatsAppSummaryText(summary);
  assert.doesNotMatch(text, /Wasooli:/);
  assert.doesNotMatch(text, /Alerts:/);
});

test("buildWhatsAppSummaryText - only shows top 3 of a longer wasooli list", () => {
  const summary = baseSummary();
  summary.wasooli!.push({ partyId: "p4", name: "Fourth Party", phone: null, amount: 1000, days: 32 });
  const text = buildWhatsAppSummaryText(summary);
  assert.doesNotMatch(text, /Fourth Party/);
});

test("buildWaMeLink - local 03XXXXXXXXX becomes a 92-prefixed wa.me link", () => {
  const link = buildWaMeLink("03001234567", "Hello");
  assert.equal(link, "https://wa.me/923001234567?text=Hello");
});
