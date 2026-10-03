import { NextRequest, NextResponse } from "next/server";
import autoTable from "jspdf-autotable";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getEmployeeLedgerData } from "@/lib/payroll-accounting";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import { createPdfDocument, drawPdfHeader, drawPdfFooter, applyWatermark, resolveAutoTableTheme, resolveJsPdfFont } from "@/lib/pdf-render-helpers";
import { formatBusinessDate } from "@/lib/date-range";

// ============================================================
// GET /api/employees/[id]/ledger/pdf?from=&to=
//
// Real PDF export, built from the exact same read-only
// getEmployeeLedgerData() the screen ledger uses - mirrors
// app/api/parties/[id]/ledger/pdf/route.ts exactly (same libraries,
// same layout), no second calculation.
// ============================================================

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

    // No dedicated "employee ledger" SettingsDocumentType value exists
    // in the fixed enum (BILTY/CHALLAN/BILL/PRIVATE_PHONCH/
    // SHOWROOM_PHONCH/RECEIPT/PARTY_STATEMENT/REPORTS) - REPORTS is the
    // closest existing generic bucket, used here rather than inventing
    // a new enum value. Documented as a known limitation, not a silent
    // guess.
    const presentation = await resolvePdfPresentation(prisma, "REPORTS");
    const bodyFont = resolveJsPdfFont(presentation.pdf.defaultFont);

    const doc = createPdfDocument(presentation);
    const pageWidth = doc.internal.pageSize.getWidth();

    const { nextY } = await drawPdfHeader(doc, presentation, "EMPLOYEE LEDGER");
    let y = nextY;

    doc.setFontSize(10);
    doc.setFont(bodyFont, "normal");
    doc.text(`Employee: ${data.employee.name} (${data.employee.employeeCode})`, 14, y);
    if (from || to) {
      doc.text(`Period: ${from || "-"}  to  ${to || "-"}`, pageWidth - 14, y, { align: "right" });
    }
    y += 8;

    doc.setFont(bodyFont, "bold");
    doc.text(`Opening Balance: ${formatCurrency(data.summary.openingBalance)}`, 14, y);
    y += 8;

    const tableRows = data.entries.map((row) => [
      formatBusinessDate(row.date),
      row.description,
      row.debit > 0 ? formatCurrency(row.debit) : "-",
      row.credit > 0 ? formatCurrency(row.credit) : "-",
      formatCurrency(row.balance),
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
        "Content-Disposition": `inline; filename=Employee-Ledger-${data.employee.name.replace(/\s+/g, "-")}.pdf`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    console.error("Employee ledger PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate ledger PDF" }, { status: 500 });
  }
}
