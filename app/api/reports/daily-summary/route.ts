import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getDailySummary } from "@/lib/reports/daily-summary";
import { getCached } from "@/lib/reports/report-cache";

// GET /api/reports/daily-summary?date=YYYY-MM-DD&period=THIS_MONTH|LAST_MONTH|THIS_YEAR
//
// The SINGLE source for every Dashboard card (see lib/reports/daily-
// summary.ts's own doc comment) - no card computes its own numbers.
//
// PERMISSION-GATED, per-section, computed from the REAL requesting
// user's own role here and passed into getDailySummary() - which
// nulls out (never just hides) whatever this user's permissions don't
// cover, so an unauthorized field never leaves the server at all (see
// lib/reports/daily-summary-permissions.ts). An earlier version of
// this route removed ALL permission gating after misdiagnosing a
// reported "charts render empty" bug as caused by this gate - the
// user (testing as SUPER_ADMIN, who already has every permission
// below) confirmed that diagnosis was wrong and that removal was a
// real security regression; this restores the gate correctly scoped.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    // ONE global period selector drives every card, Khulasa included
    // (see lib/reports/daily-summary.ts's own header comment) -
    // defaults to YESTERDAY, never the server's own clock date (real
    // postings usually lag a day), when the client sends no preset at
    // all. lib/date-range.ts's own resolveDateRange() default
    // (THIS_MONTH, for its other, non-Dashboard callers) is
    // deliberately never relied on here.
    const preset = searchParams.get("preset") || "YESTERDAY";
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const permissions = {
      reports: hasPermission(currentUser, "reports.view"),
      bilty: hasPermission(currentUser, "bilty.view"),
      challan: hasPermission(currentUser, "challan.view"),
      bill: hasPermission(currentUser, "bill.view"),
      phonch: hasPermission(currentUser, "phonch.view"),
      privatePhonch: hasPermission(currentUser, "privatePhonch.view"),
    };

    // PERFORMANCE: 60s cache, keyed by date+period+this exact permission
    // set - the Dashboard's own data genuinely doesn't need to be any
    // fresher than that for an internal reporting screen, and this is
    // what makes the expensive open-document ageing lookup (see
    // lib/reports/daily-summary.ts's own PERFORMANCE comment, ~3s on
    // real data) affordable: paid once per 60s shared across every
    // viewer with the same permission set, not on every single load.
    // Reused across every viewer who shares the same period+permission
    // set (item M: a global period change must hit cache, not recompute,
    // on a second viewer/tab within the 60s window).
    const cacheKey = `daily-summary:${preset}:${from ?? ""}:${to ?? ""}:${JSON.stringify(permissions)}`;
    const summary = await getCached(cacheKey, () => getDailySummary({ preset, from, to, permissions }));

    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error("Daily summary report error:", error);
    return NextResponse.json({ success: false, message: "Unable to load daily summary" }, { status: 500 });
  }
}
