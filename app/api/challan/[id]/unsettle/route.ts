import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { auditUpdate, actorFromUser, requestContext } from "@/lib/audit-log";
import { assertSuperAdmin, ChallanLifecycleError, reverseChallanSettlementEntries } from "@/lib/challan-lifecycle";
import { getAllocatedAmountForDocument } from "@/lib/payment-allocation";

// ============================================================
// POST /api/challan/[id]/unsettle - EXACTLY reverses whatever
// app/api/challan/[id]/finalize-settlement/route.ts (and any
// /settlement-payments activity recorded afterward, while settled)
// wrote, via new, append-only REVERSING JournalEntries - the
// original SETTLEMENT/SETTLEMENT_PAYMENT/etc. entries are never
// edited or soft-deleted (see lib/challan-lifecycle.ts's
// reverseChallanSettlementEntries). Challan flips SETTLED ->
// DELIVERED (isSettled=false) so it can be settled again later.
// Every COLLECTION/CARRIER_RENT SettlementPayment row for this
// Challan is also soft-deactivated (isActive: false) in the SAME
// transaction - their row history (amount, payer, journalEntryId)
// is never deleted or edited, only excluded from "current" reads
// (Financial Summary, Challan position, the Rent-reduction active-
// total guard) going forward. A later re-settle starts clean and
// establishes fresh rows.
//
// Daily-Posting "verified/allocated" block (point 6 of the spec):
// investigated rather than guessed - COLLECTION/CARRIER_RENT
// SettlementPayment rows (the "driver/agent collection" payments this
// action actually touches) have no Daily-Posting-verification concept
// anywhere in this codebase (that concept, lib/bilty-paid-
// verification.ts's getBiltyPaidVerification, exists only for the
// unrelated, Challan/Settlement-INDEPENDENT "PAID" component, which
// Unsettle never touches). What DOES tie a Daily Posting receipt to
// this Challan's settled position is lib/payment-allocation.ts's
// PaymentAllocation table (a Daily Posting Cash/Bank <-> Party
// receipt allocated against this Challan's or one of its Bilties'
// outstanding balance) - Unsettling would reverse that outstanding
// balance out from under an allocation that still points at it, and
// this codebase defines no behavior for that case, so it is blocked
// outright with a clear message instead of guessed.
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
    const body = await request.json().catch(() => ({}));

    if (body?.confirmation !== "UNSETTLE") {
      return NextResponse.json(
        { success: false, message: "Confirmation required to Unsettle this Challan." },
        { status: 400 }
      );
    }

    const challan = await prisma.challan.findUnique({
      where: { id },
      select: { id: true, isDeleted: true, isSettled: true, challanNo: true },
    });

    if (!challan || challan.isDeleted) {
      return NextResponse.json(
        { success: false, message: "Challan not found" },
        { status: 404 }
      );
    }

    if (!challan.isSettled) {
      return NextResponse.json(
        { success: false, message: "This Challan has not been settled." },
        { status: 400 }
      );
    }

    const biltyLinks = await prisma.challanBilty.findMany({
      where: { challanId: id },
      select: { biltyId: true, bilty: { select: { biltyNo: true } } },
    });

    const challanAllocated = await getAllocatedAmountForDocument(prisma, "CHALLAN", id);
    if (challanAllocated > 0.009) {
      return NextResponse.json(
        {
          success: false,
          message: `Cannot Unsettle Challan ${challan.challanNo} - a Daily Posting receipt (Rs. ${challanAllocated}) is already allocated against it. Remove/reverse that allocation first.`,
        },
        { status: 400 }
      );
    }

    for (const link of biltyLinks) {
      const biltyAllocated = await getAllocatedAmountForDocument(prisma, "BILTY", link.biltyId);
      if (biltyAllocated > 0.009) {
        return NextResponse.json(
          {
            success: false,
            message: `Cannot Unsettle Challan ${challan.challanNo} - Bilty ${link.bilty.biltyNo} already has a Daily Posting receipt (Rs. ${biltyAllocated}) allocated against it. Remove/reverse that allocation first.`,
          },
          { status: 400 }
        );
      }
    }

    let reversedCount = 0;
    let deactivatedPaymentRowCount = 0;

    // SERIALIZABLE - same precedent as lib/settlement-payments.ts's
    // own writes - so two concurrent Unsettle calls on this same
    // Challan can never both read "not yet reversed" for the same
    // entry before either posts; one is forced to retry against the
    // other's committed result. Belt-and-suspenders alongside
    // reverseChallanSettlementEntries' own per-entry existence check.
    await prisma.$transaction(
      async (tx) => {
        const result = await reverseChallanSettlementEntries(tx, {
          challanId: id,
          challanNo: challan.challanNo,
          createdById: currentUser.userId,
          reason: "Unsettle",
        });
        reversedCount = result.reversedCount;
        deactivatedPaymentRowCount = result.deactivatedPaymentRowCount;

        await tx.challan.update({
          where: { id },
          data: {
            isSettled: false,
            settledAt: null,
            settledById: null,
            settlementJournalEntryId: null,
            outstandingReceivable: 0,
            outstandingPayable: 0,
          },
        });

        await auditUpdate(tx, {
          actor: actorFromUser(currentUser),
          module: "CHALLAN",
          entityType: "Challan",
          entityId: id,
          documentNo: challan.challanNo,
          description: `Unsettled Challan ${challan.challanNo} - ${result.reversedCount} settlement JournalEntry(ies) reversed, ${result.deactivatedPaymentRowCount} settlement payment row(s) deactivated`,
          changedFields: { isSettled: { old: true, new: false } },
          ...requestContext(request),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return NextResponse.json({
      success: true,
      message: `Challan unsettled successfully (${reversedCount} settlement entry(ies) reversed, ${deactivatedPaymentRowCount} settlement payment row(s) deactivated).`,
      challanId: id,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { success: false, message: "This Challan was modified concurrently. Please retry." },
        { status: 409 }
      );
    }
    console.error("Unsettle challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to unsettle challan" },
      { status: 500 }
    );
  }
}
