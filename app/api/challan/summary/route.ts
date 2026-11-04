import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { challanListSearchOr } from "@/lib/search-helpers";
import { computeFilteredChallanPositions, FINANCIAL_FILTER_VALUES, type FinancialFilterValue } from "@/lib/challan-list-query";

const CHALLAN_STATUS_VALUES = ["IN_TRANSIT", "DELIVERED", "CANCELLED"] as const;

// ============================================================
// LIGHTWEIGHT SUMMARY - Remaining Receivable / Remaining Payable /
// Net Position for the list page's 3 summary cards, loaded in
// PARALLEL with the paginated GET /api/challan (never sequentially
// after it, and never derived from only the current page - these
// totals must reflect every Challan matching the active filters,
// which is exactly why this needs its own request instead of being
// read off whichever page happens to be on screen).
//
// Accepts the SAME status/search/dateFrom/dateTo/financial params as
// GET /api/challan and sums the EXACT SAME position.totalReceivable/
// totalPayable (lib/challan-position.ts) the list's own filter/table
// read - reusing computeFilteredChallanPositions() (lib/challan-list-
// query.ts), so these totals can never drift from what the
// Receivable/Payable filters themselves would show matches.
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "challan.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");
    const status: (typeof CHALLAN_STATUS_VALUES)[number] | null =
      statusParam && (CHALLAN_STATUS_VALUES as readonly string[]).includes(statusParam) ? (statusParam as (typeof CHALLAN_STATUS_VALUES)[number]) : null;
    const financialParam = searchParams.get("financial");
    const financial = financialParam && FINANCIAL_FILTER_VALUES.includes(financialParam as FinancialFilterValue) ? (financialParam as FinancialFilterValue) : null;
    const search = searchParams.get("search")?.trim() || "";
    const dateFrom = searchParams.get("dateFrom") || "";
    const dateTo = searchParams.get("dateTo") || "";

    const where: Prisma.ChallanWhereInput = {
      isDeleted: false,
      ...(status ? { status } : {}),
      ...(search ? { OR: challanListSearchOr(search) } : {}),
      ...(dateFrom || dateTo
        ? {
            loadingDate: {
              ...(dateFrom ? { gte: new Date(`${dateFrom}T00:00:00`) } : {}),
              ...(dateTo ? { lt: new Date(`${dateTo}T00:00:00`) } : {}),
            },
          }
        : {}),
    };

    const filtered = await computeFilteredChallanPositions(where, financial);

    let totalReceivable = 0;
    let totalPayable = 0;
    for (const id of filtered.orderedIds) {
      const position = filtered.positionsMap[id];
      if (!position) continue;
      totalReceivable += position.totalReceivable;
      totalPayable += position.totalPayable;
    }
    const net = Math.round((totalReceivable - totalPayable) * 100) / 100;

    return NextResponse.json(
      {
        success: true,
        summary: { totalReceivable: Math.round(totalReceivable * 100) / 100, totalPayable: Math.round(totalPayable * 100) / 100, net },
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" } }
    );
  } catch (error) {
    console.error("Get challan summary error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Challan summary" }, { status: 500 });
  }
}
