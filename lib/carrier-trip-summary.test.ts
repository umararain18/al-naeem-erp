import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTripSummaryBar, type TripSummaryBarRow } from "./carrier-trip-summary";
import { cashDelta } from "./carrier-trip";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Previous Balance + Total IN - Total OUT (Driver Cash) must always
 * equal Remaining With Driver - the Remaining side computed completely
 * independently, straight from lib/carrier-trip.ts's own cashDelta()
 * (the real server-side source of truth), never from
 * computeTripSummaryBar's own totals. This is the one invariant the
 * whole summary bar exists to uphold. */
function assertSummaryBarInvariant(rows: TripSummaryBarRow[], previousBalance: number) {
  const bar = computeTripSummaryBar(rows);
  // An EXTERNAL row's own lineType ("DAILY_POSTING") is a display
  // label, not a real CarrierTripLineType cashDelta() understands - its
  // own `in`/`out` are already the real cash delta directly (see
  // getTripCashBook's own externalLines builder), never routed through
  // cashDelta() the way a TRIP_LINE row's are.
  const closingBalance = round2(
    previousBalance +
      rows.reduce((s, r) => s + (r.source === "EXTERNAL" ? r.in - r.out : cashDelta(r.lineType, r.in > 0 ? r.in : r.out)), 0)
  );
  const remaining = round2(previousBalance + bar.totalIn - bar.totalOutDriverCash);
  assert.equal(remaining, closingBalance, `Previous (${previousBalance}) + Total IN (${bar.totalIn}) - Total OUT Driver Cash (${bar.totalOutDriverCash}) = ${remaining}, expected Remaining = ${closingBalance}`);
}

function tripLineRow(row: Omit<TripSummaryBarRow, "source">): TripSummaryBarRow {
  return { ...row, source: "TRIP_LINE" };
}

function externalRow(row: { in: number; out: number }): TripSummaryBarRow {
  return { ...row, isDiesel: false, lineType: "DAILY_POSTING", source: "EXTERNAL" };
}

test("user's own worked example: OUT list 186,000 + Diesel-by-Driver-Cash 82,000 -> Total OUT 268,000", () => {
  const rows: TripSummaryBarRow[] = [
    tripLineRow({ in: 50000, out: 0, isDiesel: false, lineType: "COLLECTION" }),
    tripLineRow({ in: 0, out: 186000, isDiesel: false, lineType: "EXPENSE_CASH" }),
    tripLineRow({ in: 0, out: 82000, isDiesel: true, lineType: "EXPENSE_CASH" }),
    tripLineRow({ in: 0, out: 42000, isDiesel: true, lineType: "EXPENSE_CREDIT" }), // Diesel on Udhaar - never touches Driver Cash
  ];
  const bar = computeTripSummaryBar(rows);

  assert.equal(bar.totalIn, 50000);
  assert.equal(bar.totalOutDriverCash, 268000, "186,000 (non-diesel OUT) + 82,000 (diesel paid via Driver Cash)");
  assert.equal(bar.dieselByDriverCash, 82000, "the Diesel breakdown shown under Total OUT");
  assert.equal(bar.dieselTotal, 124000, "Diesel across every payment source: 82,000 (Driver Cash) + 42,000 (Udhaar)");

  const previousBalance = 40000;
  const remaining = round2(previousBalance + bar.totalIn - bar.totalOutDriverCash);
  assert.equal(remaining, -178000, "40,000 + 50,000 - 268,000 = -178,000");

  assertSummaryBarInvariant(rows, previousBalance);
});

test("no Diesel at all - dieselByDriverCash and dieselTotal are both 0, Total OUT unaffected", () => {
  const rows: TripSummaryBarRow[] = [
    tripLineRow({ in: 20000, out: 0, isDiesel: false, lineType: "CASH_FROM_OFFICE" }),
    tripLineRow({ in: 0, out: 5000, isDiesel: false, lineType: "DRIVER_SALARY" }),
    tripLineRow({ in: 0, out: 1000, isDiesel: false, lineType: "DEPOSIT_TO_OFFICE" }),
  ];
  const bar = computeTripSummaryBar(rows);
  assert.equal(bar.totalOutDriverCash, 6000);
  assert.equal(bar.dieselByDriverCash, 0);
  assert.equal(bar.dieselTotal, 0);
  assertSummaryBarInvariant(rows, 10000);
});

