import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { isValidPayrollMonth, round2 } from "@/lib/payroll-accounting";

// ============================================================
// GET /api/employees/summary?payrollMonth=YYYY-MM
//
// Aggregate totals for the Employee Accounts tab's top summary
// cards. READ-ONLY - never writes/creates a JournalEntry, never
// stores a redundant summary balance. Every number here is derived
// from the SAME authoritative sources Employee Accounts/Employee
// Ledger/Payroll already use (Employee rows, the employee's own
// Account JournalLines, Payslip rows) - just aggregated with
// groupBy/aggregate queries instead of Employee Accounts' own
// per-row getEmployeeBalance() loop, so this stays O(1) queries
// regardless of employee count (no N+1 - Part 13).
//
// Payable vs Advance are NEVER netted against each other (Part 4):
// each employee's own balance (credit - debit, the same sign
// convention as getEmployeeBalance) contributes to EXACTLY ONE of
// totalPayable (balance > 0) or totalAdvance (balance < 0, summed as
// its absolute value) - never both, never cancelled out.
//
// "Total Paid This Month" / "This Month Payroll" are scoped to the
// given payrollMonth's Payslips specifically (Part 3/6/7): payroll =
// sum(Payslip.netPay), paid = sum of REAL PAYROLL_PAYMENT debits on
// the employee-account leg only. Neither is filtered by the
// employee's own isDeleted/isActive status - this deliberately
// matches the Payroll tab's own existing /api/payslips totals
// exactly (Part 12's "same authoritative formula, do not calculate
// independently"), which likewise never cross-references Employee
// Bin status - Payslip Bin is its own, independent action. The
// employee-account leg is isolated via `debit > 0` (never `credit >
// 0`), the SAME structural invariant already relied on in
// app/api/payslips/[id]/route.ts's own payments list: a
// PAYROLL_PAYMENT entry always debits the employee account and
// credits Cash/Bank, never the reverse.
// ============================================================

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    let payrollMonth = searchParams.get("payrollMonth") || "";
    if (!isValidPayrollMonth(payrollMonth)) {
      // Default to the current calendar month (Asia/Karachi, matching
      // every other date default already used on this page) if the
      // caller omitted/mistyped it - never a hard error for a summary.
      payrollMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit" })
        .format(new Date())
        .slice(0, 7);
    }

    // ------------------------------------------------------------
    // Employee counts + Payable/Advance (overall, all-time balance -
    // NOT scoped to payrollMonth, matching Employee Accounts' own
    // per-row Balance column, which is likewise all-time).
    // ------------------------------------------------------------
    const employees = await prisma.employee.findMany({
      where: { isDeleted: false },
      select: { isActive: true, account: { select: { id: true } } },
    });

    const totalEmployees = employees.length;
    const activeEmployees = employees.filter((e) => e.isActive).length;
    const accountIds = employees.map((e) => e.account?.id).filter((id): id is string => !!id);

    let totalPayable = 0;
    let totalAdvance = 0;
    if (accountIds.length > 0) {
      const grouped = await prisma.journalLine.groupBy({
        by: ["accountId"],
        where: { accountId: { in: accountIds }, journalEntry: { isDeleted: false } },
        _sum: { debit: true, credit: true },
      });
      for (const g of grouped) {
        const balance = round2(Number(g._sum.credit || 0) - Number(g._sum.debit || 0));
        if (balance > 0.01) totalPayable += balance;
        else if (balance < -0.01) totalAdvance += Math.abs(balance);
      }
    }

    // ------------------------------------------------------------
    // This Month Payroll + Total Paid This Month (scoped to the
    // selected payrollMonth's Payslips).
    // ------------------------------------------------------------
    const payslips = await prisma.payslip.findMany({
      where: { isDeleted: false, payrollMonth },
      select: { id: true, netPay: true },
    });
    const thisMonthPayroll = round2(payslips.reduce((sum, p) => sum + Number(p.netPay), 0));

    let paidThisMonth = 0;
    if (payslips.length > 0) {
      const paymentAgg = await prisma.journalLine.aggregate({
        where: {
          sourceType: "PAYSLIP",
          sourceId: { in: payslips.map((p) => p.id) },
          debit: { gt: 0 }, // employee-account leg only - excludes the Cash/Bank credit leg of the same entry
          journalEntry: { referenceType: "PAYROLL_PAYMENT", isDeleted: false },
        },
        _sum: { debit: true },
      });
      paidThisMonth = round2(Number(paymentAgg._sum.debit || 0));
    }

    return NextResponse.json({
      success: true,
      payrollMonth,
      totalEmployees,
      activeEmployees,
      totalPayable: round2(totalPayable),
      totalAdvance: round2(totalAdvance),
      paidThisMonth,
      thisMonthPayroll,
    });
  } catch (error) {
    console.error("Employee summary error:", error);
    return NextResponse.json({ success: false, message: "Unable to load employee summary" }, { status: 500 });
  }
}
