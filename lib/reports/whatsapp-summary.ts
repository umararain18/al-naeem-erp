import type { DailySummaryResponse } from "./daily-summary";

// ============================================================
// WHATSAPP SUMMARY TEXT - pure, built entirely from the SAME
// DailySummaryResponse the Dashboard itself renders (see this
// task's own "stable field names... will feed an AI WhatsApp report
// later" requirement) - never a second, independently-computed set
// of numbers. Urdu/Roman (Roman Urdu), matching the approved
// prototype's own tone and line order.
// ============================================================

function formatRs(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Requires `reports.view` (profit/wasooli are null without it, see
 * lib/reports/daily-summary-permissions.ts) - the caller (Whatsapp
 * SummaryButton) only ever offers this when that permission is
 * present, but this returns a plain no-access line instead of
 * crashing if it's ever called without it.
 */
export function buildWhatsAppSummaryText(summary: DailySummaryResponse, businessName = "AL NAEEM CARGO"): string {
  const { today, profit, wasooli, alerts, meta } = summary;

  if (!profit || !wasooli) {
    return "Is report ke liye 'reports.view' permission chahiye.";
  }

  const isToday = meta.period === "TODAY";
  const lines: string[] = [];
  lines.push(`*${businessName} – ${isToday ? "Aaj ki report" : "Report"}*`);
  lines.push(meta.rangeLabel);
  lines.push("");

  lines.push(`Bilty: ${today.biltyCount ?? "-"} (${formatRs(today.biltyBookingAmount ?? 0)})`);
  lines.push(`Challan: ${today.challanCount ?? "-"}`);
  lines.push(`Bill: ${today.billCount ?? "-"} (${formatRs(today.billAmount ?? 0)})`);
  lines.push(`Showroom Phonch: ${today.showroomPhonchVehicleCount ?? "-"} gaariyan`);
  lines.push(`Private Phonch: ${today.privatePhonchVehicleCount ?? "-"} gaariyan`);
  lines.push("");

  lines.push(`Paise aaye: ${formatRs(today.cashIn ?? 0)}`);
  lines.push(`Paise gaye: ${formatRs(today.cashOut ?? 0)}`);
  for (const acc of today.cashByAccount ?? []) {
    lines.push(`${acc.accountName}: ${formatRs(acc.balance)}`);
  }
  lines.push(`*Kul cash: ${formatRs(today.totalCash ?? 0)}*`);
  lines.push("");

  lines.push(`Is period: Income ${formatRs(profit.totalIncome)} − Kharcha ${formatRs(profit.totalExpense)} = *Profit ${formatRs(profit.profit)}*`);
  lines.push(`Gross margin: ${profit.grossMarginPct}%`);
  lines.push("");

  if (wasooli.length > 0) {
    const top3 = wasooli
      .slice(0, 3)
      .map((w) => `${w.name} ${formatRs(w.amount)} (${w.days === Infinity ? "—" : w.days} din)`)
      .join(", ");
    lines.push(`Wasooli: ${top3}`);
  }

  const alertParts: string[] = [];
  if (alerts.lossChallanCount > 0) alertParts.push(`${alerts.lossChallanCount} nuqsan wale challan`);
  if (alerts.settlementPendingCount > 0) alertParts.push(`${alerts.settlementPendingCount} settlement baaqi`);
  if (alertParts.length > 0) lines.push(`Alerts: ${alertParts.join(", ")}`);

  return lines.join("\n");
}

/** `03XXXXXXXXX` or any raw phone -> a `wa.me` link with the given
 * text pre-filled - mirrors lib/phone.ts's toLocalMobile() normalization,
 * duplicated minimally here (string digits only) to avoid a cross-
 * import into a report module for one line of logic. */
export function buildWaMeLink(rawPhone: string, text: string): string {
  const digits = rawPhone.replace(/\D/g, "");
  const local10 = digits.slice(-10);
  const international = local10.startsWith("3") ? `92${local10}` : digits;
  return `https://wa.me/${international}?text=${encodeURIComponent(text)}`;
}
