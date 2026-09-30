import { NextRequest, NextResponse } from "next/server";
import autoTable from "jspdf-autotable";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyLedgerData, PartyLedgerLookupError, parseLedgerEntryType, filterLedgerRowsBySearch } from "@/lib/ledger-description";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import { createPdfDocument, drawPdfHeader, drawPdfFooter, applyWatermark, resolveAutoTableTheme, resolveJsPdfFont } from "@/lib/pdf-render-helpers";

// ============================================================
// GET /api/parties/[id]/ledger/pdf?from=&to=
//
// Real PDF export (jsPDF + jspdf-autotable, the SAME libraries
// already used by app/api/bilty/[id]/pdf, app/api/challan/[id]/pdf,
// and app/api/parties/[id]/statement/pdf), built from the exact
// same read-only getPartyLedgerData() the screen ledger uses - never
// a second calculation, never a print-to-PDF shortcut.
//
// Per the approved v2 spec: NO Source/Reference column here. Every
// row's Description is already fully self-contained (Bilty No,
// Challan No, Carrier No, Transporter, vehicle, amount, direction),
// so dropping the Source column loses no information.
// ============================================================

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  BILTY: "Bilty",
  CHALLAN: "Challan",
  PRIVATE_PHONCH: "Private Phonch",
  SHOWROOM_PHONCH: "Showroom Phonch",
  BILL: "Bill",
  OTHER: "Other",
};

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
    const documentType = parseLedgerEntryType(searchParams.get("type"));
    const search = searchParams.get("search") || searchParams.get("q");

    // Client-facing formal statement: ALWAYS chronological
    // (Opening Balance -> oldest -> newest -> Totals -> Closing
    // Balance), regardless of how the browser Party Ledger screen
    // orders itself. When a Type filter is active, every row AND the
    // Opening/Closing balance shown below are scoped to only that
    // type - see getPartyLedgerData()'s own doc comment - so the
    // exported PDF always matches exactly what the filtered screen
    // shows, never the full unfiltered account.
    const data = await getPartyLedgerData(id, { from, to, order: "asc", documentType });

    // Search narrows which ROWS appear - the exact same
    // filterLedgerRowsBySearch() the screen/General Ledger already
    // use, never a second matching rule. Opening/Closing Balance
    // intentionally stay as data.summary's own figures (the full
    // Type+Date-filtered account state) and are NEVER narrowed by
    // search - this mirrors the screen's own existing, approved
    // behavior (its search box only narrows the displayed table; the
    // Summary Cards above it are untouched by search) rather than
    // inventing a new balance rule for export.
    const exportRows = filterLedgerRowsBySearch(data.ledger, search);

    // No dedicated "party ledger" SettingsDocumentType value exists in
    // the fixed enum - PARTY_STATEMENT (the party-facing document type
    // the enum does provide) is used for both this Ledger PDF and the
    // separate Statement PDF, so they share one Header/Footer/Logo
    // override rather than each getting its own.
    const presentation = await resolvePdfPresentation(prisma, "PARTY_STATEMENT");
    const bodyFont = resolveJsPdfFont(presentation.pdf.defaultFont);

    const doc = createPdfDocument(presentation);
    const pageWidth = doc.internal.pageSize.getWidth();

    const { nextY } = await drawPdfHeader(doc, presentation, "PARTY LEDGER");
    let y = nextY;

    doc.setFontSize(10);
    doc.setFont(bodyFont, "normal");
    doc.text(`Party: ${data.party.partyName}`, 14, y);
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

    const tableRows = exportRows.map((row) => [
      formatDate(row.date),
      row.description,
      row.debit > 0 ? formatCurrency(row.debit) : "-",
      row.credit > 0 ? formatCurrency(row.credit) : "-",
      formatCurrency(row.balanceType === "PAYABLE" ? -row.balance : row.balance),
    ]);

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
        "Content-Disposition": `inline; filename=Ledger-${data.party.partyName.replace(/\s+/g, "-")}.pdf`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    if (error instanceof PartyLedgerLookupError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
    console.error("Party ledger PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate ledger PDF" }, { status: 500 });
  }
}
