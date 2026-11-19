import type { DailySummaryResponse, DrilldownKey } from "./daily-summary";

// ============================================================
// DASHBOARD PERMISSION MASKING - pure, applied once, server-side,
// to a FULLY COMPUTED DailySummaryResponse before it is ever
// serialized to JSON. The masked-out value is `null` (or the key is
// simply absent from `drilldowns`) - the real number genuinely never
// reaches the client for a user who lacks the permission, satisfying
// "the API must omit, not just hide, fields the user lacks
// permission for" - this is not a client-side display toggle.
//
// Two tiers (confirmed with the user after a prior over-removal of
// ALL permission gating was flagged as a security regression):
//   - Financial sections (cash, profit, income/expense, receivable/
//     payable, ageing, wasooli/dena, top parties amounts, WhatsApp
//     summary) require `reports.view`.
//   - Operational counts (today's bilty/challan/bill/phonch counts,
//     the Operations pipeline) require their own module `*.view`
//     permission.
// Alerts, Routes/empty-return, Own Carrier and Marketing are left
// UNGATED - not named in that instruction, and this masking function
// deliberately adds no gate beyond what was explicitly asked for.
// ============================================================

export interface DailySummaryPermissions {
  reports: boolean;
  bilty: boolean;
  challan: boolean;
  bill: boolean;
  phonch: boolean;
  privatePhonch: boolean;
}

const REPORTS_GATED_DRILLDOWNS: DrilldownKey[] = ["cust", "ca", "sr", "ch", "rec", "pay", "exp", "inc", "tin", "tout"];
const MODULE_GATED_DRILLDOWNS: Record<DrilldownKey, keyof DailySummaryPermissions | null> = {
  cust: null, ca: null, sr: null, ch: null, rec: null, pay: null, exp: null, inc: null, tin: null, tout: null, // already reports-gated above
  routes: null,
  loss: null,
  settle: null,
  tb: "bilty",
  tc: "challan",
  tbill: "bill",
  tsr: "phonch",
  tpp: "privatePhonch",
};

export function applyDailySummaryPermissions(full: DailySummaryResponse, permissions: DailySummaryPermissions): DailySummaryResponse {
  const masked: DailySummaryResponse = {
    ...full,
    today: {
      ...full.today,
      biltyCount: permissions.bilty ? full.today.biltyCount : null,
      biltyBookingAmount: permissions.bilty ? full.today.biltyBookingAmount : null,
      challanCount: permissions.challan ? full.today.challanCount : null,
      challanDispatchedCount: permissions.challan ? full.today.challanDispatchedCount : null,
      billCount: permissions.bill ? full.today.billCount : null,
      billAmount: permissions.bill ? full.today.billAmount : null,
      showroomPhonchVehicleCount: permissions.phonch ? full.today.showroomPhonchVehicleCount : null,
      showroomPhonchDeliveryCharges: permissions.phonch ? full.today.showroomPhonchDeliveryCharges : null,
      privatePhonchVehicleCount: permissions.privatePhonch ? full.today.privatePhonchVehicleCount : null,
      privatePhonchRent: permissions.privatePhonch ? full.today.privatePhonchRent : null,
      cashIn: permissions.reports ? full.today.cashIn : null,
      cashOut: permissions.reports ? full.today.cashOut : null,
      netCash: permissions.reports ? full.today.netCash : null,
      cashByAccount: permissions.reports ? full.today.cashByAccount : null,
      totalCash: permissions.reports ? full.today.totalCash : null,
    },
    profit: permissions.reports ? full.profit : null,
    wasooli: permissions.reports ? full.wasooli : null,
    wasooliTotal: permissions.reports ? full.wasooliTotal : null,
    denaHai: permissions.reports ? full.denaHai : null,
    denaHaiTotal: permissions.reports ? full.denaHaiTotal : null,
    topCustomers: permissions.reports ? full.topCustomers : null,
    topClearingAgents: permissions.reports ? full.topClearingAgents : null,
    topShowroomTransporters: permissions.reports ? full.topShowroomTransporters : null,
    topChallanTransporters: permissions.reports ? full.topChallanTransporters : null,
    charts: permissions.reports ? full.charts : null,
    ownerWhatsapp: permissions.reports ? full.ownerWhatsapp : null,
    drilldowns: {},
  };

  for (const [key, dataset] of Object.entries(full.drilldowns) as [DrilldownKey, DailySummaryResponse["drilldowns"][DrilldownKey]][]) {
    if (!dataset) continue;
    if (REPORTS_GATED_DRILLDOWNS.includes(key)) {
      if (permissions.reports) masked.drilldowns[key] = dataset;
      continue;
    }
    const modulePerm = MODULE_GATED_DRILLDOWNS[key];
    if (!modulePerm || permissions[modulePerm]) masked.drilldowns[key] = dataset;
  }

  return masked;
}
