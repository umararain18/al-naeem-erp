import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyOutstandingDocuments, getPartyOutstandingSummary } from "@/lib/party-outstanding";

// ============================================================
// GET /api/parties/[id]/outstanding
//
// Party Outstanding Ledger (document-level, read-only) - see
// lib/party-outstanding.ts's own module header for the full design
// and its deliberate scope limitations. Completely separate from
// GET /api/parties/[id]/documents (the existing Documents/Outstanding
// tab's API), which is left entirely unmodified.
// ============================================================

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

    const documents = await getPartyOutstandingDocuments(prisma, party.account.id);
    const summary = await getPartyOutstandingSummary(documents);

    return NextResponse.json({
      success: true,
      party: { id: party.id, partyName: party.partyName, phone: party.phone },
      documents,
      summary,
    });
  } catch (error) {
    console.error("Get party outstanding ledger error:", error);
    return NextResponse.json({ success: false, message: "Unable to load outstanding ledger" }, { status: 500 });
  }
}
