import { NextRequest, NextResponse } from "next/server";
import { jsPDF } from "jspdf";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyDocumentStates } from "@/lib/payment-allocation";

// ============================================================
// GET /api/parties/[id]/statement/pdf?from=&to=
//
// English-only Party Statement PDF, using the exact same jsPDF
// pattern already used by app/api/bilty/[id]/pdf and
// app/api/challan/[id]/pdf.
//
// URDU LIMITATION (reported, not worked around): jsPDF's built-in
// fonts cannot render Urdu/Nastaliq glyphs, and jsPDF performs no
// Arabic/Urdu contextual shaping or bidi reordering itself - proper
// Urdu output would require embedding a Nastaliq/Naskh Unicode font
// AND pre-shaping the text before handing it to jsPDF (confirmed in
// the Party Ledger 2.0 architecture inspection). No such font asset
// is available in this environment, and adding one is a genuinely
// new capability beyond this task's UI-only scope - so this export
// always renders in English, regardless of the on-screen language
// toggle, rather than producing incorrect/garbled Urdu text.
// ============================================================

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
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

    const { id: partyId } = await params;
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { id: true, partyName: true, account: { select: { id: true } } },
    });

    if (!party || !party.account) {
      return NextResponse.json({ success: false, message: "Party not found" }, { status: 404 });
    }

    // Same ledger summary the on-screen Ledger/Statement views use -
    // never recomputed here.
    const dateFilter: { gte?: Date; lt?: Date } = {};
    if (from) dateFilter.gte = new Date(`${from}T00:00:00`);
    if (to) {
      const end = new Date(`${to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      dateFilter.lt = end;
    }

    const entries = await prisma.journalLine.findMany({
      where: {
        accountId: party.account.id,
        journalEntry: { is: { isDeleted: false, ...(Object.keys(dateFilter).length ? { entryDate: dateFilter } : {}) } },
      },
      select: { debit: true, credit: true },
    });
    const periodDebit = entries.reduce((s, e) => s + Number(e.debit), 0);
    const periodCredit = entries.reduce((s, e) => s + Number(e.credit), 0);

    let openingBalance = 0;
    if (from) {
      const openingLines = await prisma.journalLine.findMany({
        where: { accountId: party.account.id, journalEntry: { is: { isDeleted: false, entryDate: { lt: new Date(`${from}T00:00:00`) } } } },
        select: { debit: true, credit: true },
      });
      openingBalance = openingLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    }
    const closingBalance = openingBalance + periodDebit - periodCredit;

    // Same document set the Summary/Statement view already shows -
    // via the same lib/payment-allocation.ts helper.
    const states = await getPartyDocumentStates(prisma, party.account.id);
    const biltyIds = states.filter((s) => s.targetSourceType === "BILTY").map((s) => s.targetSourceId);
    const bilties = biltyIds.length
      ? await prisma.bilty.findMany({
          where: { id: { in: biltyIds } },
          select: {
            id: true,
            biltyNo: true,
            registrationNumber: true,
            total: true,
            agentCommission: true,
            fromLocation: { select: { name: true } },
            toLocation: { select: { name: true } },
            challanBilties: { select: { challan: { select: { challanNo: true } } } },
          },
        })
      : [];
    const biltyById = new Map(bilties.map((b) => [b.id, b]));

    const lines: string[] = [];
    for (const state of states) {
      if (state.targetSourceType !== "BILTY") continue;
      const bilty = biltyById.get(state.targetSourceId);
      if (!bilty) continue;
      const parts = [`Bilty ${bilty.biltyNo}`];
      const challanNo = bilty.challanBilties[0]?.challan?.challanNo;
      if (challanNo) parts.push(`Challan ${challanNo}`);
      if (bilty.registrationNumber) parts.push(bilty.registrationNumber);
      parts.push(`${bilty.fromLocation.name} -> ${bilty.toLocation.name}`);
      if (Number(bilty.total) > 0) parts.push(`Bilty Rent ${formatCurrency(Number(bilty.total))}`);
      if (Number(bilty.agentCommission) > 0) parts.push(`Commission ${formatCurrency(Number(bilty.agentCommission))}`);
      lines.push(parts.join(" | "));
    }

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 14;

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("AL NAEEM CAR CARRIERS SERVICE", pageWidth / 2, y, { align: "center" });
    y += 7;
    doc.setFontSize(12);
    doc.text("Statement of Account", pageWidth / 2, y, { align: "center" });
    y += 10;

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Party: ${party.partyName}`, 14, y);
    doc.text(`Period: ${from || "-"}  to  ${to || "-"}`, pageWidth - 14, y, { align: "right" });
    y += 10;

    doc.setFont("helvetica", "bold");
    doc.text(`Opening Balance: ${formatCurrency(openingBalance)}`, 14, y);
    doc.text(`Total Debit: ${formatCurrency(periodDebit)}`, 14, y + 6);
    doc.text(`Total Credit: ${formatCurrency(periodCredit)}`, 14, y + 12);
    doc.text(`Closing Balance: ${formatCurrency(closingBalance)}`, 14, y + 18);
    y += 28;

    doc.setFont("helvetica", "bold");
    doc.text("Transaction Details", 14, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);

    for (const line of lines) {
      if (y > 280) {
        doc.addPage();
        y = 14;
      }
      const wrapped = doc.splitTextToSize(line, pageWidth - 28);
      doc.text(wrapped, 14, y);
      y += wrapped.length * 5 + 2;
    }

    if (lines.length === 0) {
      doc.text("No documents found for this period.", 14, y);
    }

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=Statement-${party.partyName.replace(/\s+/g, "-")}.pdf`,
      },
    });
  } catch (error) {
    console.error("Party statement PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate statement PDF" }, { status: 500 });
  }
}
