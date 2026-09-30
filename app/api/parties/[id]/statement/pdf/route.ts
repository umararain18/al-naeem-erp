import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyDocumentStates } from "@/lib/payment-allocation";
import { getPartyLedgerData } from "@/lib/ledger-description";
import { resolvePdfPresentation } from "@/lib/pdf-presentation";
import { createPdfDocument, drawPdfHeader, drawPdfFooter, applyWatermark, resolveJsPdfFont } from "@/lib/pdf-render-helpers";

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

    // Authoritative Party Ledger summary - the exact same
    // getPartyLedgerData() the browser Party Ledger screen and the
    // Party Ledger PDF/Excel exports already use (lib/ledger-description.ts),
    // never a second, independently maintained recomputation. Only
    // `summary` is used here - the per-line `ledger` rows are not,
    // since this Statement's "Transaction Details" section below is a
    // document-level (Bilty) summary via getPartyDocumentStates(), a
    // genuinely different, Statement-specific view that
    // getPartyLedgerData() does not produce.
    const { summary } = await getPartyLedgerData(partyId, { from, to, order: "asc" });
    const { openingBalance, periodDebit, periodCredit, closingBalance } = summary;

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

    // Shares PARTY_STATEMENT's Header/Footer/Logo override with the
    // separate Party Ledger PDF (see that route's own comment) - the
    // enum has one party-facing document type, not two.
    const presentation = await resolvePdfPresentation(prisma, "PARTY_STATEMENT");
    const bodyFont = resolveJsPdfFont(presentation.pdf.defaultFont);

    const doc = createPdfDocument(presentation);
    const pageWidth = doc.internal.pageSize.getWidth();

    const { nextY } = await drawPdfHeader(doc, presentation, "STATEMENT OF ACCOUNT");
    let y = nextY;

    doc.setFontSize(10);
    doc.setFont(bodyFont, "normal");
    doc.text(`Party: ${party.partyName}`, 14, y);
    doc.text(`Period: ${from || "-"}  to  ${to || "-"}`, pageWidth - 14, y, { align: "right" });
    y += 10;

    doc.setFont(bodyFont, "bold");
    doc.text(`Opening Balance: ${formatCurrency(openingBalance)}`, 14, y);
    doc.text(`Total Debit: ${formatCurrency(periodDebit)}`, 14, y + 6);
    doc.text(`Total Credit: ${formatCurrency(periodCredit)}`, 14, y + 12);
    doc.text(`Closing Balance: ${formatCurrency(closingBalance)}`, 14, y + 18);
    y += 28;

    doc.setFont(bodyFont, "bold");
    doc.text("Transaction Details", 14, y);
    y += 7;
    doc.setFont(bodyFont, "normal");
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

    drawPdfFooter(doc, presentation);
    applyWatermark(doc, presentation);

    const pdfBuffer = doc.output("arraybuffer");

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename=Statement-${party.partyName.replace(/\s+/g, "-")}.pdf`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    console.error("Party statement PDF error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate statement PDF" }, { status: 500 });
  }
}
