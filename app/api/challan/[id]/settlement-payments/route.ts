import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  SettlementPaymentError,
  createSettlementPayment,
  getComponentPaymentState,
} from "@/lib/settlement-payments";

function errorStatus(code: string): number {
  switch (code) {
    case "CHALLAN_NOT_FOUND":
    case "BILTY_NOT_FOUND":
    case "SETTLEMENT_PAYMENT_NOT_FOUND":
    case "PARTY_NOT_FOUND":
      return 404;
    case "CONCURRENT_SETTLEMENT_PAYMENT":
      return 409;
    default:
      return 400;
  }
}

// GET /api/challan/[id]/settlement-payments?component=CARRIER_RENT
// GET /api/challan/[id]/settlement-payments?component=COLLECTION&biltyId=X
//
// Read-only summary of one component's multi-payer state - never
// duplicates lib/challan-financials.ts's own blended calculation,
// this is a narrower per-component view used only by this engine.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    // Restricted the same way viewing an existing Final Settlement's
    // breakdown already is - challan.view is the read-side floor for
    // this whole feature area.
    if (!hasPermission(currentUser, "challan.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id: challanId } = await params;
    const component = request.nextUrl.searchParams.get("component");
    const biltyId = request.nextUrl.searchParams.get("biltyId");

    if (component !== "CARRIER_RENT" && component !== "COLLECTION") {
      return NextResponse.json(
        { success: false, message: "component must be CARRIER_RENT or COLLECTION" },
        { status: 400 }
      );
    }

    const state = await getComponentPaymentState(component, { challanId, biltyId });

    return NextResponse.json({
      success: true,
      component,
      challanId,
      biltyId: biltyId || null,
      componentTotal: state.componentTotal,
      totalPaid: state.totalPaid,
      remainingDue: state.remainingDue,
      distinctPayerAccountIds: state.distinctPayerAccountIds,
      rows: state.rows,
    });
  } catch (error) {
    if (error instanceof SettlementPaymentError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Get settlement payment state error:", error);
    return NextResponse.json({ success: false, message: "Unable to load settlement payment state" }, { status: 500 });
  }
}

const createSchema = z.object({
  component: z.enum(["CARRIER_RENT", "COLLECTION"]),
  biltyId: z.string().min(1).optional(),
  payerAccountId: z.string().min(1),
  amount: z.number().positive(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
});

// POST /api/challan/[id]/settlement-payments
// { component, biltyId?, payerAccountId, amount, idempotencyKey? }
//
// Creates ONE new, independently-addressable settlement payment row
// with its own real, balanced JournalEntry - see
// lib/settlement-payments.ts for every safety guarantee (component
// total ceiling, SERIALIZABLE concurrency, idempotent retry, no
// fabricated/non-Party account).
//
// Restricted to SUPER_ADMIN, exactly like PATCH /api/challan/[id]/
// settle already restricts editing a finalized settlement - this is
// additive settlement-time data, not a read.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (currentUser.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { success: false, message: "Only a Super Admin can record a settlement payment." },
        { status: 403 }
      );
    }

    const { id: challanId } = await params;
    const body = await request.json();
    const result = createSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid settlement payment request", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const data = result.data;

    if (data.component === "CARRIER_RENT" && data.biltyId) {
      return NextResponse.json(
        { success: false, message: "Carrier Rent is a Challan-level component and must not specify a Bilty." },
        { status: 400 }
      );
    }
    if (data.component === "COLLECTION" && !data.biltyId) {
      return NextResponse.json(
        { success: false, message: "biltyId is required for a Collection payment row." },
        { status: 400 }
      );
    }

    const outcome = await createSettlementPayment({
      challanId,
      biltyId: data.biltyId,
      component: data.component,
      payerAccountId: data.payerAccountId,
      amount: data.amount,
      createdById: currentUser.userId,
      idempotencyKey: data.idempotencyKey,
    });

    return NextResponse.json({
      success: true,
      message: outcome.idempotentReplay
        ? "This settlement payment was already recorded."
        : "Settlement payment recorded successfully.",
      ...outcome,
    });
  } catch (error) {
    if (error instanceof SettlementPaymentError) {
      return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: errorStatus(error.code) });
    }
    console.error("Create settlement payment error:", error);
    return NextResponse.json({ success: false, message: "Unable to record settlement payment" }, { status: 500 });
  }
}
