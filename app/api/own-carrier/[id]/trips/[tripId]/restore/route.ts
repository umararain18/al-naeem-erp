import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId } = await params;

    const restored = await prisma.$transaction(async (tx) => {
      const trip = await tx.carrierTrip.findUnique({ where: { id: tripId }, select: { id: true, carrierId: true, isDeleted: true, tripNo: true } });
      if (!trip || trip.carrierId !== id) return null;
      if (!trip.isDeleted) throw new Error("NOT_BINNED");

      const restoredTrip = await tx.carrierTrip.update({
        where: { id: tripId },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "CARRIER_TRIP",
        entityType: "CarrierTrip",
        entityId: tripId,
        documentNo: trip.tripNo,
        description: `Restored Trip ${trip.tripNo} from Bin`,
        ...requestContext(request),
      });

      return restoredTrip;
    });

    if (!restored) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Trip restored successfully.", tripId });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json({ success: false, message: "Only binned Trips can be restored" }, { status: 400 });
    }
    console.error("Restore carrier trip error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore Trip" }, { status: 500 });
  }
}
