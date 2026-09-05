import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { jsPDF } from "jspdf";

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

    if (!hasPermission(currentUser, "bilty.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const bilty = await prisma.bilty.findUnique({
      where: { id },
      include: {
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
        consignorParty: { select: { id: true, partyName: true } },
        consigneeParty: { select: { id: true, partyName: true } },
        clearingAgentParty: { select: { id: true, partyName: true } },
        agentParty: { select: { id: true, partyName: true } },
        createdBy: { select: { id: true, fullName: true, username: true } },
      },
    });

    if (!bilty || bilty.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Bilty not found" },
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
    doc.text("BILTY", pageWidth / 2, y, { align: "center" });
    y += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");

    const detailRows = [
      ["Bilty No", bilty.biltyNo],
      ["Date", new Date(bilty.date).toLocaleDateString()],
      ["Status", bilty.status.replace("_", " ")],
    ];

    for (const [label, value] of detailRows) {
      doc.setFont("helvetica", "bold");
      doc.text(`${label}:`, 14, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(value), 50, y);
      y += 5;
    }

    y += 4;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("ROUTE", pageWidth / 2, y, { align: "center" });
    y += 5;

    doc.setFontSize(11);
    doc.text(
      `${bilty.fromLocation.name}  -------------------→  ${bilty.toLocation.name}`,
      pageWidth / 2,
      y,
      { align: "center" }
    );
    y += 8;

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("CONSIGNOR", 14, y);
    doc.text("CONSIGNEE", pageWidth - 14, y, { align: "right" });
    y += 4;

    const leftX = 14;
    const rightX = pageWidth / 2 + 4;
    const rightWidth = pageWidth - rightX - 14;

    const leftItems = [
      ["Party", bilty.consignorParty?.partyName || "—"],
      ["Name", bilty.consignorName],
      ["Phone", bilty.consignorPhone || "—"],
    ];

    const rightItems = [
      ["Party", bilty.consigneeParty?.partyName || "—"],
      ["Name", bilty.consigneeName],
      ["Phone", bilty.consigneePhone || "—"],
    ];

    for (let i = 0; i < Math.max(leftItems.length, rightItems.length); i++) {
      if (i < leftItems.length) {
        const [label, value] = leftItems[i];
        doc.setFont("helvetica", "bold");
        doc.text(`${label}:`, leftX, y);
        doc.setFont("helvetica", "normal");
        doc.text(String(value), leftX + 22, y);
      }
      if (i < rightItems.length) {
        const [label, value] = rightItems[i];
        doc.setFont("helvetica", "bold");
        doc.text(`${label}:`, rightX, y);
        doc.setFont("helvetica", "normal");
        doc.text(String(value), rightX + 22, y);
      }
      y += 5;
    }

    y += 4;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("CLEARING AGENT / DELIVERY POINT", 14, y);
    y += 5;

    const agentRows = [
      ["Name", bilty.clearingAgentName || "—"],
      ["Party", bilty.clearingAgentParty?.partyName || "—"],
    ];

    for (const [label, value] of agentRows) {
      doc.setFont("helvetica", "bold");
      doc.text(`${label}:`, 14, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(value), 50, y);
      y += 5;
    }

    y += 4;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("VEHICLE DETAILS", 14, y);
    y += 5;

    const vehicleRows = [
      ["Type", bilty.vehicleType || "—"],
      ["Model", bilty.vehicleModel || "—"],
      ["Color", bilty.vehicleColor || "—"],
      ["Registration Number", bilty.registrationNumber || "—"],
      ["Engine Number", bilty.engineNumber || "—"],
      ["Chassis Number", bilty.chassisNumber || "—"],
    ];

    for (const [label, value] of vehicleRows) {
      doc.setFont("helvetica", "bold");
      doc.text(`${label}:`, 14, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(value), 60, y);
      y += 5;
    }

    y += 4;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("FINANCIAL SUMMARY", 14, y);
    y += 5;

    const financialRows = [
      ["Rent", `Rs. ${Number(bilty.rent || 0).toLocaleString()}`],
      ["Insurance", `Rs. ${Number(bilty.insurance || 0).toLocaleString()}`],
      ["Expense", `Rs. ${Number(bilty.expense || 0).toLocaleString()}`],
      ["Total", `Rs. ${Number(bilty.total || 0).toLocaleString()}`],
      ["Advance", `Rs. ${Number(bilty.advance || 0).toLocaleString()}`],
      ["To Pay", `Rs. ${Number(bilty.toPay || 0).toLocaleString()}`],
    ];

    for (const [label, value] of financialRows) {
      doc.setFont("helvetica", "bold");
      doc.text(`${label}:`, 14, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(value), 50, y);
      y += 5;
    }

    y += 4;

    if (bilty.agentParty || Number(bilty.agentCommission || 0) > 0 || bilty.agentDescription) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text("COMMISSION / REFERRAL", 14, y);
      y += 5;

      const commissionRows = [
        ["Agent / Referral Party", bilty.agentParty?.partyName || "—"],
        ["Commission", `Rs. ${Number(bilty.agentCommission || 0).toLocaleString()}`],
      ];

      if (bilty.agentDescription) {
        commissionRows.push(["Description", bilty.agentDescription]);
      }

      for (const [label, value] of commissionRows) {
        doc.setFont("helvetica", "bold");
        doc.text(`${label}:`, 14, y);
        doc.setFont("helvetica", "normal");
        doc.text(String(value), 60, y);
        y += 5;
      }

      y += 4;
    }

    if (bilty.notes) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text("NOTES", 14, y);
      y += 5;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);

      const splitNotes = doc.splitTextToSize(String(bilty.notes), pageWidth - 28);
      for (const line of splitNotes) {
        doc.text(line, 14, y);
        y += 4;
      }

      y += 4;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("SIGNATURES", 14, y);
    y += 6;

    const signatureY = y;
    doc.line(14, signatureY + 14, 60, signatureY + 14);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text("Received By", 14, signatureY + 18, { align: "center" });

    doc.line(pageWidth / 2 - 23, signatureY + 14, pageWidth / 2 + 23, signatureY + 14);
    doc.text("Driver Signature", pageWidth / 2, signatureY + 18, { align: "center" });

    doc.line(pageWidth - 60, signatureY + 14, pageWidth - 14, signatureY + 14);
    doc.text("Authorized Signature", pageWidth - 37, signatureY + 18, { align: "center" });

    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text("Generated: " + new Date().toLocaleString(), pageWidth - 14, 285, { align: "right" });

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=Bilty-${bilty.biltyNo}.pdf`,
      },
    });
  } catch (error) {
    console.error("Generate bilty PDF error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to generate PDF" },
      { status: 500 }
    );
  }
}
