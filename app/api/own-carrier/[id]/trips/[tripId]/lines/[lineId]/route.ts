import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { reverseCarrierTripLine, CarrierTripError } from "@/lib/carrier-trip";
import { auditDelete, actorFromUser, requestContext } from "@/lib/audit-log";

// DELETE - never a real delete. Posts a compensating JournalEntry
// (reversesEntryId) and flips CarrierTripLine.isDeleted - same Bin/
// reversal discipline as every other accounting-relevant row in this
// codebase (see lib/carrier-trip.ts's reverseCarrierTripLine).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string; lineId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId, lineId } = await params;
    const line = await prisma.carrierTripLine.findUnique({ where: { id: lineId }, include: { trip: { select: { id: true, carrierId: true } } } });
    if (!line || line.trip.id !== tripId || line.trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Line not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));

    try {
      await prisma.$transaction(async (tx) => {
        await reverseCarrierTripLine(tx, { lineId, deletedById: currentUser.userId, reason: body?.reason });

        await auditDelete(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: lineId,
          description: `Reversed ${line.lineType} line (Rs. ${Number(line.amount).toLocaleString()}) on Trip${body?.reason ? `: ${body.reason}` : ""}`,
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Line reversed successfully." });
  } catch (error) {
    console.error("Reverse carrier trip line error:", error);
    return NextResponse.json({ success: false, message: "Unable to reverse line" }, { status: 500 });
  }
}
