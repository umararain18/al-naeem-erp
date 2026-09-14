import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getEmployeeLedgerData } from "@/lib/payroll-accounting";

// ============================================================
// EMPLOYEE LEDGER
//
// Built from scratch, but NOT a second accounting ledger table -
// reads the employee's own Account's real JournalLines via the
// shared getEmployeeLedgerData() (lib/payroll-accounting.ts), the
// SAME function used by the PDF/Excel exports, so the screen and
// exports can never drift out of sync.
//
// DISPLAY ORDER (screen only): getEmployeeLedgerData() always
// computes the running balance chronologically (oldest -> newest) -
// that calculation is untouched here. This route only reverses the
// FINISHED `entries` array before responding, so the Employee Ledger
// tab renders newest -> oldest while each row's own `balance` value
// still reflects the true balance as of that transaction. The PDF/
// Excel exports call getEmployeeLedgerData() directly (not this
// route) and are unaffected - they stay chronological, matching the
// Party Ledger export precedent.
// ============================================================

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search")?.trim();

    const data = await getEmployeeLedgerData(prisma, id, { from, to, search });
    if (!data) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    // Reverse ONLY the finished, already-chronologically-calculated
    // rows for display (newest -> oldest). summary/currentBalance are
    // computed from the pre-reversal data and are completely
    // unaffected by this reversal.
    const displayEntries = [...data.entries].reverse();

    return NextResponse.json({
      success: true,
      employee: data.employee,
      currentBalance: data.currentBalance,
      currentStatus: data.currentStatus,
      entries: displayEntries,
      summary: data.summary,
      filters: { from: from || null, to: to || null, search: search || null },
    });
  } catch (error) {
    console.error("Employee ledger error:", error);
    return NextResponse.json({ success: false, message: "Unable to load employee ledger" }, { status: 500 });
  }
}
