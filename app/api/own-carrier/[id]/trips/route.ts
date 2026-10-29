import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { suggestNextTripNo } from "@/lib/carrier-trip";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const carrier = await prisma.ownCarrier.findUnique({ where: { id }, select: { id: true, isDeleted: true } });
    if (!carrier || carrier.isDeleted) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    const trips = await prisma.carrierTrip.findMany({
      where: { carrierId: id, isDeleted: false },
      include: {
        documents: { where: { unlinkedAt: null }, select: { id: true } },
        lines: { where: { isDeleted: false }, select: { id: true } },
      },
      orderBy: [{ dateFrom: "desc" }, { createdAt: "desc" }],
    });

    const items = trips.map((t) => ({
      id: t.id,
      tripNo: t.tripNo,
      route: t.route,
      dateFrom: t.dateFrom,
      dateTo: t.dateTo,
      notes: t.notes,
      status: t.status,
      documentCount: t.documents.length,
      lineCount: t.lines.length,
    }));

    const suggestedNextTripNo = await suggestNextTripNo(prisma, id);

    return NextResponse.json({
      success: true,
      items,
      total: items.length,
      suggestedNextTripNo,
      capabilities: {
        canCreate: hasPermission(currentUser, "ownCarrier.create"),
        canEdit: hasPermission(currentUser, "ownCarrier.edit"),
        canBin: hasPermission(currentUser, "ownCarrier.bin"),
      },
    });
  } catch (error) {
    console.error("Get carrier trips error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Trips" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const carrier = await prisma.ownCarrier.findUnique({ where: { id }, select: { id: true, isDeleted: true } });
    if (!carrier || carrier.isDeleted) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    const body = await request.json();
    const tripNo = typeof body.tripNo === "string" ? body.tripNo.trim() : "";
    if (!tripNo) {
      return NextResponse.json({ success: false, message: "Trip No. is required" }, { status: 400 });
    }

    const dateFrom = body.dateFrom ? new Date(`${body.dateFrom}T00:00:00`) : null;
    if (!dateFrom || Number.isNaN(dateFrom.getTime())) {
      return NextResponse.json({ success: false, message: "Valid 'from' date is required" }, { status: 400 });
    }
    const dateTo = body.dateTo ? new Date(`${body.dateTo}T00:00:00`) : null;
    if (body.dateTo && (!dateTo || Number.isNaN(dateTo.getTime()))) {
      return NextResponse.json({ success: false, message: "Invalid 'to' date" }, { status: 400 });
    }

    try {
      const trip = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.carrierTrip.findFirst({
          where: { carrierId: id, tripNo, isDeleted: false },
          select: { id: true },
        });
        if (duplicate) {
          throw new Prisma.PrismaClientKnownRequestError("Duplicate trip no.", {
            code: "P2002",
            clientVersion: Prisma.prismaVersion.client,
          });
        }

        const created = await tx.carrierTrip.create({
          data: {
            carrierId: id,
            tripNo,
            route: body.route?.trim() || null,
            dateFrom,
            dateTo,
            notes: body.notes?.trim() || null,
            createdById: currentUser.userId,
          },
        });

        await auditCreate(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP",
          entityType: "CarrierTrip",
          entityId: created.id,
          documentNo: created.tripNo,
          description: `Created Trip ${created.tripNo} for carrier`,
          newValues: { tripNo: created.tripNo, route: created.route, dateFrom: created.dateFrom },
          ...requestContext(request),
        });

        return created;
      });

      return NextResponse.json(
        { success: true, message: "Trip created successfully.", trip: { id: trip.id, tripNo: trip.tripNo } },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ success: false, message: "This Trip No. already exists for this carrier" }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Create carrier trip error:", error);
    return NextResponse.json({ success: false, message: "Unable to create Trip" }, { status: 500 });
  }
}
