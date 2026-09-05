import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPartyDocumentStates } from "@/lib/payment-allocation";

// ============================================================
// GET /api/parties/[id]/documents
//
// Powers the Party Ledger 2.0 Documents/Outstanding/Summary/
// Statement views - all of them are different renderings of the
// SAME underlying document set. This is purely additive and
// read-only: every amount comes from getPartyDocumentStates()
// (lib/payment-allocation.ts, itself built entirely on the
// existing, protected settlement/party-resolution architecture) -
// nothing here recalculates a financial figure.
//
// "Document No." ordering within a Challan uses ChallanBilty.addedAt
// (the existing, only source of Bilty sequence within a Challan -
// see lib/payment-allocation.ts's own Section G note) - never
// reordered.
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
    const { searchParams } = new URL(request.url);
    const onlyOutstanding = searchParams.get("status") === "OUTSTANDING";
    const biltyNoFilter = searchParams.get("biltyNo")?.trim().toLowerCase();
    const challanNoFilter = searchParams.get("challanNo")?.trim().toLowerCase();
    const registrationFilter = searchParams.get("registrationNumber")?.trim().toLowerCase();
    const chassisFilter = searchParams.get("chassisNumber")?.trim().toLowerCase();

    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { id: true, partyName: true, account: { select: { id: true } } },
    });

    if (!party) {
      return NextResponse.json({ success: false, message: "Party not found" }, { status: 404 });
    }
    if (!party.account) {
      return NextResponse.json({ success: false, message: "This party does not have an account yet." }, { status: 404 });
    }

    const states = await getPartyDocumentStates(prisma, party.account.id, {
      onlyWithRemainingBalance: onlyOutstanding,
    });

    const biltyIds = states.filter((s) => s.targetSourceType === "BILTY").map((s) => s.targetSourceId);
    const challanIdsFromBiltyTargets = new Set<string>();

    const bilties = biltyIds.length
      ? await prisma.bilty.findMany({
          where: { id: { in: biltyIds } },
          select: {
            id: true,
            biltyNo: true,
            date: true,
            registrationNumber: true,
            chassisNumber: true,
            vehicleType: true,
            total: true,
            agentCommission: true,
            fromLocation: { select: { name: true } },
            toLocation: { select: { name: true } },
            challanBilties: {
              select: { addedAt: true, challan: { select: { id: true, challanNo: true, carrierRent: true } } },
            },
          },
        })
      : [];
    const biltyById = new Map(bilties.map((b) => [b.id, b]));
    for (const b of bilties) {
      const activeLink = b.challanBilties[0];
      if (activeLink?.challan) challanIdsFromBiltyTargets.add(activeLink.challan.id);
    }

    const challanTargetIds = states.filter((s) => s.targetSourceType === "CHALLAN").map((s) => s.targetSourceId);
    const allChallanIds = [...new Set([...challanTargetIds, ...challanIdsFromBiltyTargets])];

    const challans = allChallanIds.length
      ? await prisma.challan.findMany({
          where: { id: { in: allChallanIds } },
          select: { id: true, challanNo: true, loadingDate: true, carrierRent: true },
        })
      : [];
    const challanById = new Map(challans.map((c) => [c.id, c]));

    interface DocumentRow {
      targetSourceType: "BILTY" | "CHALLAN";
      targetSourceId: string;
      documentNo: string;
      documentDate: string;
      totalDue: number;
      receivedOrPaid: number;
      allocatedViaTable: number;
      remainingAllocatable: number;
      status: "UNPAID" | "PARTIALLY_PAID" | "FULLY_PAID";
      challanId: string | null;
      challanNo: string | null;
      biltyId: string | null;
      biltyNo: string | null;
      vehicleRegistrationNumber: string | null;
      chassisNumber: string | null;
      vehicleType: string | null;
      fromLocation: string | null;
      toLocation: string | null;
      biltyRent: number | null;
      carrierRent: number | null;
      commission: number | null;
      billNo: null;
      sequenceIndex: number;
    }

    const rows: DocumentRow[] = [];

    for (const state of states) {
      if (state.targetSourceType === "BILTY") {
        const bilty = biltyById.get(state.targetSourceId);
        if (!bilty) continue;

        if (biltyNoFilter && !bilty.biltyNo.toLowerCase().includes(biltyNoFilter)) continue;
        if (registrationFilter && !(bilty.registrationNumber || "").toLowerCase().includes(registrationFilter)) continue;
        if (chassisFilter && !(bilty.chassisNumber || "").toLowerCase().includes(chassisFilter)) continue;

        const activeLink = bilty.challanBilties[0];
        const challan = activeLink?.challan || null;
        if (challanNoFilter && !(challan?.challanNo || "").toLowerCase().includes(challanNoFilter)) continue;

        const remaining = state.remainingAllocatable;
        const status: DocumentRow["status"] =
          remaining <= 0.009 ? "FULLY_PAID" : state.existingReceivedOrPaid > 0.009 ? "PARTIALLY_PAID" : "UNPAID";

        rows.push({
          targetSourceType: "BILTY",
          targetSourceId: state.targetSourceId,
          documentNo: bilty.biltyNo,
          documentDate: bilty.date.toISOString(),
          totalDue: state.totalDue,
          receivedOrPaid: state.existingReceivedOrPaid,
          allocatedViaTable: state.allocatedViaTable,
          remainingAllocatable: remaining,
          status,
          challanId: challan?.id || null,
          challanNo: challan?.challanNo || null,
          biltyId: bilty.id,
          biltyNo: bilty.biltyNo,
          vehicleRegistrationNumber: bilty.registrationNumber,
          chassisNumber: bilty.chassisNumber,
          vehicleType: bilty.vehicleType,
          fromLocation: bilty.fromLocation.name,
          toLocation: bilty.toLocation.name,
          biltyRent: Number(bilty.total) > 0 ? Number(bilty.total) : null,
          carrierRent: null,
          commission: Number(bilty.agentCommission) > 0 ? Number(bilty.agentCommission) : null,
          billNo: null,
          sequenceIndex: activeLink ? activeLink.addedAt.getTime() : 0,
        });
      } else {
        const challan = challanById.get(state.targetSourceId);
        if (!challan) continue;
        if (challanNoFilter && !challan.challanNo.toLowerCase().includes(challanNoFilter)) continue;
        // A pure Carrier Rent (Challan-level) target has no single
        // Bilty/vehicle of its own - registration/chassis filters
        // therefore never match it, by design (never guess a
        // vehicle for a Challan-level due).
        if (registrationFilter || chassisFilter || biltyNoFilter) continue;

        const remaining = state.remainingAllocatable;
        const status: DocumentRow["status"] =
          remaining <= 0.009 ? "FULLY_PAID" : state.existingReceivedOrPaid > 0.009 ? "PARTIALLY_PAID" : "UNPAID";

        rows.push({
          targetSourceType: "CHALLAN",
          targetSourceId: state.targetSourceId,
          documentNo: challan.challanNo,
          documentDate: challan.loadingDate.toISOString(),
          totalDue: state.totalDue,
          receivedOrPaid: state.existingReceivedOrPaid,
          allocatedViaTable: state.allocatedViaTable,
          remainingAllocatable: remaining,
          status,
          challanId: challan.id,
          challanNo: challan.challanNo,
          biltyId: null,
          biltyNo: null,
          vehicleRegistrationNumber: null,
          chassisNumber: null,
          vehicleType: null,
          fromLocation: null,
          toLocation: null,
          biltyRent: null,
          carrierRent: Number(challan.carrierRent),
          commission: null,
          billNo: null,
          sequenceIndex: 0,
        });
      }
    }

    rows.sort((a, b) => new Date(a.documentDate).getTime() - new Date(b.documentDate).getTime() || a.sequenceIndex - b.sequenceIndex);

    return NextResponse.json({
      success: true,
      party: { id: party.id, partyName: party.partyName },
      documents: rows,
    });
  } catch (error) {
    console.error("Get party documents error:", error);
    return NextResponse.json({ success: false, message: "Unable to load party documents" }, { status: 500 });
  }
}
