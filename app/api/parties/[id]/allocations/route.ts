import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  AllocationError,
  assertPaymentBelongsToParty,
  autoAllocateOldestFirst,
  createAllocations,
  getAllocatedAmountForPayment,
  getAllocationStatusForPayment,
  getPaymentLine,
  getUnallocatedAmountForPayment,
  isEligibleForAllocation,
} from "@/lib/payment-allocation";

function errorStatus(code: string): number {
  switch (code) {
    case "PAYMENT_NOT_FOUND":
    case "DOCUMENT_NOT_FOUND":
      return 404;
    case "PARTY_MISMATCH":
      return 403;
    case "CONCURRENT_ALLOCATION":
      return 409;
    default:
      return 400;
  }
}

// GET /api/parties/[id]/allocations?journalLineId=X
// Reads the current allocation state of one payment belonging to
// this Party - purely read-only, never recalculates accounting.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "parties.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id: partyId } = await params;
    const journalLineId = request.nextUrl.searchParams.get("journalLineId");

    if (!journalLineId) {
      return NextResponse.json({ success: false, message: "journalLineId is required" }, { status: 400 });
    }

    const payment = await assertPaymentBelongsToParty(prisma, journalLineId, partyId);
    const allocated = await getAllocatedAmountForPayment(prisma, journalLineId);
    const unallocated = await getUnallocatedAmountForPayment(prisma, journalLineId);
    const status = await getAllocationStatusForPayment(prisma, journalLineId);

    const rows = await prisma.paymentAllocation.findMany({
      where: { journalLineId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        targetSourceType: true,
        targetSourceId: true,
        allocatedAmount: true,
        createdAt: true,
        createdById: true,
      },
    });

    return NextResponse.json({
      success: true,
      payment: {
        journalLineId: payment.journalLineId,
        amount: payment.amount,
        direction: payment.direction,
        entryDate: payment.entryDate,
        eligibleForAllocation: isEligibleForAllocation(payment),
      },
      allocated,
      unallocated,
      status,
      allocations: rows.map((r) => ({
        id: r.id,
        targetSourceType: r.targetSourceType,
        targetSourceId: r.targetSourceId,
        allocatedAmount: Number(r.allocatedAmount),
        createdAt: r.createdAt,
        createdById: r.createdById,
      })),
    });
  } catch (error) {
    if (error instanceof AllocationError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Get payment allocation state error:", error);
    return NextResponse.json({ success: false, message: "Unable to load allocation state" }, { status: 500 });
  }
}

const manualAllocationSchema = z.object({
  mode: z.literal("MANUAL"),
  journalLineId: z.string().min(1),
  allocations: z
    .array(
      z.object({
        targetSourceType: z.enum(["BILTY", "CHALLAN"]),
        targetSourceId: z.string().min(1),
        amount: z.number().positive(),
      })
    )
    .min(1),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
});

const autoAllocationSchema = z.object({
  mode: z.literal("AUTO"),
  journalLineId: z.string().min(1),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
});

const bodySchema = z.discriminatedUnion("mode", [manualAllocationSchema, autoAllocationSchema]);

// POST /api/parties/[id]/allocations
// { mode: "MANUAL", journalLineId, allocations: [...] }
// { mode: "AUTO", journalLineId }
//
// Payment creation itself remains Daily Posting - this endpoint
// only ever connects an EXISTING payment JournalLine to outstanding
// documents. See lib/payment-allocation.ts for every safety
// guarantee (same-party, amount limits, atomicity, concurrency).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "accounts.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id: partyId } = await params;
    const body = await request.json();
    const result = bodySchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid allocation request", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const data = result.data;

    // Never trust the Party ID for anything except this ownership
    // check - every other validation (target party match, limits)
    // happens inside lib/payment-allocation.ts against the ledger
    // itself.
    await assertPaymentBelongsToParty(prisma, data.journalLineId, partyId);

    if (data.mode === "AUTO") {
      const outcome = await autoAllocateOldestFirst({
        journalLineId: data.journalLineId,
        createdById: currentUser.userId,
        idempotencyKey: data.idempotencyKey,
      });

      return NextResponse.json({
        success: true,
        message:
          outcome.allocations.length > 0
            ? "Payment auto-allocated successfully."
            : "No eligible outstanding documents were found for this party - nothing was allocated.",
        ...outcome,
      });
    }

    const outcome = await createAllocations({
      journalLineId: data.journalLineId,
      allocations: data.allocations,
      createdById: currentUser.userId,
      idempotencyKey: data.idempotencyKey,
    });

    return NextResponse.json({
      success: true,
      message: outcome.idempotentReplay
        ? "This allocation was already processed."
        : "Allocation created successfully.",
      ...outcome,
    });
  } catch (error) {
    if (error instanceof AllocationError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Create payment allocation error:", error);
    return NextResponse.json({ success: false, message: "Unable to create allocation" }, { status: 500 });
  }
}
