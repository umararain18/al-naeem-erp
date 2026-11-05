import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

export async function GET(
  _request: NextRequest,
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

    if (!hasPermission(currentUser, "accountingTransactions.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { id } = await params;

    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
        lines: {
          include: {
            account: {
              select: {
                id: true,
                accountName: true,
                accountCode: true,
                accountType: true,
                category: true,
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!entry) {
      return NextResponse.json(
        { success: false, message: "Transaction not found" },
        { status: 404 }
      );
    }

    const totalDebit = entry.lines.reduce((sum, line) => sum + Number(line.debit), 0);
    const totalCredit = entry.lines.reduce((sum, line) => sum + Number(line.credit), 0);

    // Own Carrier Trip Close/Reopen entries (both the Carrier Rent and
    // the Expenses entry, and either's reversal) carry the TRIP's own
    // id as referenceId (never a single Challan's, since one entry
    // can combine several - see lib/carrier-trip.ts's own module
    // comment) - resolved here so the page can link straight to that
    // Trip's own Trip Slip / Profit Report, which needs both the
    // Trip's id AND its carrier's id to build the URL.
    const TRIP_CLOSE_REFERENCE_TYPES = [
      "CARRIER_TRIP_CLOSE",
      "CARRIER_TRIP_CLOSE_REVERSAL",
      "CARRIER_TRIP_CLOSE_EXPENSE",
      "CARRIER_TRIP_CLOSE_EXPENSE_REVERSAL",
    ];
    let tripLink: { carrierId: string; tripId: string; tripNo: string } | null = null;
    if (entry.referenceType && TRIP_CLOSE_REFERENCE_TYPES.includes(entry.referenceType) && entry.referenceId) {
      const trip = await prisma.carrierTrip.findUnique({
        where: { id: entry.referenceId },
        select: { id: true, tripNo: true, carrierId: true },
      });
      if (trip) tripLink = { carrierId: trip.carrierId, tripId: trip.id, tripNo: trip.tripNo };
    }

    return NextResponse.json({
      success: true,
      entry: {
        ...entry,
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
        tripLink,
      },
    });
  } catch (error) {
    console.error("Get accounting transaction error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load transaction" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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

    if (
      !hasPermission(
        currentUser,
        "accountingTransactions.permanentlyDelete"
      )
    ) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const body = await request.json();
    if (body?.confirmation !== "DELETE") {
      return NextResponse.json(
        { success: false, message: 'Type "DELETE" to permanently delete this transaction' },
        { status: 400 }
      );
    }

    const { id } = await params;
    const entry = await prisma.$transaction(async (tx) => {
      const currentEntry = await tx.journalEntry.findUnique({
        where: { id },
        select: { id: true, isDeleted: true },
      });

      if (!currentEntry) {
        return null;
      }

      if (!currentEntry.isDeleted) {
        throw new Error("NOT_BINNED");
      }

      return tx.journalEntry.delete({ where: { id } });
    });

    if (!entry) {
      return NextResponse.json(
        { success: false, message: "Transaction not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Transaction permanently deleted.",
      journalEntryId: entry.id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json(
        { success: false, message: "Only binned transactions can be permanently deleted" },
        { status: 400 }
      );
    }

    console.error("Permanent delete accounting transaction error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to permanently delete transaction" },
      { status: 500 }
    );
  }
}
