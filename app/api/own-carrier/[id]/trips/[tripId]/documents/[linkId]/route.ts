import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { unlinkDocumentFromTrip, setCarrierRentOnLink, CarrierTripError } from "@/lib/carrier-trip";
import { auditDelete, auditUpdate, actorFromUser, requestContext } from "@/lib/audit-log";

// PATCH /api/own-carrier/[id]/trips/[tripId]/documents/[linkId] - edit
// the manually-entered Carrier Rent on a linked (own-carrier) Challan.
// "Editable until close" - see lib/carrier-trip.ts's
// setCarrierRentOnLink for the full rejection rules.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string; linkId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId, linkId } = await params;
    const link = await prisma.carrierTripDocument.findUnique({ where: { id: linkId }, include: { trip: { select: { id: true, carrierId: true } } } });
    if (!link || link.trip.id !== tripId || link.trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Document link not found" }, { status: 404 });
    }

    const body = await request.json();
    const carrierRentAmount = Number(body.carrierRentAmount);
    if (!Number.isFinite(carrierRentAmount)) {
      return NextResponse.json({ success: false, message: "Carrier Rent must be a number" }, { status: 400 });
    }

    try {
      await prisma.$transaction(async (tx) => {
        await setCarrierRentOnLink(tx, { tripDocumentId: linkId, carrierRentAmount });

        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP",
          entityType: "CarrierTripDocument",
          entityId: linkId,
          description: `Set Carrier Rent on ${link.documentType} ${link.documentId} link to Rs. ${carrierRentAmount.toLocaleString()}`,
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Carrier Rent updated." });
  } catch (error) {
    console.error("Set carrier rent error:", error);
    return NextResponse.json({ success: false, message: "Unable to update Carrier Rent" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string; linkId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId, linkId } = await params;
    const link = await prisma.carrierTripDocument.findUnique({ where: { id: linkId }, include: { trip: { select: { id: true, carrierId: true } } } });
    if (!link || link.trip.id !== tripId || link.trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Document link not found" }, { status: 404 });
    }

    try {
      await prisma.$transaction(async (tx) => {
        await unlinkDocumentFromTrip(tx, { tripDocumentId: linkId, unlinkedById: currentUser.userId });

        await auditDelete(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP",
          entityType: "CarrierTripDocument",
          entityId: linkId,
          description: `Unlinked ${link.documentType} ${link.documentId} from Trip`,
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Document unlinked from Trip." });
  } catch (error) {
    console.error("Unlink carrier trip document error:", error);
    return NextResponse.json({ success: false, message: "Unable to unlink document" }, { status: 500 });
  }
}
