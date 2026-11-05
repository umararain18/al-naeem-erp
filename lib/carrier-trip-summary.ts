// ============================================================
// TRIP SUMMARY BAR - pure, read-only derivation over the Trip Cash
// Book's own rows (lib/carrier-trip.ts's getTripCashBook), used by
// app/own-carrier/[id]/trip/[tripId]/page.tsx's summary bar. Split
// out into its own module (rather than inlined in the page) so the
// invariant below has something importable to test directly.
//
// INVARIANT: Previous Balance + Total IN - Total OUT (Driver Cash)
// must always equal Remaining With Driver - see
// carrier-trip-summary.test.ts. This means Total OUT (Driver Cash)
// MUST include a Diesel line actually paid from Driver Cash
// (EXPENSE_CASH + isDiesel) - excluding every Diesel row from this
// total (an earlier version of this file did) silently broke the
// displayed arithmetic even though the real closingBalance
// (lib/carrier-trip.ts's own cashDelta()-based sum) was always
// correct. dieselByDriverCash is surfaced separately so the page can
// show "incl. Diesel X" under the Total OUT stat, and dieselTotal
// (every payment source - Driver Cash, Office, Udhaar) stays its own
// independent figure via the separate "Diesel Total" stat.
//
// DRIVER_CASH_OUT_LINE_TYPES mirrors lib/carrier-trip.ts's own
// cashDelta() exactly (the real, server-side source of truth for
// which lineTypes move Driver Cash) - EXPENSE_OFFICE/EXPENSE_CREDIT
// never touch Driver Cash regardless of isDiesel, so they're
// excluded here the same way. An EXTERNAL row (source: "EXTERNAL" -
// Daily Posting/Direct Entry) is a REAL Driver Cash movement
// regardless of its own lineType label ("DAILY_POSTING" is a display
// label, not one of CarrierTripLine's own lineTypes) - getTripCashBook
// (lib/carrier-trip.ts) only ever queries it scoped to the Driver Cash
// account in the first place, so it is counted by `source` alone,
// never lineType. Omitting these from the totals (while still
// showing them in the IN/OUT lists - the Trip 52 bug: an OUT list
// showing "Daily Posting - Office Cash 145,000" against a Total OUT
// of 25,000) is what broke the displayed Previous + IN - OUT =
// Remaining arithmetic below, even though the real closingBalance
// (lib/carrier-trip.ts's own cashDelta()-based sum, which already
// included every external line) was always correct.
// ============================================================

export interface TripSummaryBarRow {
  in: number;
  out: number;
  isDiesel: boolean;
  lineType: string;
  source: "TRIP_LINE" | "EXTERNAL";
}

export interface TripSummaryBar {
  totalIn: number;
  /** Every real Driver Cash outflow, diesel included. */
  totalOutDriverCash: number;
  /** The Diesel subset of totalOutDriverCash - a breakdown, not a separate total. */
  dieselByDriverCash: number;
  /** Diesel across EVERY payment source (Driver Cash + Office + Udhaar) - independent of totalOutDriverCash. */
  dieselTotal: number;
}

const DRIVER_CASH_OUT_LINE_TYPES = new Set(["EXPENSE_CASH", "DRIVER_SALARY", "DEPOSIT_TO_OFFICE"]);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeTripSummaryBar(rows: TripSummaryBarRow[]): TripSummaryBar {
  let totalIn = 0;
  let totalOutDriverCash = 0;
  let dieselByDriverCash = 0;
  let dieselTotal = 0;

  for (const r of rows) {
    if (r.in > 0) totalIn += r.in;
    if (r.out > 0) {
      if (r.isDiesel) dieselTotal += r.out;
      if (r.source === "EXTERNAL" || DRIVER_CASH_OUT_LINE_TYPES.has(r.lineType)) {
        totalOutDriverCash += r.out;
        if (r.isDiesel) dieselByDriverCash += r.out;
      }
    }
  }

  return {
    totalIn: round2(totalIn),
    totalOutDriverCash: round2(totalOutDriverCash),
    dieselByDriverCash: round2(dieselByDriverCash),
    dieselTotal: round2(dieselTotal),
  };
}
