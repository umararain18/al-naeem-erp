import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getDriverCashBalance } from "@/lib/own-carrier";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

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
    if (id.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    const carrier = await prisma.ownCarrier.findUnique({
      where: { id },
      include: {
        driverCashAccount: { select: { id: true, accountName: true } },
        currentDriver: { select: { id: true, name: true, employeeCode: true } },
        deletedBy: { select: { id: true, fullName: true, username: true } },
        trips: {
          where: { isDeleted: false },
          orderBy: [{ dateFrom: "desc" }, { createdAt: "desc" }],
          include: {
            documents: { where: { unlinkedAt: null }, select: { id: true } },
            lines: { where: { isDeleted: false }, select: { id: true } },
          },
        },
      },
    });

    if (!carrier) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    if (carrier.isDeleted) {
      return NextResponse.json({
        success: true,
        carrier,
        driverCashBalance: 0,
        capabilities: { canRestore: hasPermission(currentUser, "ownCarrier.restore"), canEdit: false, canBin: false },
      });
    }

    const driverCashBalance = carrier.driverCashAccount
      ? await getDriverCashBalance(prisma, carrier.driverCashAccount.id)
      : 0;

    const trips = carrier.trips.map((t) => ({
      id: t.id,
      tripNo: t.tripNo,
      route: t.route,
      dateFrom: t.dateFrom,
      dateTo: t.dateTo,
      status: t.status,
      documentCount: t.documents.length,
      lineCount: t.lines.length,
    }));

    return NextResponse.json({
      success: true,
      carrier: { ...carrier, trips: undefined },
      trips,
      driverCashBalance,
      capabilities: {
        canEdit: hasPermission(currentUser, "ownCarrier.edit"),
        canBin: hasPermission(currentUser, "ownCarrier.bin"),
        canRestore: false,
      },
    });
  } catch (error) {
    console.error("Get own carrier error:", error);
    return NextResponse.json({ success: false, message: "Unable to load Own Carrier" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    if (id.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    const existing = await prisma.ownCarrier.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }
    if (existing.isDeleted) {
      return NextResponse.json({ success: false, message: "Binned Own Carrier cannot be edited. Restore it first." }, { status: 400 });
    }

    const body = await request.json();
    const updateData: Prisma.OwnCarrierUncheckedUpdateInput = { updatedById: currentUser.userId };

    if (body.carrierNumber !== undefined) {
      const trimmed = typeof body.carrierNumber === "string" ? body.carrierNumber.trim() : "";
      if (!trimmed) {
        return NextResponse.json({ success: false, message: "Carrier number is required" }, { status: 400 });
      }
      if (trimmed !== existing.carrierNumber) {
        const duplicate = await prisma.ownCarrier.findFirst({
          where: { carrierNumber: trimmed, isDeleted: false, id: { not: id } },
        });
        if (duplicate) {
          return NextResponse.json({ success: false, message: "This carrier number already exists" }, { status: 409 });
        }
      }
      updateData.carrierNumber = trimmed;
    }

    if (body.driverName !== undefined) updateData.driverName = body.driverName?.trim() || null;
    if (body.driverPhone !== undefined) updateData.driverPhone = body.driverPhone?.trim() || null;
    if (body.notes !== undefined) updateData.notes = body.notes?.trim() || null;
    if (body.isActive !== undefined) updateData.isActive = !!body.isActive;

    if (body.currentDriverId !== undefined) {
      if (body.currentDriverId) {
        const employee = await prisma.employee.findUnique({ where: { id: body.currentDriverId }, select: { isDeleted: true } });
        if (!employee || employee.isDeleted) {
          return NextResponse.json({ success: false, message: "Selected driver was not found" }, { status: 400 });
        }
      }
      updateData.currentDriverId = body.currentDriverId || null;
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const updatedCarrier = await tx.ownCarrier.update({ where: { id }, data: updateData });

        const changedFields = diffFields(
          existing as unknown as Record<string, unknown>,
          updateData as Record<string, unknown>,
          Object.keys(updateData).filter((k) => k !== "updatedById") as (keyof typeof existing)[]
        );
        if (Object.keys(changedFields).length > 0) {
          const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
          await auditUpdate(tx, {
            actor: actorFromUser(currentUser),
            module: "OWN_CARRIER",
            entityType: "OwnCarrier",
            entityId: id,
            documentNo: updatedCarrier.carrierNumber,
            description: `Updated Own Carrier ${updatedCarrier.carrierNumber}: ${summary}`,
            changedFields,
            ...requestContext(request),
          });
        }

        return updatedCarrier;
      });

      return NextResponse.json({ success: true, message: "Own Carrier updated successfully.", carrier: updated });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ success: false, message: "This carrier number already exists" }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    console.error("Update own carrier error:", error);
    return NextResponse.json({ success: false, message: "Unable to update Own Carrier" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    if (id.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation === "DELETE") {
      if (!hasPermission(currentUser, "ownCarrier.permanentlyDelete")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      const existing = await prisma.ownCarrier.findUnique({
        where: { id },
        select: { id: true, isDeleted: true, carrierNumber: true, trips: { select: { id: true } } },
      });
      if (!existing) {
        return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
      }
      if (!existing.isDeleted) {
        return NextResponse.json({ success: false, message: "Only binned Own Carriers can be permanently deleted" }, { status: 400 });
      }
      if (existing.trips.length > 0) {
        return NextResponse.json(
          { success: false, message: "This carrier has Trip history and cannot be permanently deleted." },
          { status: 400 }
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.ownCarrier.delete({ where: { id } });
        await auditDelete(tx, {
          actor: actorFromUser(currentUser),
          module: "OWN_CARRIER",
          entityType: "OwnCarrier",
          entityId: id,
          documentNo: existing.carrierNumber,
          description: `Permanently deleted Own Carrier ${existing.carrierNumber}`,
          ...requestContext(request),
        });
      });

      return NextResponse.json({ success: true, message: "Own Carrier permanently deleted.", carrierId: id });
    }

    if (!hasPermission(currentUser, "ownCarrier.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const carrier = await prisma.ownCarrier.findUnique({
      where: { id },
      include: { trips: { where: { isDeleted: false }, select: { id: true } } },
    });
    if (!carrier) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }
    if (carrier.isDeleted) {
      return NextResponse.json({ success: false, message: "This Own Carrier is already in Bin." }, { status: 400 });
    }
    if (carrier.trips.length > 0) {
      return NextResponse.json(
        { success: false, message: "This carrier still has active Trips - move them to Bin first." },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.ownCarrier.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "OWN_CARRIER",
        entityType: "OwnCarrier",
        entityId: id,
        documentNo: carrier.carrierNumber,
        description: `Moved Own Carrier ${carrier.carrierNumber} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Own Carrier moved to Bin successfully." });
  } catch (error) {
    console.error("Bin own carrier error:", error);
    return NextResponse.json({ success: false, message: "Unable to move Own Carrier to Bin" }, { status: 500 });
  }
}
