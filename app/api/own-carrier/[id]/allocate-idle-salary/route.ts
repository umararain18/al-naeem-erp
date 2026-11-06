import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { allocateIdleSalary, CarrierTripError } from "@/lib/carrier-trip";
import { auditPost, actorFromUser, requestContext } from "@/lib/audit-log";

// POST - month-end "Allocate idle salary" (Own Carrier Part 2):
// {month: "YYYY-MM"}. Dr Carrier Profit "idle salary" / Cr Driver
// Salary Payable, for whatever days of that month are NOT already
// allocated to a closed Trip - see lib/carrier-trip.ts's own
// allocateIdleSalary doc comment, including its own documented
// "run once, after every Trip for that month is closed" limitation.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const carrier = await prisma.ownCarrier.findUnique({ where: { id }, select: { id: true, isDeleted: true, carrierNumber: true } });
    if (!carrier || carrier.isDeleted) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    const body = await request.json();
    const month = typeof body.month === "string" ? body.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ success: false, message: 'Month must be in "YYYY-MM" format' }, { status: 400 });
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const r = await allocateIdleSalary(tx, { carrierId: id, month, createdById: currentUser.userId });
        if (r.posted) {
          await auditPost(tx, {
            actor: actorFromUser(currentUser),
            module: "OWN_CARRIER",
            entityType: "OwnCarrier",
            entityId: id,
            documentNo: carrier.carrierNumber,
            description: `Allocated idle salary for ${carrier.carrierNumber} - ${month}: ${r.idleDays}/${r.totalDaysInMonth} idle days, Rs. ${r.amount.toLocaleString()}`,
            newValues: { month, idleDays: r.idleDays, amount: r.amount },
            ...requestContext(request),
          });
        }
        return r;
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }

    if (!result.posted) {
      return NextResponse.json({
        success: true,
        posted: false,
        message: "No idle days remaining for this month - every day is already allocated.",
        idleDays: 0,
        amount: 0,
      });
    }

    return NextResponse.json({
      success: true,
      posted: true,
      message: `Allocated ${result.idleDays} idle day(s) (Rs. ${result.amount.toLocaleString()}).`,
      idleDays: result.idleDays,
      totalDaysInMonth: result.totalDaysInMonth,
      amount: result.amount,
    });
  } catch (error) {
    console.error("Allocate idle salary error:", error);
    return NextResponse.json({ success: false, message: "Unable to allocate idle salary" }, { status: 500 });
  }
}
