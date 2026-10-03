import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getEmployeeLedgerData } from "@/lib/payroll-accounting";
import { formatBusinessDate } from "@/lib/date-range";

// ============================================================
// GET /api/employees/[id]/ledger/excel?from=&to=
//
// Excel export, built from the exact same read-only
// getEmployeeLedgerData() the screen ledger and PDF export use.
// Mirrors app/api/parties/[id]/ledger/excel/route.ts exactly - the
// established "HTML table saved as .xls" technique (no new
// spreadsheet-generation dependency needed).
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const data = await getEmployeeLedgerData(prisma, id, { from, to, search: null });
    if (!data) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    const rowsHtml = data.entries
      .map(
        (row) => `
        <tr>
          <td>${escapeHtml(formatBusinessDate(row.date))}</td>
          <td>${escapeHtml(row.description)}</td>
          <td align="right">${row.debit > 0 ? escapeHtml(formatCurrency(row.debit)) : ""}</td>
          <td align="right">${row.credit > 0 ? escapeHtml(formatCurrency(row.credit)) : ""}</td>
          <td align="right">${escapeHtml(formatCurrency(row.balance))}</td>
        </tr>`
      )
      .join("");

    const periodLine =
      from || to ? `<div>Period: ${escapeHtml(from || "-")} to ${escapeHtml(to || "-")}</div>` : "";

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Ledger</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 11px; }
th, td { border: 1px solid #999; padding: 4px 8px; }
th { background: #2563eb; color: #ffffff; }
</style>
</head>
<body>
<h2>AL NAEEM CAR CARRIERS SERVICE - Employee Ledger</h2>
<div>Employee: ${escapeHtml(data.employee.name)} (${escapeHtml(data.employee.employeeCode)})</div>
${periodLine}
<div>Opening Balance: ${escapeHtml(formatCurrency(data.summary.openingBalance))}</div>
<br/>
<table>
<thead>
<tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>
</thead>
<tbody>
${rowsHtml}
</tbody>
</table>
<br/>
<div><b>Closing Balance: ${escapeHtml(formatCurrency(data.summary.closingBalance))}</b></div>
</body>
</html>`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
        "Content-Disposition": `attachment; filename=Employee-Ledger-${data.employee.name.replace(/\s+/g, "-")}.xls`,
      },
    });
  } catch (error) {
    console.error("Employee ledger Excel export error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate ledger Excel export" }, { status: 500 });
  }
}
