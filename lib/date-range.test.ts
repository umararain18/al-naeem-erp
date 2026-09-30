import { test } from "node:test";
import assert from "node:assert/strict";
import { DateRangeValidationError, resolveDateRange, safePercentChange, toISODate } from "./date-range";

// All "now" values below are constructed at local noon (not midnight)
// to avoid any accidental sensitivity to time-of-day within the
// resolver, since it always normalizes to local start-of-day itself.

test("THIS_MONTH - normal month (not Feb, no transition)", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // 15 Jun 2026
  const r = resolveDateRange({ preset: "THIS_MONTH" }, now);
  assert.equal(r.fromISO, "2026-06-01");
  assert.equal(r.toISO, "2026-06-30");
  assert.equal(r.comparisonFromISO, "2026-05-01");
  assert.equal(r.comparisonToISO, "2026-05-31");
});

test("THIS_MONTH - February (non-leap year)", () => {
  const now = new Date(2027, 1, 10, 12, 0, 0); // 10 Feb 2027 (not leap)
  const r = resolveDateRange({ preset: "THIS_MONTH" }, now);
  assert.equal(r.fromISO, "2027-02-01");
  assert.equal(r.toISO, "2027-02-28");
});

test("THIS_MONTH - February (leap year)", () => {
  const now = new Date(2028, 1, 10, 12, 0, 0); // 10 Feb 2028 (leap)
  const r = resolveDateRange({ preset: "THIS_MONTH" }, now);
  assert.equal(r.fromISO, "2028-02-01");
  assert.equal(r.toISO, "2028-02-29");
  // Comparison (Jan 2028) must not be distorted by the leap day.
  assert.equal(r.comparisonFromISO, "2028-01-01");
  assert.equal(r.comparisonToISO, "2028-01-31");
});

test("LAST_MONTH - month transition into a shorter month (Mar -> Feb leap)", () => {
  const now = new Date(2028, 2, 5, 12, 0, 0); // 5 Mar 2028
  const r = resolveDateRange({ preset: "LAST_MONTH" }, now);
  assert.equal(r.fromISO, "2028-02-01");
  assert.equal(r.toISO, "2028-02-29");
});

test("THIS_MONTH - year transition (January's previous month is last December)", () => {
  const now = new Date(2026, 0, 10, 12, 0, 0); // 10 Jan 2026
  const r = resolveDateRange({ preset: "THIS_MONTH" }, now);
  assert.equal(r.fromISO, "2026-01-01");
  assert.equal(r.toISO, "2026-01-31");
  assert.equal(r.comparisonFromISO, "2025-12-01");
  assert.equal(r.comparisonToISO, "2025-12-31");
});

test("THIS_YEAR - year transition", () => {
  const now = new Date(2026, 0, 1, 12, 0, 0);
  const r = resolveDateRange({ preset: "THIS_YEAR" }, now);
  assert.equal(r.fromISO, "2026-01-01");
  assert.equal(r.toISO, "2026-12-31");
  assert.equal(r.comparisonFromISO, "2025-01-01");
  assert.equal(r.comparisonToISO, "2025-12-31");
});

test("THIS_QUARTER - quarter transition (Q1 -> previous Q4 of prior year)", () => {
  const now = new Date(2026, 1, 20, 12, 0, 0); // 20 Feb 2026 -> Q1
  const r = resolveDateRange({ preset: "THIS_QUARTER" }, now);
  assert.equal(r.fromISO, "2026-01-01");
  assert.equal(r.toISO, "2026-03-31");
  assert.equal(r.comparisonFromISO, "2025-10-01");
  assert.equal(r.comparisonToISO, "2025-12-31");
});

test("THIS_QUARTER - mid-year quarter (Q3)", () => {
  const now = new Date(2026, 7, 1, 12, 0, 0); // 1 Aug 2026 -> Q3 (Jul-Sep)
  const r = resolveDateRange({ preset: "THIS_QUARTER" }, now);
  assert.equal(r.fromISO, "2026-07-01");
  assert.equal(r.toISO, "2026-09-30");
  assert.equal(r.comparisonFromISO, "2026-04-01");
  assert.equal(r.comparisonToISO, "2026-06-30");
});

