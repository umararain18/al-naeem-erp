import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";
import { assertSuperAdmin, ChallanLifecycleError } from "@/lib/challan-lifecycle";
import { recognizeBiltyBookingIncome, BiltyRevenueRecognitionError } from "@/lib/bilty-revenue-recognition";

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

    const currentChallan = await prisma.challan.findUnique({
      where: { id },
      select: { id: true, isDeleted: true, challanNo: true, status: true },
    });

    if (!currentChallan) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    if (!currentChallan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Only binned challans can be restored" },
        { status: 400 }
      );
    }

    // Block if another ACTIVE Challan has since taken this exact
    // Challan No. (possible once a binned Challan's number becomes
    // reusable - see the partial unique index migration).
    const numberConflict = await prisma.challan.findFirst({
      where: { challanNo: currentChallan.challanNo, isDeleted: false, id: { not: id } },
      select: { id: true, challanNo: true },
    });
    if (numberConflict) {
      return NextResponse.json(
        {
          success: false,
          message: `Challan No. ${currentChallan.challanNo} ab kisi aur active Challan ka hai — restore nahi ho sakta.`,
        },
        { status: 409 }
      );
    }

    // Block if ANY Bilty that was on this Challan has since been
    // picked up by a DIFFERENT active Challan (possible once this
    // Challan was Bin'd - see DELETE handler, which frees its
    // Bilties for re-assignment).
    const linkedBilties = await prisma.challanBilty.findMany({
      where: { challanId: id },
      include: { bilty: { select: { id: true, biltyNo: true, status: true, total: true, isDeleted: true } } },
    });

    for (const link of linkedBilties) {
      const otherActiveLink = await prisma.challanBilty.findFirst({
        where: {
          biltyId: link.biltyId,
          challanId: { not: id },
          challan: { isDeleted: false, status: { not: "CANCELLED" } },
        },
        include: { challan: { select: { challanNo: true } } },
      });

      if (otherActiveLink) {
        return NextResponse.json(
          {
            success: false,
            message: `Bilty ${link.bilty.biltyNo} ab Challan ${otherActiveLink.challan.challanNo} me hai — restore nahi ho sakta.`,
          },
          { status: 409 }
        );
      }
    }

    // Restored status comes from the Challan's own `status` field
    // (never touched by DELETE/Bin) - IN_TRANSIT or DELIVERED.
    const restoredBiltyStatus = currentChallan.status === "DELIVERED" ? "DELIVERED" : "IN_TRANSIT";
    const biltyStatusChanges: { biltyNo: string; oldStatus: string }[] = [];

    try {
      const challan = await prisma.$transaction(async (tx) => {
        // Restore the SAME document-owned accounting Binned alongside
        // this Challan (see the DELETE handler's own comment in
        // app/api/challan/[id]/route.ts) - CHALLAN_DISPATCH and
        // CHALLAN_DISPATCH_CORRECTION are never soft-deleted by anything
        // other than this Challan being Bin'd.
        await tx.journalEntry.updateMany({
          where: {
            referenceType: { in: ["CHALLAN_DISPATCH", "CHALLAN_DISPATCH_CORRECTION"] },
            referenceId: id,
            isDeleted: true,
          },
          data: {
            isDeleted: false,
            deletedAt: null,
            deletedById: null,
          },
        });

        for (const link of linkedBilties) {
          if (link.bilty.isDeleted) continue;

          await recognizeBiltyBookingIncome(tx, link.bilty, {
            entryDate: new Date(),
            challanNo: currentChallan.challanNo,
            createdById: currentUser.userId,
          });

          if (link.bilty.status !== restoredBiltyStatus) {
            biltyStatusChanges.push({ biltyNo: link.bilty.biltyNo, oldStatus: link.bilty.status });
            await tx.bilty.update({
              where: { id: link.bilty.id },
              data: { status: restoredBiltyStatus },
            });
          }
        }

        const restored = await tx.challan.update({
          where: { id },
          data: {
            isDeleted: false,
            deletedAt: null,
            deletedById: null,
          },
        });

        const biltySummary = biltyStatusChanges.map((c) => `Bilty ${c.biltyNo}: ${c.oldStatus} -> ${restoredBiltyStatus}`).join("; ");

        await auditRestore(tx, {
          actor: actorFromUser(currentUser),
          module: "CHALLAN",
          entityType: "Challan",
          entityId: id,
          documentNo: currentChallan.challanNo,
          description: `Restored Challan ${currentChallan.challanNo} from Bin${biltySummary ? ` (${biltySummary})` : ""}`,
          changedFields: biltyStatusChanges.length > 0 ? { bilties: { old: biltyStatusChanges.map((c) => ({ biltyNo: c.biltyNo, status: c.oldStatus })), new: biltyStatusChanges.map((c) => ({ biltyNo: c.biltyNo, status: restoredBiltyStatus })) } } : null,
          ...requestContext(request),
        });

        return restored;
      });

      return NextResponse.json({
        success: true,
        message: "Challan restored successfully.",
        challanId: challan.id,
      });
    } catch (txError) {
      if (txError instanceof BiltyRevenueRecognitionError) {
        return NextResponse.json({ success: false, message: txError.message }, { status: 400 });
      }
      throw txError;
    }
  } catch (error) {
    console.error("Restore challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to restore challan" },
      { status: 500 }
    );
  }
}
