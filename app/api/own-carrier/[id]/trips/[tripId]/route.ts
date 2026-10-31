import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getTripCashBook, closeCarrierTrip, reopenCarrierTrip, getDocumentOutstandingAmount, CarrierTripError } from "@/lib/carrier-trip";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

async function loadDocumentLabels(
  documents: { id: string; documentType: string; documentId: string; linkedAt: Date; carrierRentAmount: Prisma.Decimal }[]
) {
  return Promise.all(
    documents.map(async (doc) => {
      let label = `${doc.documentType} ${doc.documentId}`;
      let isOwnCarrierChallan = false;
      if (doc.documentType === "CHALLAN") {
        const d = await prisma.challan.findUnique({ where: { id: doc.documentId }, select: { challanNo: true, ownCarrierId: true } });
        if (d) {
          label = `Challan ${d.challanNo}`;
          isOwnCarrierChallan = Boolean(d.ownCarrierId);
        }
      } else if (doc.documentType === "PHONCH") {
        const d = await prisma.phonch.findUnique({ where: { id: doc.documentId }, select: { phonchNo: true } });
        if (d) label = `Phonch ${d.phonchNo}`;
      } else if (doc.documentType === "PRIVATE_PHONCH") {
        const d = await prisma.privatePhonch.findUnique({ where: { id: doc.documentId }, select: { phonchNo: true } });
        if (d) label = `Private Phonch ${d.phonchNo}`;
      }
      // Pure prefill convenience for the Cash Book quick-entry row's
      // Collection item - see getDocumentOutstandingAmount's own doc
      // comment for exactly what this is (and is not).
      const outstanding = await getDocumentOutstandingAmount(prisma, doc.documentType as "CHALLAN" | "PHONCH" | "PRIVATE_PHONCH", doc.documentId);

      return {
        id: doc.id,
        documentType: doc.documentType,
        documentId: doc.documentId,
        linkedAt: doc.linkedAt,
        label,
        carrierRentAmount: Number(doc.carrierRentAmount),
        isOwnCarrierChallan,
        outstanding,
      };
    })
  );
}

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

    const trip = await prisma.carrierTrip.findUnique({
      where: { id: tripId },
      include: {
        carrier: { select: { id: true, carrierNumber: true, driverName: true } },
        documents: { where: { unlinkedAt: null }, orderBy: { linkedAt: "asc" } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
      },
    });

    if (!trip || trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }

    if (trip.isDeleted) {
      return NextResponse.json({
        success: true,
        trip,
        documents: [],
        cashBook: null,
        capabilities: { canRestore: hasPermission(currentUser, "ownCarrier.restore"), canEdit: false, canBin: false },
      });
    }

    const [documents, cashBook] = await Promise.all([
      loadDocumentLabels(trip.documents),
      getTripCashBook(prisma, tripId),
    ]);

    return NextResponse.json({
      success: true,
      trip: { ...trip, documents: undefined },
      documents,
      cashBook,
      capabilities: {
        canEdit: hasPermission(currentUser, "ownCarrier.edit") && trip.status === "OPEN",
        canBin: hasPermission(currentUser, "ownCarrier.bin"),
        canRestore: false,
      },
    });
  } catch (error) {
    if (error instanceof CarrierTripError) {
      return NextResponse.json({ success: false, message: error.message }, { status: 400 });
    }
    console.error("Get carrier trip error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Trip" }, { status: 500 });
  }
}

