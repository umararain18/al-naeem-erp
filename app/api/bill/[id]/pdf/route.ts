import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getBillPaymentState, resolveBillClientAccountId } from "@/lib/bill-accounting";
import autoTable from "jspdf-autotable";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import { createPdfDocument, drawPdfHeader, drawPdfFooter, applyWatermark, resolveAutoTableTheme, resolveJsPdfFont } from "@/lib/pdf-render-helpers";
import { formatBusinessDate } from "@/lib/date-range";

// Reuses the existing ANC jsPDF + jspdf-autotable pattern
// (app/api/bilty/[id]/pdf/route.ts, app/api/challan/[id]/pdf/route.ts)
// - no new PDF architecture introduced. Header/footer/branding/page
// setup now come from the central Settings module (Phase 2) via
// resolvePdfPresentation() - Bill's own numbering/accounting is
// completely untouched (lib/bill-accounting.ts is not imported or
// modified here beyond the pre-existing getBillPaymentState() read).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const bill = await prisma.bill.findUnique({
      where: { id },
      include: {
        clientParty: { select: { account: { select: { id: true } } } },
        items: { orderBy: { lineNo: "asc" } },
      },
    });

    if (!bill || bill.isDeleted) {
      return NextResponse.json({ success: false, message: "Bill not found" }, { status: 404 });
    }

    const totalAmount = bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0);
    const pdfClientAccountId = await resolveBillClientAccountId(prisma, bill.clientParty);
    const paymentState = pdfClientAccountId
      ? await getBillPaymentState(prisma, id, pdfClientAccountId, totalAmount)
      : { receivedAmount: 0, remainingDue: totalAmount, status: "UNPAID" as const };

    const presentation = await resolvePdfPresentation(prisma, "BILL");
    const currency = presentation.invoice.currencyLabel || "Rs.";
    const money = (v: number) => `${currency} ${Math.round(v).toLocaleString()}`;

    const doc = createPdfDocument(presentation);
    const pageWidth = doc.internal.pageSize.getWidth();
    const bodyFont = resolveJsPdfFont(presentation.pdf.defaultFont);
    const bodySize = presentation.pdf.defaultFontSize;

    const { nextY } = await drawPdfHeader(doc, presentation, presentation.invoice.invoiceTitle || "BILL");
    let y = nextY;

    doc.setFontSize(bodySize);
    doc.setFont(bodyFont, "normal");

    doc.setFont(bodyFont, "bold");
    doc.text(`Bill No: ${bill.billNo}`, 14, y);
    doc.setFont(bodyFont, "normal");
    doc.text(`Date: ${formatBusinessDate(bill.date)}`, pageWidth - 14, y, { align: "right" });
    y += 8;

    // CLIENT SECTION - two bordered boxes (Bill To / Payment Status),
    // matching the approved invoice prototype's client-row layout. Pure
    // presentation: paymentState.status is the same, already-computed
    // value the ERP Bill Detail page and the summary box below show.
    const boxTop = y;
    const boxHeight = 18;
    const boxGap = 6;
    const boxWidth = (pageWidth - 28 - boxGap) / 2;
    const leftBoxX = 14;
    const rightBoxX = leftBoxX + boxWidth + boxGap;

    doc.setDrawColor(210);
    doc.rect(leftBoxX, boxTop, boxWidth, boxHeight);
    doc.rect(rightBoxX, boxTop, boxWidth, boxHeight);
    doc.setDrawColor(0);

    doc.setFontSize(7.5);
    doc.setFont(bodyFont, "bold");
    doc.setTextColor(120);
    doc.text("BILL TO", leftBoxX + 4, boxTop + 5);
    doc.text("PAYMENT STATUS", rightBoxX + 4, boxTop + 5);
    doc.setTextColor(0);

    doc.setFontSize(11);
    doc.setFont(bodyFont, "bold");
    doc.text(bill.clientName, leftBoxX + 4, boxTop + 11);
    doc.text(paymentState.status.replace("_", " "), rightBoxX + 4, boxTop + 11);

    doc.setFontSize(8.5);
    doc.setFont(bodyFont, "normal");
    doc.text(bill.clientPhone || "—", leftBoxX + 4, boxTop + 16);

    y = boxTop + boxHeight + 8;

    const tableColumn = ["Vehicle", "From", "To", "Engine", "Chassis", "Regd", "Rent", "Delivery", "Other", "Total"];
    const tableRows = bill.items.map((item) => {
      const rent = Number(item.rent);
      const delivery = Number(item.delivery);
      const otherExpense = Number(item.otherExpense);
      const total = rent + delivery + otherExpense;
      return [
        item.vehicleName || "—",
        item.fromText || "—",
        item.toText || "—",
        item.engineNumber || "—",
        item.chassisNumber || "—",
        item.regdNumber || "—",
        money(rent),
        money(delivery),
        money(otherExpense),
        money(total),
      ];
    });

    autoTable(doc, {
      startY: y,
      head: [tableColumn],
      body: tableRows,
      theme: resolveAutoTableTheme(presentation.pdf.tableBorderStyle),
      headStyles: { fontSize: 8, cellPadding: 2.2, fillColor: [243, 245, 247], textColor: 30, fontStyle: "bold" },
      bodyStyles: { fontSize: 8, cellPadding: 2.2 },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 18 },
        2: { cellWidth: 18 },
        3: { cellWidth: 14 },
        4: { cellWidth: 18 },
        5: { cellWidth: 16 },
        6: { cellWidth: 18, halign: "right" },
        7: { cellWidth: 18, halign: "right" },
        8: { cellWidth: 16, halign: "right" },
        9: { cellWidth: 22, halign: "right", fontStyle: "bold" },
      },
      margin: { left: 14, right: 14 },
    });

    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || y + 40;
    let summaryY = finalY + 8;
    if (summaryY > 240) {
      doc.addPage();
      summaryY = 14;
    }

    // FINANCIAL SUMMARY - a bordered box anchored to the right, matching
    // the approved invoice prototype's "Invoice Summary" box and the
    // ERP Bill Detail page's own summary box. Status is not repeated
    // here - it already appears in the "Payment Status" box above.
    const summaryBoxWidth = 74;
    const summaryBoxX = pageWidth - 14 - summaryBoxWidth;
    const summaryLineRows: [string, string][] = [
      ["Bill Total", money(totalAmount)],
      ["Received", money(paymentState.receivedAmount)],
      ["Remaining", money(paymentState.remainingDue)],
    ];
    const summaryRowHeight = 6.5;
    const summaryBoxHeight = 7 + summaryLineRows.length * summaryRowHeight + 9;

    doc.setDrawColor(210);
    doc.rect(summaryBoxX, summaryY, summaryBoxWidth, summaryBoxHeight);
    doc.setDrawColor(0);

    let rowY = summaryY + 6;
    doc.setFontSize(7.5);
    doc.setFont(bodyFont, "bold");
    doc.setTextColor(120);
    doc.text("INVOICE SUMMARY", summaryBoxX + 4, rowY);
    doc.setTextColor(0);
    rowY += 5.5;

    doc.setFontSize(bodySize - 1);
    for (const [label, value] of summaryLineRows) {
      doc.setFont(bodyFont, "normal");
      doc.text(label, summaryBoxX + 4, rowY);
      doc.text(value, summaryBoxX + summaryBoxWidth - 4, rowY, { align: "right" });
      rowY += summaryRowHeight;
    }

    doc.setDrawColor(190);
    doc.line(summaryBoxX + 4, rowY - 3, summaryBoxX + summaryBoxWidth - 4, rowY - 3);
    doc.setDrawColor(0);
    doc.setFont(bodyFont, "bold");
    doc.setFontSize(bodySize + 1);
    doc.text("Total", summaryBoxX + 4, rowY + 2.5);
    doc.text(money(totalAmount), summaryBoxX + summaryBoxWidth - 4, rowY + 2.5, { align: "right" });

    summaryY += summaryBoxHeight;

    // Invoice-specific content (Section 7 of Phase 2) - Payment
    // Instructions and Terms & Conditions default to the invoice-level
    // text when set, falling back to the global footer's own Terms &
    // Conditions rather than showing both (never duplicated).
    summaryY += 4;
    if (presentation.invoice.paymentInstructions) {
      if (summaryY > 250) { doc.addPage(); summaryY = 14; }
      doc.setFont(bodyFont, "bold");
      doc.setFontSize(9);
      doc.text("Payment Instructions:", 14, summaryY);
      summaryY += 5;
      doc.setFont(bodyFont, "normal");
      const wrapped = doc.splitTextToSize(presentation.invoice.paymentInstructions, pageWidth - 28);
      doc.text(wrapped, 14, summaryY);
      summaryY += wrapped.length * 4 + 4;
    }

    const terms = presentation.invoice.defaultTermsAndConditions || presentation.footer.termsAndConditions;
    if (terms) {
      if (summaryY > 250) { doc.addPage(); summaryY = 14; }
      doc.setFont(bodyFont, "bold");
      doc.setFontSize(9);
      doc.text("Terms & Conditions:", 14, summaryY);
      summaryY += 5;
      doc.setFont(bodyFont, "normal");
      const wrapped = doc.splitTextToSize(terms, pageWidth - 28);
      doc.text(wrapped, 14, summaryY);
      summaryY += wrapped.length * 4 + 4;
    }

    // Signature block - labels only from Settings (Authorized By /
    // Signature), never invented text; the actual signature/stamp
    // IMAGES are intentionally not stamped onto every generated Bill
    // automatically (that would misrepresent an unsigned document as
    // signed) - they remain available for manual/physical signing.
    if (summaryY < 250) {
      summaryY += 10;
      doc.setFontSize(9);
      doc.setFont(bodyFont, "normal");
      doc.line(14, summaryY, 70, summaryY);
      doc.text(presentation.invoice.signatureLabel || "Signature", 42, summaryY + 5, { align: "center" });
      doc.line(pageWidth - 70, summaryY, pageWidth - 14, summaryY);
      doc.text(presentation.invoice.authorizedByLabel || "Authorized Signature", pageWidth - 42, summaryY + 5, { align: "center" });
    }

    drawPdfFooter(doc, presentation);
    applyWatermark(doc, presentation);

    const pdfBuffer = doc.output("arraybuffer");
    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=Bill-${bill.billNo}.pdf`,
        // Never let a browser reuse an older generated PDF after a
        // Settings change - this document is always regenerated fresh
        // from the current BusinessSettings/DocumentTypeSettings.
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    console.error("Bill PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate Bill PDF" }, { status: 500 });
  }
}
