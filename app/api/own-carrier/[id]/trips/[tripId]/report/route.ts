import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getTripProfitReport, CarrierTripError } from "@/lib/carrier-trip";

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

    const report = await getTripProfitReport(prisma, tripId);
    return NextResponse.json({ success: true, report });
  } catch (error) {
    if (error instanceof CarrierTripError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 400 });
    }
    console.error("Get carrier trip report error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Trip report" }, { status: 500 });
  }
}
