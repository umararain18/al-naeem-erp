import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDailySummary } from "@/lib/reports/daily-summary";

// GET /api/reports/daily-summary?date=YYYY-MM-DD&period=THIS_MONTH|LAST_MONTH|THIS_YEAR
//
// The SINGLE source for every Dashboard card (see lib/reports/daily-
// summary.ts's own doc comment) - no card computes its own numbers.
// Requires only that the caller be logged in (any role) - deliberately
// NOT gated behind a granular per-section permission flag the way the
// old /api/dashboard route was (see this task's own bug report: that
// flag silently blanked 5-6 sections whenever a viewing user's role
// didn't carry it, with no error shown - the Dashboard is a normal
// internal screen every logged-in role already sees today, so this
// removes that entire failure class rather than guessing at which
// specific flag was misconfigured on a given deployment).
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date");
    const period = searchParams.get("period");

    const summary = await getDailySummary({ date, period });

    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error("Daily summary report error:", error);
    return NextResponse.json({ success: false, message: "Unable to load daily summary" }, { status: 500 });
  }
}