test("Diesel paid entirely via Office - counts in dieselTotal, never in Total OUT (Driver Cash)", () => {
  const rows: TripSummaryBarRow[] = [tripLineRow({ in: 0, out: 15000, isDiesel: true, lineType: "EXPENSE_OFFICE" })];
  const bar = computeTripSummaryBar(rows);
  assert.equal(bar.totalOutDriverCash, 0);
  assert.equal(bar.dieselByDriverCash, 0);
  assert.equal(bar.dieselTotal, 15000);
  assertSummaryBarInvariant(rows, 0);
});

test("mixed real-world Trip - every lineType, previousBalance negative, invariant still holds", () => {
  const rows: TripSummaryBarRow[] = [
    tripLineRow({ in: 30000, out: 0, isDiesel: false, lineType: "COLLECTION" }),
    tripLineRow({ in: 10000, out: 0, isDiesel: false, lineType: "CASH_FROM_OFFICE" }),
    tripLineRow({ in: 0, out: 2000, isDiesel: false, lineType: "EXPENSE_CASH" }),
    tripLineRow({ in: 0, out: 7000, isDiesel: true, lineType: "EXPENSE_CASH" }),
    tripLineRow({ in: 0, out: 3000, isDiesel: true, lineType: "EXPENSE_OFFICE" }),
    tripLineRow({ in: 0, out: 1500, isDiesel: true, lineType: "EXPENSE_CREDIT" }),
    tripLineRow({ in: 0, out: 4000, isDiesel: false, lineType: "DRIVER_SALARY" }),
    tripLineRow({ in: 0, out: 500, isDiesel: false, lineType: "DEPOSIT_TO_OFFICE" }),
  ];
  assertSummaryBarInvariant(rows, -12345.67);
});

test("empty Trip (no lines yet) - every total is 0, Remaining equals Previous", () => {
  const bar = computeTripSummaryBar([]);
  assert.deepEqual(bar, { totalIn: 0, totalOutDriverCash: 0, dieselByDriverCash: 0, dieselTotal: 0 });
  assertSummaryBarInvariant([], 5000);
});

test("Trip 52 bug: a Daily Posting (EXTERNAL) OUT line must be included in Total OUT, not just the displayed list", () => {
  const rows: TripSummaryBarRow[] = [
    tripLineRow({ in: 0, out: 25000, isDiesel: false, lineType: "EXPENSE_CASH" }),
    externalRow({ in: 0, out: 145000 }), // "Daily Posting - Office Cash 145,000"
  ];
  const bar = computeTripSummaryBar(rows);
  assert.equal(bar.totalOutDriverCash, 170000, "25,000 (Trip line) + 145,000 (Daily Posting) - both are real Driver Cash outflows");
  assertSummaryBarInvariant(rows, 100000);
});

test("OWNER_DRAWING/OFFICE_OVERHEAD are real Driver Cash outflows, counted in Total OUT like EXPENSE_CASH", () => {
  const rows: TripSummaryBarRow[] = [
    tripLineRow({ in: 0, out: 5000, isDiesel: false, lineType: "OWNER_DRAWING" }),
    tripLineRow({ in: 0, out: 3000, isDiesel: false, lineType: "OFFICE_OVERHEAD" }),
    tripLineRow({ in: 0, out: 2000, isDiesel: false, lineType: "EXPENSE_CASH" }),
  ];
  const bar = computeTripSummaryBar(rows);
  assert.equal(bar.totalOutDriverCash, 10000, "5,000 (Owner) + 3,000 (Office) + 2,000 (Carrier) - all three reduce Driver Cash");
  assertSummaryBarInvariant(rows, 20000);
});

test("Trip 52 bug: a Daily Posting (EXTERNAL) IN line must also be included in Total IN", () => {
  const rows: TripSummaryBarRow[] = [
    tripLineRow({ in: 30000, out: 0, isDiesel: false, lineType: "COLLECTION" }),
    externalRow({ in: 50000, out: 0 }), // e.g. a Daily Posting Peshki receipt
  ];
  const bar = computeTripSummaryBar(rows);
  assert.equal(bar.totalIn, 80000, "30,000 (Trip line) + 50,000 (Daily Posting)");
  assertSummaryBarInvariant(rows, 0);
});