export async function PATCH(
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
    const existing = await prisma.carrierTrip.findUnique({ where: { id: tripId } });
    if (!existing || existing.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }
    if (existing.isDeleted) {
      return NextResponse.json({ success: false, message: "Binned Trip cannot be edited. Restore it first." }, { status: 400 });
    }

    const body = await request.json();
    const updateData: Prisma.CarrierTripUncheckedUpdateInput = { updatedById: currentUser.userId };

    if (body.tripNo !== undefined) {
      const trimmed = typeof body.tripNo === "string" ? body.tripNo.trim() : "";
      if (!trimmed) {
        return NextResponse.json({ success: false, message: "Trip No. is required" }, { status: 400 });
      }
      if (trimmed !== existing.tripNo) {
        const duplicate = await prisma.carrierTrip.findFirst({
          where: { carrierId: id, tripNo: trimmed, isDeleted: false, id: { not: tripId } },
        });
        if (duplicate) {
          return NextResponse.json({ success: false, message: "This Trip No. already exists for this carrier" }, { status: 409 });
        }
      }
      updateData.tripNo = trimmed;
    }

    if (body.route !== undefined) updateData.route = body.route?.trim() || null;
    if (body.notes !== undefined) updateData.notes = body.notes?.trim() || null;
    if (body.dateFrom !== undefined) {
      const dateFrom = new Date(`${body.dateFrom}T00:00:00`);
      if (Number.isNaN(dateFrom.getTime())) {
        return NextResponse.json({ success: false, message: "Invalid 'from' date" }, { status: 400 });
      }
      updateData.dateFrom = dateFrom;
    }
    if (body.dateTo !== undefined) {
      if (!body.dateTo) {
        updateData.dateTo = null;
      } else {
        const dateTo = new Date(`${body.dateTo}T00:00:00`);
        if (Number.isNaN(dateTo.getTime())) {
          return NextResponse.json({ success: false, message: "Invalid 'to' date" }, { status: 400 });
        }
        updateData.dateTo = dateTo;
      }
    }
    // STATUS (Close/Reopen) is handled separately via the dedicated
    // closeCarrierTrip/reopenCarrierTrip orchestration below - NOT a
    // plain column write - since Close recognizes (and Reopen
    // reverses) every linked own-carrier Challan's income (see
    // lib/carrier-trip.ts's own module comment). A same-value submit
    // (body.status === existing.status) is treated as "not changing
    // status at all", never re-running Close/Reopen's own side
    // effects idempotently-but-pointlessly.
    let targetStatus: "OPEN" | "CLOSED" | undefined;
    if (body.status !== undefined) {
      if (body.status !== "OPEN" && body.status !== "CLOSED") {
        return NextResponse.json({ success: false, message: "Invalid status" }, { status: 400 });
      }
      if (body.status !== existing.status) targetStatus = body.status;
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (Object.keys(updateData).length > 1) {
          await tx.carrierTrip.update({ where: { id: tripId }, data: updateData });
        }

        let updatedTrip = await tx.carrierTrip.findUniqueOrThrow({ where: { id: tripId } });

        if (targetStatus === "CLOSED") {
          updatedTrip = await closeCarrierTrip(tx, { tripId, updatedById: currentUser.userId });
        } else if (targetStatus === "OPEN") {
          updatedTrip = await reopenCarrierTrip(tx, { tripId, updatedById: currentUser.userId, reason: body.reason });
        }

        const changedFields = diffFields(
          existing as unknown as Record<string, unknown>,
          { ...updateData, ...(targetStatus ? { status: targetStatus, dateTo: updatedTrip.dateTo } : {}) } as Record<string, unknown>,
          [...Object.keys(updateData).filter((k) => k !== "updatedById"), ...(targetStatus ? ["status", "dateTo"] : [])] as (keyof typeof existing)[]
        );
        if (Object.keys(changedFields).length > 0) {
          const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
          await auditUpdate(tx, {
            actor: actorFromUser(currentUser),
            module: "CARRIER_TRIP",
            entityType: "CarrierTrip",
            entityId: tripId,
            documentNo: updatedTrip.tripNo,
            description: `Updated Trip ${updatedTrip.tripNo}: ${summary}`,
            changedFields,
            ...requestContext(request),
          });
        }

        return updatedTrip;
      });

      return NextResponse.json({ success: true, message: "Trip updated successfully.", trip: updated });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ success: false, message: "This Trip No. already exists for this carrier" }, { status: 409 });
      }
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, message: error.message }, { status: 400 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Update carrier trip error:", error);
    return NextResponse.json({ success: false, message: "Unable to update Trip" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { id, tripId } = await params;
    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "ownCarrier.permanentlyDelete")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const existing = await prisma.carrierTrip.findUnique({
        where: { id: tripId },
        select: {
          id: true,
          carrierId: true,
          isDeleted: true,
          tripNo: true,
          lines: { select: { id: true } },
          documents: { select: { id: true } },
        },
      });
      if (!existing || existing.carrierId !== id) {
        return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
      }
      if (!existing.isDeleted) {
        return NextResponse.json({ success: false, message: "Only binned Trips can be permanently deleted" }, { status: 400 });
      }
      if (existing.lines.length > 0 || existing.documents.length > 0) {
        return NextResponse.json(
          { success: false, message: "This Trip has line/document history and cannot be permanently deleted." },
          { status: 400 }
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.carrierTrip.delete({ where: { id: tripId } });
        await auditDelete(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP",
          entityType: "CarrierTrip",
          entityId: tripId,
          documentNo: existing.tripNo,
          description: `Permanently deleted Trip ${existing.tripNo}`,
          ...requestContext(request),
        });
      });

      return NextResponse.json({ success: true, message: "Trip permanently deleted.", tripId });
    }

    if (!hasPermission(currentUser, "ownCarrier.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const trip = await prisma.carrierTrip.findUnique({
      where: { id: tripId },
      include: {
        lines: { where: { isDeleted: false }, select: { id: true } },
        documents: { where: { unlinkedAt: null }, select: { id: true } },
      },
    });
    if (!trip || trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }
    if (trip.isDeleted) {
      return NextResponse.json({ success: false, message: "This Trip is already in Bin." }, { status: 400 });
    }
    if (trip.lines.length > 0) {
      return NextResponse.json(
        { success: false, message: "This Trip still has active lines - reverse them first." },
        { status: 400 }
      );
    }
    if (trip.documents.length > 0) {
      return NextResponse.json(
        { success: false, message: "This Trip still has linked documents - unlink them first." },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.carrierTrip.update({
        where: { id: tripId },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "CARRIER_TRIP",
        entityType: "CarrierTrip",
        entityId: tripId,
        documentNo: trip.tripNo,
        description: `Moved Trip ${trip.tripNo} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Trip moved to Bin successfully." });
  } catch (error) {
    console.error("Bin carrier trip error:", error);
    return NextResponse.json({ success: false, message: "Unable to move Trip to Bin" }, { status: 500 });
  }
}
