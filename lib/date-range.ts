// ============================================================
// Dashboard date-range resolution - single authoritative source
// for every preset/custom range + its comparison period used by
// GET /api/dashboard and the Dashboard Date Selector UI.
//
// Convention (matches the existing app/api/reports/profit-loss/
// route.ts `from`/`to` pattern - the only date-range parsing that
// existed anywhere in the codebase before this file):
//   - `from` is INCLUSIVE, parsed as `${isoDate}T00:00:00` local time.
//   - `to` is an EXCLUSIVE upper bound: the calendar day AFTER the
//     user-facing inclusive end date, so filtering with
//     `entryDate: { gte: from, lt: to }` includes the entire end date.
//
// Dates are resolved using the server's LOCAL time zone (via the
// native Date constructor's local-time fields), exactly like every
// other date computation already in this codebase (there is no
// UTC-aware or timezone-aware date handling anywhere in the ERP).
// If the server's OS time zone ever changes, "Today"/"This Week"
// boundaries shift accordingly - this is a pre-existing, documented
// limitation, not something introduced here.
//
// Weeks are treated as Monday-to-Sunday (ISO-style week start). This
// is a new convention (no prior week-range logic existed in the
// codebase) and is applied consistently for THIS_WEEK/LAST_WEEK and
// their comparison periods.
// ============================================================

export const DATE_PRESETS = [
  "TODAY",
  "YESTERDAY",
  "THIS_WEEK",
  "LAST_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "THIS_QUARTER",
  "LAST_QUARTER",
  "THIS_YEAR",
  "LAST_YEAR",
  "ALL_TIME",
  "CUSTOM",
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

const PRESET_LABELS: Record<DatePreset, string> = {
  TODAY: "Today",
  YESTERDAY: "Yesterday",
  THIS_WEEK: "This Week",
  LAST_WEEK: "Last Week",
  THIS_MONTH: "This Month",
  LAST_MONTH: "Last Month",
  THIS_QUARTER: "This Quarter",
  LAST_QUARTER: "Last Quarter",
  THIS_YEAR: "This Year",
  LAST_YEAR: "Last Year",
  ALL_TIME: "All Time",
  CUSTOM: "Custom Range",
};

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface DateRangeParams {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
}

// Mirrors the existing per-module validation-error convention (see
// e.g. BillValidationError in lib/bill-accounting.ts) - thrown only
// for a genuinely reversed CUSTOM range (`from` later than `to`),
// never for a valid single-day range (`from === to` is fine) and
// never silently corrected by swapping the two dates.
export class DateRangeValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DateRangeValidationError";
    this.status = status;
  }
}

export interface ResolvedDateRange {
  preset: DatePreset;
  label: string;

  // Inclusive start / EXCLUSIVE end, ready to use as
  // `{ gte: from ?? undefined, lt: to ?? undefined }`. Both null means
  // "no bound at all" (ALL_TIME or an open-ended CUSTOM side).
  from: Date | null;
  to: Date | null;

  // YYYY-MM-DD, both INCLUSIVE (`toISO` is `to` minus one day) - for
  // display and for round-tripping into the URL / other report pages
  // that use the same inclusive-from/inclusive-to convention.
  fromISO: string | null;
  toISO: string | null;

  comparisonFrom: Date | null;
  comparisonTo: Date | null;
  comparisonFromISO: string | null;
  comparisonToISO: string | null;

  // e.g. "1 Sep 2026 - 27 Sep 2026" or "All Time" or "27 Sep 2026"
  rangeLabel: string;
  comparisonRangeLabel: string | null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}

