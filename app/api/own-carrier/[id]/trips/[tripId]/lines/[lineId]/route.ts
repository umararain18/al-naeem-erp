import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { deleteCarrierTripLine, editCarrierTripLine, CarrierTripError } from "@/lib/carrier-trip";
import { auditDelete, auditUpdate, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

// PATCH - edits a line truly IN PLACE (lib/carrier-trip.ts's
// editCarrierTripLine): the SAME JournalEntry/JournalLine rows are
// updated, never a reversal + a brand new entry. The lineType itself
// cannot change this way (see that function's own doc comment) - the
// request body still carries every type-specific field (documentId,
// category, etc.) the SAME way POST .../lines does.
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
        const updated = await editCarrierTripLine(tx, {
          lineId,
          editedById: currentUser.userId,
          date,
          description,
          amount,
          rawInput: body,
        });

        const changedFields = diffFields(line, updated, ["date", "description", "amount", "category", "officeAccountId", "vendorPartyId", "employeeId", "isDiesel", "liters", "ratePerLiter", "pumpPartyId"]);
        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: updated.id,
          description: `Edited ${line.lineType} line on Trip (in place)${body.reason ? `: ${body.reason}` : ""}`,
          oldValues: Object.fromEntries(Object.entries(changedFields).map(([k, v]) => [k, v.old])),
          newValues: Object.fromEntries(Object.entries(changedFields).map(([k, v]) => [k, v.new])),
          changedFields,
          ...requestContext(request),
        });

        return updated;
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

// DELETE - soft-deletes into the SAME accounting Bin every other
// document-level write in this codebase uses (lib/carrier-trip.ts's
// deleteCarrierTripLine) - excluded from ledger/balances/P&L, visible
// and restorable from the central Bin.
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
        await deleteCarrierTripLine(tx, { lineId, deletedById: currentUser.userId, reason: body?.reason });

        await auditDelete(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: lineId,
          description: `Deleted ${line.lineType} line (Rs. ${Number(line.amount).toLocaleString()}) on Trip - moved to Bin${body?.reason ? `: ${body.reason}` : ""}`,
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Line deleted successfully." });
  } catch (error) {
    console.error("Delete carrier trip line error:", error);
    return NextResponse.json({ success: false, message: "Unable to delete line" }, { status: 500 });
  }
}
