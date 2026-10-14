import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { computeSlipFinancials, computeDriverCashCarryForward } from "@/lib/carrier-slip";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

const updateSchema = z.object({
  driverName: z.string().optional().or(z.literal("")),
  driverPhone: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});

// GET /api/own-carriers/[id] - carrier folder summary + its slip list
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const carrier = await prisma.ownCarrier.findUnique({
      where: { id },
      include: { driverCashAccount: { select: { id: true, accountName: true } } },
    });
    if (!carrier || carrier.isDeleted) {
      return NextResponse.json({ success: false, message: "Carrier not found" }, { status: 404 });
    }

    const slips = await prisma.carrierSlip.findMany({
      where: { carrierId: id, isDeleted: false },
      include: { linkedChallan: { select: { id: true, challanNo: true } }, linkedBilty: { select: { id: true, biltyNo: true } } },
      orderBy: [{ departureDate: "desc" }, { createdAt: "desc" }],
    });

    let totalCarrierRent = 0;
    let totalExpenses = 0;
    let totalProfit = 0;
    const slipSummaries = [];
    for (const slip of slips) {
      const financials = await computeSlipFinancials(prisma, slip);
      totalCarrierRent += financials.carrierRent;
      totalExpenses += financials.totalExpenses;
      totalProfit += financials.carrierProfit;
      slipSummaries.push({ ...slip, financials });
    }

    const latestSlip = slips[0];
    const driverCash = latestSlip ? await computeDriverCashCarryForward(prisma, id, latestSlip.id) : null;

    return NextResponse.json({
      success: true,
      carrier,
      slips: slipSummaries,
      summary: {
        slipCount: slips.length,
        totalCarrierRent,
        totalExpenses,
        totalProfit,
        remainingDriverCash: driverCash?.closingCash ?? 0,
      },
      permissions: {
        canEdit: hasPermission(currentUser, "ownCarrier.edit"),
        canBin: hasPermission(currentUser, "ownCarrier.bin"),
        canCreateSlip: hasPermission(currentUser, "ownCarrier.create"),
      },
    });
  } catch (error) {
    console.error("Get own carrier error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}

// PATCH /api/own-carriers/[id]
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid carrier data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    const current = await prisma.ownCarrier.findUnique({ where: { id } });
    if (!current || current.isDeleted) {
      return NextResponse.json({ success: false, message: "Carrier not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updatedById: currentUser.userId };
    if (data.driverName !== undefined) updateData.driverName = data.driverName || null;
    if (data.driverPhone !== undefined) updateData.driverPhone = data.driverPhone || null;
    if (data.notes !== undefined) updateData.notes = data.notes || null;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    await prisma.$transaction(async (tx) => {
      const updated = await tx.ownCarrier.update({ where: { id }, data: updateData });

      const changedFields = diffFields(current, updateData, ["driverName", "driverPhone", "notes", "isActive"]);
      if (Object.keys(changedFields).length > 0) {
        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "OWN_CARRIER",
          entityType: "OwnCarrier",
          entityId: id,
          documentNo: updated.carrierNumber,
          description: `Updated Own Carrier ${updated.carrierNumber}`,
          changedFields,
          ...requestContext(request),
        });
      }
    });

    return NextResponse.json({ success: true, message: "Carrier updated successfully" });
  } catch (error) {
    console.error("Update own carrier error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}

// DELETE /api/own-carriers/[id] - Bin (soft delete). Blocked while any
// non-deleted slip still references this carrier - never orphans a
// slip under a binned carrier (mirrors how Challan deletion is
// blocked by its own linked-Bilty safeguards elsewhere in this app).
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.bin")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const current = await prisma.ownCarrier.findUnique({ where: { id } });
    if (!current || current.isDeleted) {
      return NextResponse.json({ success: false, message: "Carrier not found" }, { status: 404 });
    }

    const activeSlipCount = await prisma.carrierSlip.count({ where: { carrierId: id, isDeleted: false } });
    if (activeSlipCount > 0) {
      return NextResponse.json(
        { success: false, message: `Cannot bin this carrier - it still has ${activeSlipCount} active slip(s). Bin those first.` },
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
        documentNo: current.carrierNumber,
        description: `Moved Own Carrier ${current.carrierNumber} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Carrier moved to Bin successfully" });
  } catch (error) {
    console.error("Bin own carrier error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
