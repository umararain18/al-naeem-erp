import { NextRequest, NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyLedgerData, PartyLedgerLookupError } from "@/lib/ledger-description";

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

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 14;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("AL NAEEM CAR CARRIERS SERVICE", pageWidth / 2, y, { align: "center" });
    y += 7;
    doc.setFontSize(12);
    doc.text("Party Ledger", pageWidth / 2, y, { align: "center" });
    y += 10;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Party: ${data.party.partyName}`, 14, y);
    if (from || to) {
      doc.text(`Period: ${from || "-"}  to  ${to || "-"}`, pageWidth - 14, y, { align: "right" });
    }
    y += 8;

    doc.setFont("helvetica", "bold");
    doc.text(`Opening Balance: ${formatCurrency(data.summary.openingBalance)}`, 14, y);
    y += 8;

    const tableRows = data.ledger.map((row) => [
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
      theme: "grid",
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
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(`Closing Balance: ${formatCurrency(data.summary.closingBalance)}`, 14, closingY);

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=Ledger-${data.party.partyName.replace(/\s+/g, "-")}.pdf`,
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
