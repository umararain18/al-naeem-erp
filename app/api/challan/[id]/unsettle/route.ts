import { NextRequest, NextResponse } from "next/server";
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
// SettlementPayment rows themselves are left completely untouched -
// their history stays exactly as it was; only their accounting EFFECT
// is reversed.
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

    await prisma.$transaction(async (tx) => {
      const result = await reverseChallanSettlementEntries(tx, {
        challanId: id,
        challanNo: challan.challanNo,
        createdById: currentUser.userId,
        reason: "Unsettle",
      });
      reversedCount = result.reversedCount;

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
        description: `Unsettled Challan ${challan.challanNo} - ${result.reversedCount} settlement JournalEntry(ies) reversed`,
        changedFields: { isSettled: { old: true, new: false } },
        ...requestContext(request),
      });
    });

    return NextResponse.json({
      success: true,
      message: `Challan unsettled successfully (${reversedCount} settlement entry(ies) reversed).`,
      challanId: id,
    });
  } catch (error) {
    console.error("Unsettle challan error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to unsettle challan" },
      { status: 500 }
    );
  }
}
