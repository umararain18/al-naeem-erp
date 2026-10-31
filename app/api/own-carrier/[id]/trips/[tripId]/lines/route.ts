import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { CarrierTripError, postTripLineByType, TRIP_LINE_TYPES, type TripLineType } from "@/lib/carrier-trip";
import { auditPost, actorFromUser, requestContext } from "@/lib/audit-log";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId } = await params;
    const trip = await prisma.carrierTrip.findUnique({ where: { id: tripId }, select: { carrierId: true } });
    if (!trip || trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }

    const body = await request.json();
    const lineType = body.lineType as TripLineType;
    if (!TRIP_LINE_TYPES.includes(lineType)) {
      return NextResponse.json({ success: false, message: "Invalid line type" }, { status: 400 });
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: "Amount must be greater than zero" }, { status: 400 });
    }
    const date = body.date ? new Date(`${body.date}T00:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }
    const description: string | null = body.description?.trim() || null;

    let line;
    try {
      line = await prisma.$transaction(async (tx) => {
        return postTripLineByType(tx, lineType, { tripId, date, description, amount, createdById: currentUser.userId }, body);
      });

      await prisma.$transaction(async (tx) => {
        await auditPost(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: line!.id,
          description: `Posted ${lineType} line (Rs. ${amount.toLocaleString()}) on Trip`,
          newValues: { lineType, amount },
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Line posted successfully.", line: { id: line.id } }, { status: 201 });
  } catch (error) {
    console.error("Post carrier trip line error:", error);
    return NextResponse.json({ success: false, message: "Unable to post line" }, { status: 500 });
  }
}
