import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!hasPermission(currentUser, "challan.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const challan = await prisma.challan.findUnique({
      where: { id },
      include: {
        transporterParty: { select: { id: true, partyName: true } },
        bilties: {
          include: {
            bilty: {
              include: {
                fromLocation: { select: { id: true, name: true } },
                toLocation: { select: { id: true, name: true } },
                consigneeParty: { select: { id: true, partyName: true } },
                clearingAgentParty: { select: { id: true, partyName: true } },
              },
            },
          },
          orderBy: { addedAt: "asc" },
        },
      },
    });

    if (!challan || challan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 10;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("AL NAEEM CAR CARRIERS SERVICE", pageWidth / 2, y, { align: "center" });
    y += 6;

    doc.setFontSize(16);
    doc.text("CHALLAN", pageWidth / 2, y, { align: "center" });
    y += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");

    const detailRows = [
      ["Challan No", challan.challanNo],
      ["Loading Date", new Date(challan.loadingDate).toLocaleDateString()],
      ["Transporter", challan.transporterParty?.partyName || "—"],
      ["Driver", [challan.driverName, challan.driverPhone].filter(Boolean).join(" / ") || "—"],
      ["Carrier Number", challan.carrierNumber || "—"],
      ["Status", challan.status.replace("_", " ")],
    ];

    for (const [label, value] of detailRows) {
      doc.setFont("helvetica", "bold");
      doc.text(`${label}:`, 14, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(value), 50, y);
      y += 5;
    }

    y += 4;

    const tableColumn = ["Bilty No", "From", "To", "Consignee", "Vehicle", "Reg No", "Clearing Agent", "Carrier Rent", "To Pay"];
    const tableRows: string[][] = [];

    for (const cb of challan.bilties) {
      const bilty = cb.bilty;
      const vehicle = [bilty.vehicleType, bilty.vehicleModel].filter(Boolean).join(" / ") || "—";
      tableRows.push([
        bilty.biltyNo,
        bilty.fromLocation.name,
        bilty.toLocation.name,
        bilty.consigneeName,
        vehicle,
        bilty.registrationNumber || "—",
        bilty.clearingAgentParty?.partyName || "—",
        `Rs. ${Number(challan.carrierRent || 0).toLocaleString()}`,
        `Rs. ${Number(bilty.toPay || 0).toLocaleString()}`,
      ]);
    }

    autoTable(doc, {
      startY: y,
      head: [tableColumn],
      body: tableRows,
      theme: "grid",
      headStyles: { fontSize: 9, cellPadding: 2 },
      bodyStyles: { fontSize: 9, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 20 },
        1: { cellWidth: 18 },
        2: { cellWidth: 18 },
        3: { cellWidth: 26 },
        4: { cellWidth: 22 },
        5: { cellWidth: 20 },
        6: { cellWidth: 24 },
        7: { cellWidth: 22, halign: "right" },
        8: { cellWidth: 20, halign: "right" },
      },
      margin: { left: 14, right: 14 },
    });

    const finalY = (doc as any).lastAutoTable?.finalY || y + 40;

    let summaryY = finalY + 8;
    if (summaryY > 270) {
      doc.addPage();
      summaryY = 14;
    }

    const totalToPay = challan.bilties.reduce((sum, cb) => sum + Number(cb.bilty.toPay || 0), 0);
    const carrierRent = Number(challan.carrierRent || 0);
    const receivable = Math.max(totalToPay - carrierRent, 0);
    const net = totalToPay - carrierRent;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Financial Summary", 14, summaryY);
    summaryY += 5;

    const financialRows = [
      ["Receivable", `Rs. ${receivable.toLocaleString()}`],
      ["Payable", `Rs. ${carrierRent.toLocaleString()}`],
      ["Net Position", `Rs. ${net.toLocaleString()}`],
    ];

    for (const [label, value] of financialRows) {
      doc.setFont("helvetica", "bold");
      doc.text(`${label}:`, 14, summaryY);
      doc.setFont("helvetica", "normal");
      doc.text(String(value), 50, summaryY);
      summaryY += 5;
    }

    if (challan.isSettled) {
      summaryY += 4;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text("FINAL SETTLEMENT", 14, summaryY);
      summaryY += 5;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);

      const settlementRows = [
        ["Settlement Status", "Settled"],
        ["Settlement Date", challan.settledAt ? new Date(challan.settledAt).toLocaleString() : "—"],
        ["Receivable", `Rs. ${receivable.toLocaleString()}`],
        ["Payable", `Rs. ${carrierRent.toLocaleString()}`],
        ["Accounting Reference", challan.settlementJournalEntryId || "—"],
      ];

      for (const [label, value] of settlementRows) {
        doc.setFont("helvetica", "bold");
        doc.text(`${label}:`, 14, summaryY);
        doc.setFont("helvetica", "normal");
        doc.text(String(value), 60, summaryY);
        summaryY += 4;
      }

      if (challan.settlementNotes) {
        doc.setFont("helvetica", "bold");
        doc.text(`Notes:`, 14, summaryY);
        doc.setFont("helvetica", "normal");
        const splitNotes = doc.splitTextToSize(String(challan.settlementNotes), pageWidth - 70);
        doc.text(splitNotes, 60, summaryY);
        summaryY += splitNotes.length * 4;
      }
    }

    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Status: ${challan.status.replace("_", " ")}`, 14, 285);
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageWidth - 14, 285, { align: "right" });

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=challan-${challan.challanNo}.pdf`,
      },
    });
  } catch (error) {
    console.error("Generate challan PDF error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to generate PDF" },
      { status: 500 }
    );
  }
}
