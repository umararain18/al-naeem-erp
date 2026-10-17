import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  CarrierSlipError,
  validateChallanLinkEligible,
  validateBiltyLinkEligible,
  computeSlipFinancials,
  computeDriverCashCarryForward,
} from "@/lib/carrier-slip";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

const collectionSchema = z.object({
  date: z.string().min(1),
  amount: z.number().positive(),
  collectedBy: z.enum(["DRIVER", "OFFICE"]),
  method: z.enum(["CASH", "BANK_ONLINE"]),
  note: z.string().optional().or(z.literal("")),
});

const expenseSchema = z
  .object({
    date: z.string().min(1),
    accountId: z.string().min(1),
    description: z.string().optional().or(z.literal("")),
    amount: z.number().positive(),
    paymentType: z.enum(["NAQAD", "KHATA", "OFFICE_PAID"]),
    vendorPartyId: z.string().optional().or(z.literal("")),
  })
  .refine((e) => e.paymentType !== "KHATA" || !!e.vendorPartyId, {
    message: "A Khata expense requires a vendor party.",
    path: ["vendorPartyId"],
  });

const updateSchema = z
  .object({
    slipNo: z.string().trim().min(1).optional(),
    departureDate: z.string().min(1).optional(),
    returnDate: z.string().optional().or(z.literal("")),
    route: z.string().optional().or(z.literal("")),
    driverName: z.string().optional().or(z.literal("")),
    driverPhone: z.string().optional().or(z.literal("")),
    status: z.enum(["IN_PROGRESS", "TRIP_COMPLETED", "RETURNED"]).optional(),
    linkedChallanId: z.string().optional().or(z.literal("")),
    linkedBiltyId: z.string().optional().or(z.literal("")),
    manualTotalBiltyRent: z.number().min(0).optional(),
    manualCarrierRent: z.number().min(0).optional(),
    notes: z.string().optional().or(z.literal("")),
    collections: z.array(collectionSchema).optional(),
    expenses: z.array(expenseSchema).optional(),
  })
  .refine((d) => !(d.linkedChallanId && d.linkedBiltyId), {
    message: "Link either a Challan or a Bilty, not both.",
    path: ["linkedBiltyId"],
  });

function errorStatus(code: string): number {
  switch (code) {
    case "CHALLAN_NOT_FOUND":
    case "BILTY_NOT_FOUND":
      return 404;
    case "CHALLAN_ALREADY_LINKED":
    case "BILTY_ALREADY_LINKED":
      return 409;
    default:
      return 400;
  }
}

