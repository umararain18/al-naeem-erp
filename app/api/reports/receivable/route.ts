import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getReceivablePayable } from "@/lib/receivable-payable";
import { parseISODateStart, toISODate } from "@/lib/date-range";

// GET /api/reports/receivable
// GET /api/reports/receivable?to=2026-09-27 - optional "as of" date
// (inclusive), reusing the SAME `getReceivablePayable(asOfExclusive)`
// parameter Dashboard already uses - never a new calculation. Omitted
// (or malformed - never a 500) behaves exactly as before: as-of-now.
export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "reports.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const rawTo = new URL(request.url).searchParams.get("to")?.trim();
    let asOfExclusive: Date | undefined;
    if (rawTo) {
      const inclusiveEnd = parseISODateStart(rawTo);
      if (!Number.isNaN(inclusiveEnd.getTime())) {
        const exclusive = new Date(inclusiveEnd);
        exclusive.setDate(exclusive.getDate() + 1);
        asOfExclusive = exclusive;
      }
    }

    const { receivable, totalReceivable } = await getReceivablePayable(asOfExclusive);

    return NextResponse.json({
      success: true,
      receivable,
      summary: {
        totalReceivable,
        partyCount: receivable.length,
      },
      filters: {
        to: asOfExclusive ? toISODate(new Date(asOfExclusive.getTime() - 86400000)) : null,
      },
    });
  } catch (error) {
    console.error("Receivable report API error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load receivable report" },
      { status: 500 }
    );
  }
}
