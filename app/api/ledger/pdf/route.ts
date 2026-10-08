import { NextRequest, NextResponse } from "next/server";
import autoTable from "jspdf-autotable";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getAccountLedgerData, PartyLedgerLookupError, parseLedgerEntryType, filterLedgerRowsBySearch } from "@/lib/ledger-description";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import { createPdfDocument, drawPdfHeader, drawPdfFooter, applyWatermark, resolveAutoTableTheme, resolveJsPdfFont } from "@/lib/pdf-render-helpers";
import { formatBusinessDate } from "@/lib/date-range";
import { parseLedgerDetailColumns, ledgerDetailChips } from "@/lib/ledger-detail-columns";

// ============================================================
// GET /api/ledger/pdf?accountId=&from=&to=&details=
//
// General Ledger's own PDF export - mirrors app/api/parties/[id]/
// ledger/pdf/route.ts exactly (same jsPDF/autoTable libraries, same
// read-only getAccountLedgerData() the screen itself uses, same
// `details` query param honoring the on-screen Ledger Details
// selection via lib/ledger-detail-columns.ts) for ANY account, not
// just a Party's. Never a second calculation, never a print-to-PDF
// shortcut.
// ============================================================

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

    // Client-facing formal statement: ALWAYS chronological, exactly
    // mirroring the Party Ledger PDF's own identical choice -
    // regardless of how the browser General Ledger screen orders
    // itself (newest -> oldest).
    const data = await getAccountLedgerData(accountId, { from, to, order: "asc", documentType });

    const exportRows = filterLedgerRowsBySearch(data.ledger, search);

    const presentation = await resolvePdfPresentation(prisma, "REPORTS");
    const bodyFont = resolveJsPdfFont(presentation.pdf.defaultFont);

    const doc = createPdfDocument(presentation);
    const pageWidth = doc.internal.pageSize.getWidth();

    const { nextY } = await drawPdfHeader(doc, presentation, "GENERAL LEDGER");
    let y = nextY;

    doc.setFontSize(10);
    doc.setFont(bodyFont, "normal");
    doc.text(`Account: ${data.account.accountName}`, 14, y);
    if (from || to) {
      doc.text(`Period: ${from || "-"}  to  ${to || "-"}`, pageWidth - 14, y, { align: "right" });
    }
    y += 6;
    if (documentType) {
      doc.text(`Type: ${DOCUMENT_TYPE_LABELS[documentType] || documentType}`, 14, y);
      y += 6;
    }
    if (search) {
      doc.text(`Search: "${search}"`, 14, y);
      y += 6;
    }
    y += 2;

    doc.setFont(bodyFont, "bold");
    doc.text(`Opening Balance: ${formatCurrency(data.summary.openingBalance)}`, 14, y);
    y += 8;

    const tableRows = exportRows.map((row) => {
      const chips = ledgerDetailChips(row.details, visibleDetails);
      const lines = [...(showDescriptionText ? [row.description] : []), ...chips];
      return [
        formatBusinessDate(row.date),
        lines.length > 0 ? lines.join("\n") : "-",
        row.debit > 0 ? formatCurrency(row.debit) : "-",
        row.credit > 0 ? formatCurrency(row.credit) : "-",
        formatCurrency(row.balanceType === "PAYABLE" ? -row.balance : row.balance),
      ];
    });

    autoTable(doc, {
      startY: y,
      head: [["Date", "Description", "Debit", "Credit", "Balance"]],
      body: tableRows,
      theme: resolveAutoTableTheme(presentation.pdf.tableBorderStyle),
      headStyles: { fontSize: 9, cellPadding: 2, fillColor: [37, 99, 235] },
      bodyStyles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: "auto" },
        2: { cellWidth: 26, halign: "right" },
        3: { cellWidth: 26, halign: "right" },
        4: { cellWidth: 28, halign: "right" },
      },
      margin: { left: 14, right: 14 },
    });

    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || y + 20;
    let closingY = finalY + 8;
    if (closingY > 280) {
      doc.addPage();
      closingY = 14;
    }
    doc.setFont(bodyFont, "bold");
    doc.setFontSize(10);
    doc.text(`Closing Balance: ${formatCurrency(data.summary.closingBalance)}`, 14, closingY);

    drawPdfFooter(doc, presentation);
    applyWatermark(doc, presentation);

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=Ledger-${data.account.accountName.replace(/\s+/g, "-")}.pdf`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    if (error instanceof PartyLedgerLookupError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
    console.error("General ledger PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate ledger PDF" }, { status: 500 });
  }
}
