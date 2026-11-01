import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getPreviousTripExpenseTemplates } from "@/lib/carrier-trip";

// GET - "Copy from previous trip" / the auto-copy-on-create source:
// a pure read of the carrier's most recent OTHER Trip's own recurring
// expense/salary lines, as blank-amount templates. Never writes
// anything - see lib/carrier-trip.ts's getPreviousTripExpenseTemplates
// for why this can never produce a JournalEntry by itself.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId } = await params;
    const trip = await prisma.carrierTrip.findUnique({ where: { id: tripId }, select: { carrierId: true } });
    if (!trip || trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }

    const result = await getPreviousTripExpenseTemplates(prisma, id, tripId);
    if (!result) {
      return NextResponse.json({ success: true, previousTripNo: null, templates: [] });
    }

    return NextResponse.json({ success: true, previousTripNo: result.previousTripNo, templates: result.templates });
  } catch (error) {
    console.error("Get previous trip expense templates error:", error);
    return NextResponse.json({ success: false, message: "Unable to load previous Trip's expenses" }, { status: 500 });
  }
}
