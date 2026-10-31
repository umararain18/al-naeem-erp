import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { reverseCarrierTripLine, editCarrierTripLine, CarrierTripError } from "@/lib/carrier-trip";
import { auditDelete, auditUpdate, actorFromUser, requestContext } from "@/lib/audit-log";

// PATCH - "edits" a line from the UI's point of view, but is NEVER a
// mutation of the existing row under the hood: it reverses the
// existing line and posts a brand new one with the edited values
// (lib/carrier-trip.ts's editCarrierTripLine), in ONE transaction -
// same append-only discipline as every other correction in this
// schema. The lineType itself cannot change this way (see that
// function's own doc comment) - the request body still carries every
// type-specific field (documentId, expenseAccountId, etc.) the SAME
// way POST .../lines does, since they are simply re-applied to the
// freshly-posted line.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string; lineId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId, lineId } = await params;
    const line = await prisma.carrierTripLine.findUnique({ where: { id: lineId }, include: { trip: { select: { id: true, carrierId: true } } } });
    if (!line || line.trip.id !== tripId || line.trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Line not found" }, { status: 404 });
    }

    const body = await request.json();
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: "Amount must be greater than zero" }, { status: 400 });
    }
    const date = body.date ? new Date(`${body.date}T00:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }
    const description: string | null = body.description?.trim() || null;

    let newLine;
    try {
      newLine = await prisma.$transaction(async (tx) => {
        return editCarrierTripLine(tx, {
          lineId,
          deletedById: currentUser.userId,
          reason: body.reason || "edited",
          date,
          description,
          amount,
          rawInput: body,
        });
      });

      await prisma.$transaction(async (tx) => {
        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: newLine!.id,
          description: `Edited ${line.lineType} line (Rs. ${Number(line.amount).toLocaleString()} -> Rs. ${amount.toLocaleString()}) on Trip - replaces ${lineId}`,
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Line updated successfully.", line: { id: newLine.id } });
  } catch (error) {
    console.error("Edit carrier trip line error:", error);
    return NextResponse.json({ success: false, message: "Unable to update line" }, { status: 500 });
  }
}

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
