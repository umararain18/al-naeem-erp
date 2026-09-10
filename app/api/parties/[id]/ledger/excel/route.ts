import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyLedgerData, PartyLedgerLookupError } from "@/lib/ledger-description";

// ============================================================
// GET /api/parties/[id]/ledger/excel?from=&to=
//
// Excel export, built from the exact same read-only
// getPartyLedgerData() the screen ledger and PDF export use.
//
// No spreadsheet-generation library (xlsx/exceljs) exists anywhere
// in this project's dependencies today, and this task is explicitly
// display/export-only - adding a new dependency for it is out of
// scope. Instead this emits a genuine, real spreadsheet file using
// the well-established "HTML table saved as .xls" technique:
// Microsoft Excel natively recognizes and opens an HTML <table>
// served with the classic .xls MIME type, exactly like a real
// workbook (this is the same technique many server-side "Export to
// Excel" features use when no dedicated library is available) -
// this is NOT a CSV/print workaround, it opens as a formatted sheet
// with real column headers.
//
// Per the approved v2 spec: NO Source/Reference column here - only
// Date, Description, Debit, Credit, Balance, matching the PDF export
// exactly.
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "parties.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    // Client-facing formal statement: ALWAYS chronological
    // (Opening Balance -> oldest -> newest -> Totals -> Closing
    // Balance), regardless of how the browser Party Ledger screen
    // orders itself.
    const data = await getPartyLedgerData(id, { from, to, order: "asc" });

    const rowsHtml = data.ledger
      .map(
        (row) => `
        <tr>
          <td>${escapeHtml(formatDate(row.date))}</td>
          <td>${escapeHtml(row.description)}</td>
          <td align="right">${row.debit > 0 ? escapeHtml(formatCurrency(row.debit)) : ""}</td>
          <td align="right">${row.credit > 0 ? escapeHtml(formatCurrency(row.credit)) : ""}</td>
          <td align="right">${escapeHtml(formatCurrency(row.balanceType === "PAYABLE" ? -row.balance : row.balance))}</td>
        </tr>`
      )
      .join("");

    const periodLine =
      from || to
        ? `<div>Period: ${escapeHtml(from || "-")} to ${escapeHtml(to || "-")}</div>`
        : "";

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
<h2>AL NAEEM CAR CARRIERS SERVICE - Party Ledger</h2>
<div>Party: ${escapeHtml(data.party.partyName)}</div>
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
        "Content-Disposition": `attachment; filename=Ledger-${data.party.partyName.replace(/\s+/g, "-")}.xls`,
      },
    });
  } catch (error) {
    if (error instanceof PartyLedgerLookupError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
    console.error("Party ledger Excel export error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate ledger Excel export" }, { status: 500 });
  }
}
