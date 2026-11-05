import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { restoreCarrierTripLine, CarrierTripError } from "@/lib/carrier-trip";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

// POST - restores a Bin'd Trip line (lib/carrier-trip.ts's
// restoreCarrierTripLine) - flips BOTH CarrierTripLine.isDeleted and
// its own JournalEntry.isDeleted back in step, NEVER the generic
// /api/accounting-transactions/[id]/restore route (which only knows
// about the JournalEntry side - same reasoning as Payslip's own
// dedicated restore route, see app/api/bin/route.ts's own comment).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string; lineId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId, lineId } = await params;
    const line = await prisma.carrierTripLine.findUnique({ where: { id: lineId }, include: { trip: { select: { id: true, carrierId: true } } } });
    if (!line || line.trip.id !== tripId || line.trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Line not found" }, { status: 404 });
    }

    try {
      await prisma.$transaction(async (tx) => {
        await restoreCarrierTripLine(tx, { lineId, restoredById: currentUser.userId });

        await auditRestore(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: lineId,
          description: `Restored ${line.lineType} line (Rs. ${Number(line.amount).toLocaleString()}) on Trip from Bin`,
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Line restored successfully." });
  } catch (error) {
    console.error("Restore carrier trip line error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore line" }, { status: 500 });
  }
}
