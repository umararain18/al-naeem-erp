import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  SettlementPaymentError,
  deleteSettlementPayment,
  getSettlementPaymentOrThrow,
  updateSettlementPaymentAmount,
} from "@/lib/settlement-payments";
import { prisma } from "@/lib/prisma";
import { auditSettlementPayment, auditDelete, actorFromUser, requestContext } from "@/lib/audit-log";

function errorStatus(code: string): number {
  switch (code) {
    case "CHALLAN_NOT_FOUND":
    case "BILTY_NOT_FOUND":
    case "SETTLEMENT_PAYMENT_NOT_FOUND":
    case "PARTY_NOT_FOUND":
      return 404;
    case "PAYMENT_OWNERSHIP_MISMATCH":
      return 403;
    case "CONCURRENT_SETTLEMENT_PAYMENT":
      return 409;
    default:
      return 400;
  }
}

/** Never trust the URL's Challan id for anything beyond confirming
 * the row actually belongs to it - exactly the same discipline
 * assertPaymentBelongsToParty() already established for Payment
 * Allocation. */
async function assertRowBelongsToChallan(paymentId: string, challanId: string) {
  const row = await getSettlementPaymentOrThrow(paymentId);
  if (row.challanId !== challanId) {
    throw new SettlementPaymentError(
      "PAYMENT_OWNERSHIP_MISMATCH",
      "This settlement payment row does not belong to the specified Challan."
    );
  }
  return row;
}

const patchSchema = z.object({
  newAmount: z.number().positive(),
});

// PATCH /api/challan/[id]/settlement-payments/[paymentId]
// { newAmount }
//
// Edits ONE row's amount in isolation - posts a delta-only
// correction JournalEntry tagged to this row's own id, never
// touching any other row's JournalEntry/party. SUPER_ADMIN only.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (currentUser.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { success: false, message: "Only a Super Admin can edit a settlement payment." },
        { status: 403 }
      );
    }

    const { id: challanId, paymentId } = await params;
    const existingRow = await assertRowBelongsToChallan(paymentId, challanId);

    const body = await request.json();
    const result = patchSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid request", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const outcome = await updateSettlementPaymentAmount({ paymentId, newAmount: result.data.newAmount });

    // See app/api/challan/[id]/settlement-payments/route.ts's own note
    // on why this audit write happens on the plain client, outside
    // lib/settlement-payments.ts's own internal transaction.
    await auditSettlementPayment(prisma, {
      actor: actorFromUser(currentUser),
      module: "SETTLEMENT",
      entityType: "SettlementPayment",
      entityId: paymentId,
      documentNo: challanId,
      description: `Edited Settlement Payment amount on Challan (${existingRow.component}): Rs. ${Number(existingRow.amount).toLocaleString()} → Rs. ${result.data.newAmount.toLocaleString()}`,
      changedFields: { amount: { old: Number(existingRow.amount), new: result.data.newAmount } },
      ...requestContext(request),
    });

    return NextResponse.json({ success: true, message: "Settlement payment updated successfully.", ...outcome });
  } catch (error) {
    if (error instanceof SettlementPaymentError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Update settlement payment error:", error);
    return NextResponse.json({ success: false, message: "Unable to update settlement payment" }, { status: 500 });
  }
}

// DELETE /api/challan/[id]/settlement-payments/[paymentId]
//
// Removes ONE row and reverses only its own JournalEntry effect -
// every other row for the same component/document is untouched.
// SUPER_ADMIN only.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; paymentId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (currentUser.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { success: false, message: "Only a Super Admin can remove a settlement payment." },
        { status: 403 }
      );
    }

    const { id: challanId, paymentId } = await params;
    const existingRow = await assertRowBelongsToChallan(paymentId, challanId);

    const outcome = await deleteSettlementPayment(paymentId);

    await auditDelete(prisma, {
      actor: actorFromUser(currentUser),
      module: "SETTLEMENT",
      entityType: "SettlementPayment",
      entityId: paymentId,
      documentNo: challanId,
      description: `Removed Settlement Payment on Challan (${existingRow.component}): Rs. ${Number(existingRow.amount).toLocaleString()}`,
      oldValues: { component: existingRow.component, biltyId: existingRow.biltyId, payerAccountId: existingRow.payerAccountId, amount: Number(existingRow.amount) },
      ...requestContext(request),
    });

    return NextResponse.json({ success: true, message: "Settlement payment removed successfully.", ...outcome });
  } catch (error) {
    if (error instanceof SettlementPaymentError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Delete settlement payment error:", error);
    return NextResponse.json({ success: false, message: "Unable to remove settlement payment" }, { status: 500 });
  }
}