function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  const day = s.getDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  return addDays(s, diffToMonday);
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfQuarter(d: Date): Date {
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISODateStart(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

// Single authoritative business-date display formatter (ANC ERP date
// standard) - DD-MM-YYYY, deterministic regardless of the viewer's
// browser locale or the server process's own timezone, since both
// locale and timeZone are pinned explicitly here rather than left to
// ambient defaults. For BUSINESS dates only (Bilty/Challan/Bill/
// Phonch/etc. document dates, report calendar filters) - never for a
// genuine timestamp (createdAt/updatedAt/deletedAt/settledAt), which
// must keep showing date+time via its own existing formatting.
export function formatBusinessDate(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  // en-GB's own separator is "/" (03/10/2026) - the ANC ERP standard is
  // "-" (03-10-2026), so parts are read individually and joined
  // explicitly rather than relying on the locale's own punctuation.
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const year = parts.find((p) => p.type === "year")!.value;
  return `${day}-${month}-${year}`;
}

// Re-populates a native <input type="date"> (which always needs
// "YYYY-MM-DD") from a stored business-date value, for an edit form.
// NEVER slice a stored ISO string's own "T" boundary directly
// (`value.split("T")[0]`) - a date-only business value is stored as
// LOCAL midnight expressed in UTC (parseISODateStart's own
// convention), so on any server whose local timezone has a positive
// UTC offset (this ERP's - Asia/Karachi, UTC+5), that naive slice
// reads back the PREVIOUS day. Reading the local (Asia/Karachi)
// calendar components instead - exactly like formatBusinessDate()
// does, just in en-CA's "YYYY-MM-DD" part order instead of en-GB's
// "DD-MM-YYYY" - is the only form that round-trips correctly.
export function toBusinessDateInputValue(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Karachi",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const year = parts.find((p) => p.type === "year")!.value;
  return `${year}-${month}-${day}`;
}

function formatShort(d: Date): string {
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function inclusiveEnd(toExclusive: Date): Date {
  return addDays(toExclusive, -1);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function buildRangeLabel(from: Date | null, to: Date | null): string {
  if (!from && !to) return "All Time";
  if (from && to) {
    const endInclusive = inclusiveEnd(to);
    if (toISODate(from) === toISODate(endInclusive)) return formatShort(from);
    return `${formatShort(from)} - ${formatShort(endInclusive)}`;
  }
  if (from) return `From ${formatShort(from)}`;
  if (to) return `Up to ${formatShort(inclusiveEnd(to))}`;
  return "All Time";
}

/**
 * Resolves the primary [from, to) range AND its comparison [from, to)
 * range for a given preset (or explicit custom from/to). `now` is
 * injectable for deterministic unit tests; defaults to the real
 * current time in production use.
 *
 * When neither `preset` nor `from`/`to` are supplied at all (the
 * legacy `GET /api/dashboard` call, with zero query parameters),
 * this resolves to THIS_MONTH - which reproduces the dashboard's
 * pre-existing hardcoded "current calendar month" Income/Expense/
 * Profit figures exactly, and reproduces its pre-existing "all-time"
 * Receivable/Payable/Cash/Bank figures too (since "as of the end of
 * this month" equals "as of now" whenever there are no future-dated
 * journal entries, which holds for all real data today).
 */
export function resolveDateRange(
  params: DateRangeParams,
  now: Date = new Date()
): ResolvedDateRange {
  const presetParam = (params.preset || "").trim().toUpperCase();
  const hasExplicitPreset = (DATE_PRESETS as readonly string[]).includes(presetParam);
  const hasExplicitCustomRange = Boolean(params.from || params.to);

  let preset: DatePreset;
  if (hasExplicitPreset) {
    preset = presetParam as DatePreset;
  } else if (hasExplicitCustomRange) {
    preset = "CUSTOM";
  } else {
    preset = "THIS_MONTH";
  }

  let from: Date | null;
  let to: Date | null;
  let comparisonFrom: Date | null = null;
  let comparisonTo: Date | null = null;

  switch (preset) {
    case "TODAY": {
      from = startOfDay(now);
      to = addDays(from, 1);
      comparisonTo = from;
      comparisonFrom = addDays(from, -1);
      break;
    }
    case "YESTERDAY": {
      to = startOfDay(now);
      from = addDays(to, -1);
      comparisonTo = from;
      comparisonFrom = addDays(from, -1);
      break;
    }
    case "THIS_WEEK": {
      from = startOfWeek(now);
      to = addDays(from, 7);
      comparisonTo = from;
      comparisonFrom = addDays(from, -7);
      break;
    }
    case "LAST_WEEK": {
      const thisWeekStart = startOfWeek(now);
      to = thisWeekStart;
      from = addDays(to, -7);
      comparisonTo = from;
      comparisonFrom = addDays(from, -7);
      break;
    }
    case "THIS_MONTH": {
      from = startOfMonth(now);
      to = addMonths(from, 1);
      comparisonTo = from;
      comparisonFrom = addMonths(from, -1);
      break;
    }
    case "LAST_MONTH": {
      const thisMonthStart = startOfMonth(now);
      to = thisMonthStart;
      from = addMonths(to, -1);
      comparisonTo = from;
      comparisonFrom = addMonths(from, -1);
      break;
    }
    case "THIS_QUARTER": {
      from = startOfQuarter(now);
      to = addMonths(from, 3);
      comparisonTo = from;
      comparisonFrom = addMonths(from, -3);
      break;
    }
    case "LAST_QUARTER": {
      const thisQuarterStart = startOfQuarter(now);
      to = thisQuarterStart;
      from = addMonths(to, -3);
      comparisonTo = from;
      comparisonFrom = addMonths(from, -3);
      break;
    }
    case "THIS_YEAR": {
      from = startOfYear(now);
      to = addMonths(from, 12);
      comparisonTo = from;
      comparisonFrom = addMonths(from, -12);
      break;
    }
    case "LAST_YEAR": {
      const thisYearStart = startOfYear(now);
      to = thisYearStart;
      from = addMonths(to, -12);
      comparisonTo = from;
      comparisonFrom = addMonths(from, -12);
      break;
    }
    case "ALL_TIME": {
      from = null;
      to = null;
      comparisonFrom = null;
      comparisonTo = null;
      break;
    }
    case "CUSTOM": {
      const rawFrom = params.from ? params.from.trim() : "";
      const rawTo = params.to ? params.to.trim() : "";
      const parsedFrom = rawFrom ? parseISODateStart(rawFrom) : null;
      const parsedTo = rawTo ? addDays(parseISODateStart(rawTo), 1) : null;

      // Malformed/unparseable date strings (e.g. from a hand-edited
      // URL) must never crash the query with an invalid Prisma Date
      // filter - treat that side as "not supplied" instead.
      from = parsedFrom && !Number.isNaN(parsedFrom.getTime()) ? parsedFrom : null;
      to = parsedTo && !Number.isNaN(parsedTo.getTime()) ? parsedTo : null;

      // `to` is already the exclusive day-after bound, so `from === to`
      // correctly still means a valid single inclusive day - only a
      // truly reversed pair (`from` on or after that exclusive bound)
      // is rejected.
      if (from && to && from >= to) {
        throw new DateRangeValidationError("Start date cannot be later than end date");
      }

      if (from && to) {
        const dayCount = daysBetween(from, to);
        comparisonTo = from;
        comparisonFrom = addDays(from, -dayCount);
      } else {
        // An open-ended custom range (only one side supplied) has no
        // technically meaningful equal-length comparison period.
        comparisonFrom = null;
        comparisonTo = null;
      }
      break;
    }
  }

  const fromISO = from ? toISODate(from) : null;
  const toISO = to ? toISODate(inclusiveEnd(to)) : null;
  const comparisonFromISO = comparisonFrom ? toISODate(comparisonFrom) : null;
  const comparisonToISO = comparisonTo ? toISODate(inclusiveEnd(comparisonTo)) : null;

  return {
    preset,
    label: PRESET_LABELS[preset],
    from,
    to,
    fromISO,
    toISO,
    comparisonFrom,
    comparisonTo,
    comparisonFromISO,
    comparisonToISO,
    rangeLabel: buildRangeLabel(from, to),
    comparisonRangeLabel:
      comparisonFrom || comparisonTo ? buildRangeLabel(comparisonFrom, comparisonTo) : null,
  };
}

/**
 * Safe percent-change helper shared by every KPI comparison card.
 * Returns null (never a fabricated number) when the previous value
 * is zero/absent, since a percentage against zero is not meaningful.
 */
export function safePercentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  if (!Number.isFinite(current)) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