// GET /api/carrier-slips/[id]
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
    const slip = await prisma.carrierSlip.findUnique({
      where: { id },
      include: {
        carrier: { select: { id: true, carrierNumber: true, driverName: true, driverPhone: true } },
        linkedChallan: { select: { id: true, challanNo: true } },
        linkedBilty: { select: { id: true, biltyNo: true } },
        collections: { orderBy: { date: "asc" } },
        expenses: { include: { account: { select: { id: true, accountName: true, category: true } }, vendorParty: { select: { id: true, partyName: true } } }, orderBy: { date: "asc" } },
      },
    });

    if (!slip || slip.isDeleted) {
      return NextResponse.json({ success: false, message: "Slip not found" }, { status: 404 });
    }

    const financials = await computeSlipFinancials(prisma, slip);
    const driverCash = await computeDriverCashCarryForward(prisma, slip.carrierId, slip.id);

    return NextResponse.json({
      success: true,
      slip,
      financials,
      driverCash,
      permissions: {
        canEdit: hasPermission(currentUser, "ownCarrier.edit"),
        canBin: hasPermission(currentUser, "ownCarrier.bin"),
      },
    });
  } catch (error) {
    console.error("Get carrier slip error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}

// PATCH /api/carrier-slips/[id]
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
        { success: false, message: "Invalid slip data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    const current = await prisma.carrierSlip.findUnique({ where: { id } });
    if (!current || current.isDeleted) {
      return NextResponse.json({ success: false, message: "Slip not found" }, { status: 404 });
    }

    const willLinkChallan = data.linkedChallanId !== undefined ? data.linkedChallanId || null : current.linkedChallanId;
    const willLinkBilty = data.linkedBiltyId !== undefined ? data.linkedBiltyId || null : current.linkedBiltyId;
    if (willLinkChallan && willLinkBilty) {
      return NextResponse.json({ success: false, message: "Link either a Challan or a Bilty, not both." }, { status: 400 });
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (data.linkedChallanId !== undefined && data.linkedChallanId) {
          await validateChallanLinkEligible(tx, data.linkedChallanId, id);
        }
        if (data.linkedBiltyId !== undefined && data.linkedBiltyId) {
          await validateBiltyLinkEligible(tx, data.linkedBiltyId, id);
        }

        const updateData: Prisma.CarrierSlipUncheckedUpdateInput = { updatedById: currentUser.userId };
        if (data.slipNo !== undefined) updateData.slipNo = data.slipNo;
        if (data.departureDate !== undefined) updateData.departureDate = new Date(data.departureDate);
        if (data.returnDate !== undefined) updateData.returnDate = data.returnDate ? new Date(data.returnDate) : null;
        if (data.route !== undefined) updateData.route = data.route || null;
        if (data.driverName !== undefined) updateData.driverName = data.driverName || null;
        if (data.driverPhone !== undefined) updateData.driverPhone = data.driverPhone || null;
        if (data.status !== undefined) updateData.status = data.status;
        if (data.notes !== undefined) updateData.notes = data.notes || null;
        if (data.linkedChallanId !== undefined) {
          updateData.linkedChallanId = data.linkedChallanId || null;
        }
        if (data.linkedBiltyId !== undefined) {
          updateData.linkedBiltyId = data.linkedBiltyId || null;
        }
        const noLinkAfterUpdate = !willLinkChallan && !willLinkBilty;
        if (noLinkAfterUpdate) {
          if (data.manualTotalBiltyRent !== undefined) updateData.manualTotalBiltyRent = data.manualTotalBiltyRent;
          if (data.manualCarrierRent !== undefined) updateData.manualCarrierRent = data.manualCarrierRent;
        } else {
          updateData.manualTotalBiltyRent = null;
          updateData.manualCarrierRent = null;
        }

        const updated = await tx.carrierSlip.update({ where: { id }, data: updateData });

        // Line items (Phase 1, plain operational rows - see
        // lib/carrier-slip.ts's own header comment) - replaced
        // wholesale on edit, same as every other document-with-lines
        // edit path in this app re-derives its own line set from the
        // submitted payload rather than diffing row-by-row.
        if (data.collections !== undefined) {
          await tx.carrierSlipCollection.deleteMany({ where: { slipId: id } });
          if (data.collections.length > 0) {
            await tx.carrierSlipCollection.createMany({
              data: data.collections.map((c) => ({ slipId: id, date: new Date(c.date), amount: c.amount, collectedBy: c.collectedBy, method: c.method, note: c.note || null })),
            });
          }
        }
        if (data.expenses !== undefined) {
          await tx.carrierSlipExpense.deleteMany({ where: { slipId: id } });
          if (data.expenses.length > 0) {
            await tx.carrierSlipExpense.createMany({
              data: data.expenses.map((e) => ({
                slipId: id,
                date: new Date(e.date),
                accountId: e.accountId,
                description: e.description || null,
                amount: e.amount,
                paymentType: e.paymentType,
                vendorPartyId: e.paymentType === "KHATA" ? e.vendorPartyId || null : null,
              })),
            });
          }
        }

        const changedFields = diffFields(current, updateData as Record<string, unknown>, Object.keys(updateData) as (keyof typeof current)[]);
        if (Object.keys(changedFields).length > 0 || data.collections !== undefined || data.expenses !== undefined) {
          await auditUpdate(tx, {
            actor: actorFromUser(currentUser),
            module: "OWN_CARRIER",
            entityType: "CarrierSlip",
            entityId: id,
            documentNo: `Slip ${updated.slipNo}`,
            description: `Updated Carrier Slip ${updated.slipNo}`,
            changedFields,
            ...requestContext(request),
          });
        }
      });
    } catch (txError) {
      if (txError instanceof CarrierSlipError) {
        return NextResponse.json({ success: false, code: txError.code, message: txError.message }, { status: errorStatus(txError.code) });
      }
      if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === "P2002") {
        return NextResponse.json({ success: false, message: "This slip number already exists for this carrier" }, { status: 409 });
      }
      throw txError;
    }

    return NextResponse.json({ success: true, message: "Slip updated successfully" });
  } catch (error) {
    console.error("Update carrier slip error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}

// DELETE /api/carrier-slips/[id] - Bin (soft delete)
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
    const current = await prisma.carrierSlip.findUnique({ where: { id } });
    if (!current || current.isDeleted) {
      return NextResponse.json({ success: false, message: "Slip not found" }, { status: 404 });
    }

    await prisma.$transaction(async (tx) => {
      await tx.carrierSlip.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "OWN_CARRIER",
        entityType: "CarrierSlip",
        entityId: id,
        documentNo: `Slip ${current.slipNo}`,
        description: `Moved Carrier Slip ${current.slipNo} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Slip moved to Bin successfully" });
  } catch (error) {
    console.error("Bin carrier slip error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
