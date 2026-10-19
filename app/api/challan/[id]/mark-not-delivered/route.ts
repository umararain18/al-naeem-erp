import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { auditUpdate, actorFromUser, requestContext } from "@/lib/audit-log";
import { assertSuperAdmin, biltyHasPhonchOrBillReference, ChallanLifecycleError } from "@/lib/challan-lifecycle";

// ============================================================
// POST /api/challan/[id]/mark-not-delivered - the inverse of
// app/api/challan/[id]/deliver/route.ts. DELIVERED -> IN_TRANSIT for
// the Challan and every one of its Bilties. No accounting impact:
// Booking Income was already recognized once, at dispatch (Challan
// creation/Bilty add) - delivery status never touches that, so
// un-delivering doesn't either. SUPER_ADMIN only.
// ============================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    try {
      assertSuperAdmin(currentUser);
    } catch (permError) {
      if (permError instanceof ChallanLifecycleError) {
        return NextResponse.json({ success: false, message: permError.message }, { status: 403 });
      }
      throw permError;
    }

    const { id } = await params;

    const challan = await prisma.challan.findUnique({
      where: { id },
      include: {
        bilties: {
          include: { bilty: { select: { id: true, biltyNo: true, status: true, isDeleted: true } } },
        },
      },
    });

    if (!challan || challan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    if (challan.status !== "DELIVERED") {
      return NextResponse.json(
        { success: false, message: "Only a Delivered challan can be marked as Not Delivered" },
        { status: 400 }
      );
    }

    if (challan.isSettled) {
      return NextResponse.json(
        { success: false, message: "Settled Challan ko modify nahi kar sakte - pehle Unsettle karein." },
        { status: 400 }
      );
    }

    for (const cb of challan.bilties) {
      if (cb.bilty.isDeleted) continue;
      if (await biltyHasPhonchOrBillReference(prisma, cb.bilty.biltyNo)) {
        return NextResponse.json(
          {
            success: false,
            message: `Cannot mark Challan ${challan.challanNo} as Not Delivered - Bilty ${cb.bilty.biltyNo} already has a Phonch/Bill recorded against it.`,
          },
          { status: 400 }
        );
      }
    }

    const updatedChallan = await prisma.$transaction(async (tx) => {
      const updated = await tx.challan.update({
        where: { id },
        data: {
          status: "IN_TRANSIT",
          updatedById: currentUser.userId,
        },
        include: {
          transporterParty: { select: { id: true, partyName: true } },
          bilties: {
            include: {
              bilty: {
                include: {
                  fromLocation: { select: { id: true, name: true } },
                  toLocation: { select: { id: true, name: true } },
                  consignorParty: { select: { id: true, partyName: true } },
                  consigneeParty: { select: { id: true, partyName: true } },
                  clearingAgentParty: { select: { id: true, partyName: true } },
                  agentParty: { select: { id: true, partyName: true } },
                },
              },
            },
            orderBy: { addedAt: "asc" },
          },
        },
      });

      for (const cb of challan.bilties) {
        if (cb.bilty.isDeleted) continue;
        if (cb.bilty.status === "DELIVERED") {
          await tx.bilty.update({
            where: { id: cb.biltyId },
            data: { status: "IN_TRANSIT" },
          });
        }
      }

      await auditUpdate(tx, {
        actor: actorFromUser(currentUser),
        module: "CHALLAN",
        entityType: "Challan",
        entityId: id,
        documentNo: updated.challanNo,
        description: `Marked Challan ${updated.challanNo} as Not Delivered (${challan.bilties.length} Bilty(s) reverted to In Transit)`,
        changedFields: { status: { old: "DELIVERED", new: "IN_TRANSIT" } },
        ...requestContext(request),
      });

      return updated;
    });

    return NextResponse.json({
      success: true,
      message: "Challan marked as Not Delivered successfully.",
      challan: updatedChallan,
    });
  } catch (error) {
    console.error("Mark challan as not delivered error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to mark challan as not delivered" },
      { status: 500 }
    );
  }
}
