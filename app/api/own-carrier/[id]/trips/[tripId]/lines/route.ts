import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  CarrierTripError,
  postCollectionLine,
  postCashFromOfficeLine,
  postExpenseCashLine,
  postExpenseCreditLine,
  postDriverSalaryLine,
  postDepositToOfficeLine,
  type CarrierTripDocumentType,
} from "@/lib/carrier-trip";
import { auditPost, actorFromUser, requestContext } from "@/lib/audit-log";

const LINE_TYPES = ["COLLECTION", "CASH_FROM_OFFICE", "EXPENSE_CASH", "EXPENSE_CREDIT", "DRIVER_SALARY", "DEPOSIT_TO_OFFICE"] as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tripId: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id, tripId } = await params;
    const trip = await prisma.carrierTrip.findUnique({ where: { id: tripId }, select: { carrierId: true } });
    if (!trip || trip.carrierId !== id) {
      return NextResponse.json({ success: false, message: "Trip not found" }, { status: 404 });
    }

    const body = await request.json();
    const lineType = body.lineType as (typeof LINE_TYPES)[number];
    if (!LINE_TYPES.includes(lineType)) {
      return NextResponse.json({ success: false, message: "Invalid line type" }, { status: 400 });
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ success: false, message: "Amount must be greater than zero" }, { status: 400 });
    }
    const date = body.date ? new Date(`${body.date}T00:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ success: false, message: "Invalid date" }, { status: 400 });
    }
    const description: string | null = body.description?.trim() || null;

    let line;
    try {
      line = await prisma.$transaction(async (tx) => {
        const base = { tripId, date, description, amount, createdById: currentUser.userId };

        switch (lineType) {
          case "COLLECTION": {
            const documentType = body.documentType as CarrierTripDocumentType;
            if (!body.documentId || !documentType) {
              throw new CarrierTripError("MISSING_DOCUMENT", "A linked document is required for a Collection line.");
            }
            return postCollectionLine(tx, {
              ...base,
              documentType,
              documentId: body.documentId,
              counterAccountId: body.counterAccountId || null,
            });
          }
          case "CASH_FROM_OFFICE":
            if (!body.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
            return postCashFromOfficeLine(tx, { ...base, officeAccountId: body.officeAccountId });
          case "DEPOSIT_TO_OFFICE":
            if (!body.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
            return postDepositToOfficeLine(tx, { ...base, officeAccountId: body.officeAccountId });
          case "EXPENSE_CASH":
            if (!body.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Expense account is required.");
            return postExpenseCashLine(tx, { ...base, expenseAccountId: body.expenseAccountId });
          case "EXPENSE_CREDIT":
            if (!body.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Expense account is required.");
            if (!body.vendorPartyId) throw new CarrierTripError("MISSING_VENDOR", "Vendor party is required for a credit expense.");
            return postExpenseCreditLine(tx, { ...base, expenseAccountId: body.expenseAccountId, vendorPartyId: body.vendorPartyId });
          case "DRIVER_SALARY":
            if (!body.employeeId) throw new CarrierTripError("MISSING_EMPLOYEE", "Employee is required for a salary line.");
            return postDriverSalaryLine(tx, { ...base, employeeId: body.employeeId });
          default:
            throw new CarrierTripError("INVALID_LINE_TYPE", "Invalid line type.");
        }
      });

      await prisma.$transaction(async (tx) => {
        await auditPost(tx, {
          actor: actorFromUser(currentUser),
          module: "CARRIER_TRIP_LINE",
          entityType: "CarrierTripLine",
          entityId: line!.id,
          description: `Posted ${lineType} line (Rs. ${amount.toLocaleString()}) on Trip`,
          newValues: { lineType, amount },
          ...requestContext(request),
        });
      });
    } catch (error) {
      if (error instanceof CarrierTripError) {
        return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ success: true, message: "Line posted successfully.", line: { id: line.id } }, { status: 201 });
  } catch (error) {
    console.error("Post carrier trip line error:", error);
    return NextResponse.json({ success: false, message: "Unable to post line" }, { status: 500 });
  }
}
