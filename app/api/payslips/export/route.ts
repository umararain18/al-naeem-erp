import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPayslipPaymentState, payrollMonthLabel } from "@/lib/payroll-accounting";
import { formatBusinessDate } from "@/lib/date-range";

// ============================================================
// GET /api/payslips/export?payrollMonth=YYYY-MM
//
// Payroll register export for one payroll period, built from the
// exact same live PayslipPaymentState derivation the Payroll &
// Payslips tab itself uses (never a separate stored total). Uses the
// same established "HTML table saved as .xls" technique as
// app/api/parties/[id]/ledger/excel/route.ts - no new dependency.
// ============================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

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
    const payrollMonth = searchParams.get("payrollMonth");
    if (!payrollMonth || !/^\d{4}-\d{2}$/.test(payrollMonth)) {
      return NextResponse.json({ success: false, message: "Invalid payroll month" }, { status: 400 });
    }

    const payslips = await prisma.payslip.findMany({
      where: { isDeleted: false, payrollMonth },
      include: {
        employee: { select: { name: true, designation: true, account: { select: { id: true } } } },
      },
      orderBy: [{ employee: { name: "asc" } }],
    });

    const rows = await Promise.all(
      payslips.map(async (p) => {
        const netPay = Number(p.netPay);
        const state = await getPayslipPaymentState(prisma, p.id, netPay, p.employee.account!.id);
        return {
          payslipNo: p.payslipNo,
          employeeName: p.employee.name,
          designation: p.employee.designation,
          payDate: p.payDate,
          grossPay: Number(p.grossPay),
          deduction: Number(p.deduction),
          netPay,
          contribution: Number(p.contribution),
          paidAmount: state.paidAmount,
          remainingAmount: state.remainingAmount,
          status: state.status,
        };
      })
    );

    const totals = rows.reduce(
      (acc, r) => ({
        grossPay: acc.grossPay + r.grossPay,
        deduction: acc.deduction + r.deduction,
        netPay: acc.netPay + r.netPay,
        paid: acc.paid + r.paidAmount,
        payable: acc.payable + r.remainingAmount,
      }),
      { grossPay: 0, deduction: 0, netPay: 0, paid: 0, payable: 0 }
    );

    const rowsHtml = rows
      .map(
        (r) => `
        <tr>
          <td>${escapeHtml(r.payslipNo)}</td>
          <td>${escapeHtml(formatBusinessDate(r.payDate))}</td>
          <td>${escapeHtml(r.employeeName)}</td>
          <td>${escapeHtml(r.designation || "-")}</td>
          <td align="right">${escapeHtml(formatCurrency(r.grossPay))}</td>
          <td align="right">${escapeHtml(formatCurrency(r.deduction))}</td>
          <td align="right">${escapeHtml(formatCurrency(r.netPay))}</td>
          <td align="right">${r.contribution > 0 ? escapeHtml(formatCurrency(r.contribution)) : ""}</td>
          <td align="right">${escapeHtml(formatCurrency(r.paidAmount))}</td>
          <td align="right">${escapeHtml(formatCurrency(r.remainingAmount))}</td>
          <td>${escapeHtml(r.status)}</td>
        </tr>`
      )
      .join("");

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Payroll</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 11px; }
th, td { border: 1px solid #999; padding: 4px 8px; }
th { background: #2563eb; color: #ffffff; }
</style>
</head>
<body>
<h2>AL NAEEM CAR CARRIERS SERVICE - Payroll Register</h2>
<div>Payroll Month: ${escapeHtml(payrollMonthLabel(payrollMonth))}</div>
<br/>
<table>
<thead>
<tr><th>Payslip No.</th><th>Date</th><th>Employee</th><th>Designation</th><th>Gross Pay</th><th>Deduction</th><th>Net Pay</th><th>Contribution</th><th>Paid</th><th>Remaining</th><th>Status</th></tr>
</thead>
<tbody>
${rowsHtml}
<tr>
  <td colspan="4"><b>Totals</b></td>
  <td align="right"><b>${escapeHtml(formatCurrency(totals.grossPay))}</b></td>
  <td align="right"><b>${escapeHtml(formatCurrency(totals.deduction))}</b></td>
  <td align="right"><b>${escapeHtml(formatCurrency(totals.netPay))}</b></td>
  <td></td>
  <td align="right"><b>${escapeHtml(formatCurrency(totals.paid))}</b></td>
  <td align="right"><b>${escapeHtml(formatCurrency(totals.payable))}</b></td>
  <td></td>
</tr>
</tbody>
</table>
</body>
</html>`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
        "Content-Disposition": `attachment; filename=Payroll-${payrollMonth}.xls`,
      },
    });
  } catch (error) {
    console.error("Payroll export error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate payroll export" }, { status: 500 });
  }
}