test("CUSTOM range - equal-length preceding comparison period", () => {
  const r = resolveDateRange({ from: "2026-09-01", to: "2026-09-27" });
  assert.equal(r.preset, "CUSTOM");
  assert.equal(r.fromISO, "2026-09-01");
  assert.equal(r.toISO, "2026-09-27");
  // 27 days selected (1st through 27th inclusive) -> comparison is the
  // 27 days immediately before Sep 1st.
  assert.equal(r.comparisonToISO, "2026-08-31");
  assert.equal(r.comparisonFromISO, "2026-08-05");
});

test("CUSTOM range - single-day range", () => {
  const r = resolveDateRange({ from: "2026-09-15", to: "2026-09-15" });
  assert.equal(r.preset, "CUSTOM");
  assert.equal(r.fromISO, "2026-09-15");
  assert.equal(r.toISO, "2026-09-15");
  assert.equal(r.comparisonFromISO, "2026-09-14");
  assert.equal(r.comparisonToISO, "2026-09-14");
  assert.equal(r.rangeLabel, "15 Sep 2026");
});

test("TODAY - single-day preset behaves like a custom single day", () => {
  const now = new Date(2026, 8, 27, 9, 30, 0); // 27 Sep 2026
  const r = resolveDateRange({ preset: "TODAY" }, now);
  assert.equal(r.fromISO, "2026-09-27");
  assert.equal(r.toISO, "2026-09-27");
  assert.equal(r.comparisonFromISO, "2026-09-26");
  assert.equal(r.comparisonToISO, "2026-09-26");
});

test("ALL_TIME - no bounds, no comparison", () => {
  const r = resolveDateRange({ preset: "ALL_TIME" });
  assert.equal(r.from, null);
  assert.equal(r.to, null);
  assert.equal(r.comparisonFrom, null);
  assert.equal(r.comparisonTo, null);
  assert.equal(r.rangeLabel, "All Time");
});

test("No parameters at all defaults to THIS_MONTH (legacy dashboard behavior)", () => {
  const now = new Date(2026, 8, 27, 12, 0, 0);
  const r = resolveDateRange({}, now);
  assert.equal(r.preset, "THIS_MONTH");
  assert.equal(r.fromISO, "2026-09-01");
  assert.equal(r.toISO, "2026-09-30");
});

test("THIS_WEEK - Monday-start week boundaries", () => {
  // Wednesday 30 Sep 2026
  const now = new Date(2026, 8, 30, 12, 0, 0);
  const r = resolveDateRange({ preset: "THIS_WEEK" }, now);
  assert.equal(r.fromISO, "2026-09-28"); // Monday
  assert.equal(r.toISO, "2026-10-04"); // Sunday
  assert.equal(r.comparisonFromISO, "2026-09-21");
  assert.equal(r.comparisonToISO, "2026-09-27");
});

test("toISODate formats local date parts without timezone conversion", () => {
  assert.equal(toISODate(new Date(2026, 0, 5)), "2026-01-05");
});

test("safePercentChange returns null when previous is zero", () => {
  assert.equal(safePercentChange(100, 0), null);
});

test("safePercentChange computes signed percent change", () => {
  assert.equal(safePercentChange(120, 100), 20);
  assert.equal(safePercentChange(80, 100), -20);
});

test("CUSTOM range - reversed (from later than to) throws DateRangeValidationError, never silently swapped", () => {
  assert.throws(
    () => resolveDateRange({ from: "2026-09-30", to: "2026-09-01" }),
    DateRangeValidationError
  );
});

test("CUSTOM range - from equal to is still a valid single-day range, not rejected", () => {
  const r = resolveDateRange({ from: "2026-09-15", to: "2026-09-15" });
  assert.equal(r.fromISO, "2026-09-15");
  assert.equal(r.toISO, "2026-09-15");
});

test("CUSTOM range - normal (from earlier than to) is unaffected by the reversed-range guard", () => {
  const r = resolveDateRange({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(r.fromISO, "2026-09-01");
  assert.equal(r.toISO, "2026-09-30");
});
