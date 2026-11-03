import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { auditUpdate, actorFromUser, requestContext } from "@/lib/audit-log";
import { assertSuperAdmin, ChallanLifecycleError } from "@/lib/challan-lifecycle";
import { convertChallanToOwnCarrier, ChallanConversionError } from "@/lib/challan-own-carrier-conversion";

// ============================================================
// POST /api/challan/[id]/convert-to-own-carrier - SUPER_ADMIN only.
//
// For a legacy Challan dispatched under a real Transporter Party that
// should have been ANC's own fleet (see lib/challan-own-carrier-
// conversion.ts for the full accounting rationale). Reverses the
// dispatch revenue recognition + Carrier Rent expense/payable entries
// (dated, reversesEntryId-linked - never a silent soft-delete), then
// hands the Challan over to the normal own-carrier model: ownCarrierId
// set, transporterPartyId cleared, carrierRent zeroed.
//
// Rejects outright (never partially converts) if the Challan is
// settled (Unsettle first via the existing feature), has any active
// Daily Posting payment row, or any of its Bilties' Booking Income no
// longer matches its plain dispatch-recognition amount (a post-
// dispatch correction exists) - see computeConversionImpact's own
// `blockers`.
// ============================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
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

    if (body?.confirmation !== "CONVERT_TO_OWN_CARRIER") {
      return NextResponse.json(
        { success: false, message: "Confirmation required to convert this Challan to Own Carrier." },
        { status: 400 }
      );
    }

    const ownCarrierId = typeof body.ownCarrierId === "string" ? body.ownCarrierId.trim() : "";
    if (!ownCarrierId) {
      return NextResponse.json(
        { success: false, message: "Select which Own Carrier this Challan should be converted to." },
        { status: 400 }
      );
    }

    const challan = await prisma.challan.findUnique({
      where: { id },
      select: { id: true, isDeleted: true, challanNo: true, transporterParty: { select: { partyName: true } } },
    });
    if (!challan || challan.isDeleted) {
      return NextResponse.json({ success: false, message: "Challan not found" }, { status: 404 });
    }

    let carrierRentReversed = 0;
    let bookingIncomeReversed = 0;

    try {
      await prisma.$transaction(
        async (tx) => {
          const result = await convertChallanToOwnCarrier(tx, {
            challanId: id,
            ownCarrierId,
            createdById: currentUser.userId,
          });
          carrierRentReversed = result.carrierRentReversed;
          bookingIncomeReversed = result.bookingIncomeReversed;

          await auditUpdate(tx, {
            actor: actorFromUser(currentUser),
            module: "CHALLAN",
            entityType: "Challan",
            entityId: id,
            documentNo: challan.challanNo,
            description: `Converted Challan ${challan.challanNo} from Transporter ${challan.transporterParty?.partyName ?? "-"} to Own Carrier (Carrier Rent Rs. ${carrierRentReversed.toLocaleString()} and Booking Income Rs. ${bookingIncomeReversed.toLocaleString()} reversed)`,
            changedFields: {
              transporterPartyId: { old: challan.transporterParty?.partyName ?? null, new: null },
              ownCarrierId: { old: null, new: ownCarrierId },
            },
            ...requestContext(request),
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (conversionError) {
      if (conversionError instanceof ChallanConversionError) {
        return NextResponse.json(
          { success: false, code: conversionError.code, message: conversionError.message },
          { status: 400 }
        );
      }
      throw conversionError;
    }

    return NextResponse.json({
      success: true,
      message: `Challan ${challan.challanNo} converted to Own Carrier (Carrier Rent Rs. ${carrierRentReversed.toLocaleString()} and Booking Income Rs. ${bookingIncomeReversed.toLocaleString()} reversed).`,
      challanId: id,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { success: false, message: "This Challan was modified concurrently. Please retry." },
        { status: 409 }
      );
    }
    console.error("Convert challan to own carrier error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to convert challan to own carrier" },
      { status: 500 }
    );
  }
}
