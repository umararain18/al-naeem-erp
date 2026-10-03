import { NextRequest, NextResponse } from "next/server";
import autoTable from "jspdf-autotable";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyOutstandingDocuments, getPartyOutstandingSummary } from "@/lib/party-outstanding";
import { filterOutstandingRows, type OutstandingFilterOptions } from "@/lib/outstanding-filters";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import { createPdfDocument, drawPdfHeader, drawPdfFooter, applyWatermark, resolveAutoTableTheme, resolveJsPdfFont } from "@/lib/pdf-render-helpers";
import { formatBusinessDate } from "@/lib/date-range";

// ============================================================
// GET /api/parties/[id]/outstanding/pdf
//
// Party-shareable "Outstanding Statement" PDF - the party-facing
// export for the NEW Outstanding Ledger (see lib/party-outstanding.ts
// for the underlying, read-only engine). Reuses the SAME jsPDF +
// jspdf-autotable infrastructure and PARTY_STATEMENT Header/Footer/
// Logo override as app/api/parties/[id]/ledger/pdf and
// app/api/parties/[id]/statement/pdf - never a second PDF style.
//
// Never exposes a JournalEntry/JournalLine id, an internal account
// name, or any other technical/implementation detail - every row is
// built from the SAME plain-business-language Description this
// engine's own on-screen table shows, oldest -> newest, per rule #13
// of this feature's spec (a formal statement reads chronologically,
// matching the existing Party Ledger PDF's own "always asc" choice).
// ============================================================

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Karachi" }).format(value);
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  BILTY: "Bilty",
  CHALLAN: "Challan",
  BILL: "Bill",
  PHONCH: "Showroom Phonch",
  PRIVATE_PHONCH: "Private Phonch",
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

    const { id: partyId } = await params;
    if (partyId.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Party not found" }, { status: 404 });
    }

    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { id: true, partyName: true, phone: true, account: { select: { id: true } } },
    });

    if (!party) {
      return NextResponse.json({ success: false, message: "Party not found" }, { status: 404 });
    }
    if (!party.account) {
      return NextResponse.json({ success: false, message: "This party does not have an account yet." }, { status: 404 });
    }

    // Same Search/Type/Direction/Date filters the screen itself
    // supports (app/parties/[id]/ledger/OutstandingView.tsx), applied
    // via the SAME shared predicate (lib/outstanding-filters.ts) so
    // this export can never drift from what the screen would show for
    // the identical query. Original/Settled/Remaining are computed
    // exactly as before (getPartyOutstandingDocuments never re-run
    // with different logic) - filtering only narrows WHICH rows are
    // included, then the summary is recomputed from that same
    // narrowed set via the existing getPartyOutstandingSummary().
    const { searchParams } = new URL(request.url);
    const VALID_TYPES = new Set(["BILTY", "CHALLAN", "BILL", "PHONCH", "PRIVATE_PHONCH"]);
    const VALID_DIRECTIONS = new Set(["RECEIVABLE", "PAYABLE"]);
    const typeParam = searchParams.get("type");
    const directionParam = searchParams.get("direction");
    const filterOptions: OutstandingFilterOptions = {
      search: searchParams.get("search"),
      documentType: typeParam && VALID_TYPES.has(typeParam) ? (typeParam as OutstandingFilterOptions["documentType"]) : null,
      direction: directionParam && VALID_DIRECTIONS.has(directionParam) ? (directionParam as OutstandingFilterOptions["direction"]) : null,
      from: searchParams.get("from"),
      to: searchParams.get("to"),
    };
    const hasActiveFilters = !!(filterOptions.search || filterOptions.documentType || filterOptions.direction || filterOptions.from || filterOptions.to);

    const allDocuments = await getPartyOutstandingDocuments(prisma, party.account.id);
    const documents = hasActiveFilters ? filterOutstandingRows(allDocuments, filterOptions) : allDocuments;
    const summary = await getPartyOutstandingSummary(documents);

    const presentation = await resolvePdfPresentation(prisma, "PARTY_STATEMENT");
    const bodyFont = resolveJsPdfFont(presentation.pdf.defaultFont);

    const doc = createPdfDocument(presentation);
    const pageWidth = doc.internal.pageSize.getWidth();

    const { nextY } = await drawPdfHeader(doc, presentation, "OUTSTANDING STATEMENT");
    let y = nextY;

    doc.setFontSize(10);
    doc.setFont(bodyFont, "normal");
    doc.text(`Party: ${party.partyName}`, 14, y);
    if (party.phone) {
      doc.text(`Phone: ${party.phone}`, pageWidth - 14, y, { align: "right" });
    }
    y += 6;
    doc.text(`As of: ${formatDate(new Date())}`, 14, y);
    y += 6;
    if (hasActiveFilters) {
      const scopeParts: string[] = [];
      if (filterOptions.documentType) scopeParts.push(`Type: ${DOCUMENT_TYPE_LABELS[filterOptions.documentType] || filterOptions.documentType}`);
      if (filterOptions.direction) scopeParts.push(`Direction: ${filterOptions.direction === "RECEIVABLE" ? "Receivable" : "Payable"}`);
      if (filterOptions.from || filterOptions.to) scopeParts.push(`Date: ${filterOptions.from || "-"} to ${filterOptions.to || "-"}`);
      if (filterOptions.search) scopeParts.push(`Search: "${filterOptions.search}"`);
      doc.setFontSize(9);
      doc.text(`Filtered - ${scopeParts.join(" | ")}`, 14, y);
      doc.setFontSize(10);
      y += 6;
    }
    y += 4;

    if (documents.length === 0) {
      doc.setFont(bodyFont, "bold");
      doc.setFontSize(11);
      doc.text(hasActiveFilters ? "No matching outstanding documents" : "No outstanding balance", 14, y);
      drawPdfFooter(doc, presentation);
      applyWatermark(doc, presentation);
      const pdfBuffer = doc.output("arraybuffer");
      return new NextResponse(pdfBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename=Outstanding-${party.partyName.replace(/\s+/g, "-")}.pdf`,
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      });
    }

    const tableRows = documents.map((d) => [
      formatBusinessDate(d.documentDate),
      DOCUMENT_TYPE_LABELS[d.documentType] || d.documentType,
      d.documentNo,
      d.description,
      formatCurrency(d.originalAmount),
      formatCurrency(d.settledAmount),
      formatCurrency(d.remainingAmount),
      d.direction === "RECEIVABLE" ? "Receivable" : "Payable",
    ]);

    autoTable(doc, {
      startY: y,
      head: [["Date", "Document", "Document No.", "Description", "Original Amount", "Settled", "Remaining Due", "Type"]],
      body: tableRows,
      theme: resolveAutoTableTheme(presentation.pdf.tableBorderStyle),
      headStyles: { fontSize: 8, cellPadding: 2, fillColor: [37, 99, 235] },
      bodyStyles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 18 },
        1: { cellWidth: 16 },
        2: { cellWidth: 16 },
        3: { cellWidth: "auto" },
        4: { cellWidth: 22, halign: "right" },
        5: { cellWidth: 20, halign: "right" },
        6: { cellWidth: 22, halign: "right" },
        7: { cellWidth: 18 },
      },
      margin: { left: 14, right: 14 },
    });

    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || y + 20;
    let totalsY = finalY + 8;
    if (totalsY > 270) {
      doc.addPage();
      totalsY = 14;
    }
    doc.setFont(bodyFont, "bold");
    doc.setFontSize(10);
    doc.text(`Total Receivable: ${formatCurrency(summary.totalReceivable)}`, 14, totalsY);
    doc.text(`Total Payable: ${formatCurrency(summary.totalPayable)}`, 14, totalsY + 6);
    doc.text(`Net Balance: ${formatCurrency(Math.abs(summary.netBalance))} ${summary.netBalance >= 0 ? "(Receivable)" : "(Payable)"}`, 14, totalsY + 12);

    drawPdfFooter(doc, presentation);
    applyWatermark(doc, presentation);

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=Outstanding-${party.partyName.replace(/\s+/g, "-")}.pdf`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    console.error("Party outstanding statement PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate outstanding statement PDF" }, { status: 500 });
  }
}
