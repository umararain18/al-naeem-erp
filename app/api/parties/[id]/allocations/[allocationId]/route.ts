import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { AllocationError, deleteAllocation, updateAllocationAmount } from "@/lib/payment-allocation";

function errorStatus(code: string): number {
  switch (code) {
    case "ALLOCATION_NOT_FOUND":
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

const patchSchema = z.object({
  newAmount: z.number().positive(),
});

// PATCH /api/parties/[id]/allocations/[allocationId]
// { newAmount }
//
// Changes an existing allocation's amount in place. Never creates a
// new PaymentAllocation row and never touches accounting - see
// lib/payment-allocation.ts's updateAllocationAmount for the full
// re-validation sequence (payment still qualifies, party ownership,
// target still belongs to the same party, fresh limits excluding
// this row).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; allocationId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id: partyId, allocationId } = await params;
    const body = await request.json();
    const result = patchSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid request", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const outcome = await updateAllocationAmount({
      allocationId,
      newAmount: result.data.newAmount,
      partyId,
    });

    return NextResponse.json({ success: true, message: "Allocation updated successfully.", ...outcome });
  } catch (error) {
    if (error instanceof AllocationError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Update payment allocation error:", error);
    return NextResponse.json({ success: false, message: "Unable to update allocation" }, { status: 500 });
  }
}

// DELETE /api/parties/[id]/allocations/[allocationId]
//
// Removes the allocation row and releases its amount back to the
// payment's unallocated pool. Never touches accounting.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; allocationId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id: partyId, allocationId } = await params;

    const outcome = await deleteAllocation({ allocationId, partyId });

    return NextResponse.json({ success: true, message: "Allocation removed successfully.", ...outcome });
  } catch (error) {
    if (error instanceof AllocationError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Delete payment allocation error:", error);
    return NextResponse.json({ success: false, message: "Unable to delete allocation" }, { status: 500 });
  }
}
