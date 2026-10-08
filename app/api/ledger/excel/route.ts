import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getAccountLedgerData, PartyLedgerLookupError, parseLedgerEntryType, filterLedgerRowsBySearch } from "@/lib/ledger-description";
import { formatBusinessDate } from "@/lib/date-range";
import { parseLedgerDetailColumns, LEDGER_DETAIL_GROUPS, LEDGER_DETAIL_LABELS, type LedgerDetailColumn } from "@/lib/ledger-detail-columns";

// Structured detail columns, EXCLUDING "description" (that stays its
// own fixed column, exactly like the screen/PDF treat it) - in the
// SAME order LEDGER_DETAIL_GROUPS defines them, inserted between Date
// and Description only when selected. Never a fixed, always-present
// set of columns - an unselected field's column does not exist at all
// in the output, not merely left blank.
type StructuredDetailColumn = Exclude<LedgerDetailColumn, "description">;
const STRUCTURED_DETAIL_COLUMNS: StructuredDetailColumn[] = LEDGER_DETAIL_GROUPS.flatMap((g) => g.columns).filter(
  (c): c is StructuredDetailColumn => c !== "description"
);

// ============================================================
// GET /api/ledger/excel?accountId=&from=&to=&details=
//
// General Ledger's own Excel export - mirrors app/api/parties/[id]/
// ledger/excel/route.ts exactly (same HTML-table-as-.xls technique,
// same read-only getAccountLedgerData() the screen itself uses, same
// `details` query param honoring the on-screen Ledger Details
// selection) for ANY account, not just a Party's.
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

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  BILTY: "Bilty",
  CHALLAN: "Challan",
  PRIVATE_PHONCH: "Private Phonch",
  SHOWROOM_PHONCH: "Showroom Phonch",
  BILL: "Bill",
  OTHER: "Other",
};

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("accountId");
    if (!accountId) {
      return NextResponse.json({ success: false, message: "Account is required" }, { status: 400 });
    }
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const documentType = parseLedgerEntryType(searchParams.get("type"));
    const search = searchParams.get("search") || searchParams.get("q");
    // The SAME Ledger Details selection the on-screen table used to
    // produce this export - never a second, export-only selection,
    // and never trusted beyond the whitelist this re-validates against.
    const visibleDetails = parseLedgerDetailColumns(searchParams.get("details"));
    const showDescriptionText = visibleDetails.has("description");
    const activeDetailColumns = STRUCTURED_DETAIL_COLUMNS.filter((c) => visibleDetails.has(c));

    const data = await getAccountLedgerData(accountId, { from, to, order: "asc", documentType });

    const exportRows = filterLedgerRowsBySearch(data.ledger, search);

    const rowsHtml = exportRows
      .map((row) => {
        const detailCells = activeDetailColumns
          .map((col) => `<td>${escapeHtml(row.details?.[col] || "")}</td>`)
          .join("");
        return `
        <tr>
          <td>${escapeHtml(formatBusinessDate(row.date))}</td>
          ${detailCells}
          ${showDescriptionText ? `<td>${escapeHtml(row.description)}</td>` : ""}
          <td align="right">${row.debit > 0 ? escapeHtml(formatCurrency(row.debit)) : ""}</td>
          <td align="right">${row.credit > 0 ? escapeHtml(formatCurrency(row.credit)) : ""}</td>
          <td align="right">${escapeHtml(formatCurrency(row.balanceType === "PAYABLE" ? -row.balance : row.balance))}</td>
        </tr>`;
      })
      .join("");

    const periodLine =
      from || to
        ? `<div>Period: ${escapeHtml(from || "-")} to ${escapeHtml(to || "-")}</div>`
        : "";
    const typeLine = documentType
      ? `<div>Type: ${escapeHtml(DOCUMENT_TYPE_LABELS[documentType] || documentType)}</div>`
      : "";
    const searchLine = search ? `<div>Search: "${escapeHtml(search)}"</div>` : "";

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
<h2>AL NAEEM CAR CARRIERS SERVICE - General Ledger</h2>
<div>Account: ${escapeHtml(data.account.accountName)}</div>
${periodLine}
${typeLine}
${searchLine}
<div>Opening Balance: ${escapeHtml(formatCurrency(data.summary.openingBalance))}</div>
<br/>
<table>
<thead>
<tr><th>Date</th>${activeDetailColumns.map((col) => `<th>${escapeHtml(LEDGER_DETAIL_LABELS[col])}</th>`).join("")}${showDescriptionText ? "<th>Description</th>" : ""}<th>Debit</th><th>Credit</th><th>Balance</th></tr>
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
        "Content-Disposition": `attachment; filename=Ledger-${data.account.accountName.replace(/\s+/g, "-")}.xls`,
      },
    });
  } catch (error) {
    if (error instanceof PartyLedgerLookupError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
    console.error("General ledger Excel export error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate ledger Excel export" }, { status: 500 });
  }
}
