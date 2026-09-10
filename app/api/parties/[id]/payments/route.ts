import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { isEligibleForAllocation, type PaymentLineInfo } from "@/lib/payment-allocation";

// ============================================================
// GET /api/parties/[id]/payments
//
// Lists this Party's actual Cash/Bank <-> Party movements (every
// qualifying "payment" per lib/payment-allocation.ts's own
// conservative definition), each with its current allocation state
// - purely read-only, batched (one query for lines, one for their
// PaymentAllocation rows), never a per-row calculation loop.
// ============================================================

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
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get("allocationStatus"); // UNALLOCATED | PARTIALLY_ALLOCATED | FULLY_ALLOCATED | ALL

    const party = await prisma.party.findUnique({
      where: { id: partyId },
      select: { id: true, partyName: true, account: { select: { id: true } } },
    });

    if (!party) {
      return NextResponse.json({ success: false, message: "Party not found" }, { status: 404 });
    }
    if (!party.account) {
      return NextResponse.json({ success: false, message: "This party does not have an account yet." }, { status: 404 });
    }

    const lines = await prisma.journalLine.findMany({
      where: {
        accountId: party.account.id,
        journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      },
      select: {
        id: true,
        debit: true,
        credit: true,
        sourceType: true,
        sourceId: true,
        sourceNumber: true,
        description: true,
        journalEntry: {
          select: {
            id: true,
            entryDate: true,
            description: true,
            lines: {
              select: { id: true, debit: true, credit: true, account: { select: { category: true, accountName: true } } },
            },
          },
        },
      },
      orderBy: [
        { journalEntry: { entryDate: "desc" } },
        { createdAt: "desc" },
      ],
    });

    const journalLineIds = lines.map((l) => l.id);
    const allocations = journalLineIds.length
      ? await prisma.paymentAllocation.findMany({
          where: { journalLineId: { in: journalLineIds } },
          select: { journalLineId: true, allocatedAmount: true, targetSourceType: true, targetSourceId: true },
        })
      : [];

    const allocatedByLine = new Map<string, number>();
    const allocationRowsByLine = new Map<string, { targetSourceType: string; targetSourceId: string; allocatedAmount: number }[]>();
    for (const a of allocations) {
      allocatedByLine.set(a.journalLineId, (allocatedByLine.get(a.journalLineId) || 0) + Number(a.allocatedAmount));
      const arr = allocationRowsByLine.get(a.journalLineId) || [];
      arr.push({ targetSourceType: a.targetSourceType, targetSourceId: a.targetSourceId, allocatedAmount: Number(a.allocatedAmount) });
      allocationRowsByLine.set(a.journalLineId, arr);
    }

    const payments = lines.map((line) => {
      const amount = Number(line.debit) > 0 ? Number(line.debit) : Number(line.credit);
      const direction: "DEBIT" | "CREDIT" = Number(line.debit) > 0 ? "DEBIT" : "CREDIT";
      const otherLines = line.journalEntry.lines.filter((l) => l.id !== line.id);
      const cashBankLine = otherLines.find((l) => l.account.category === "CASH" || l.account.category === "BANK");

      // Mirrors getPaymentLine()'s own qualifying shape exactly - do
      // not duplicate its logic, just its RESULT shape, since we
      // already have every line of the entry loaded here.
      const paymentInfo: PaymentLineInfo = {
        journalLineId: line.id,
        amount,
        direction,
        partyAccountId: party.account!.id,
        partyId,
        entryDate: line.journalEntry.entryDate,
        isDeleted: false,
        sourceType: line.sourceType,
      };
      const isQualifyingPayment = line.journalEntry.lines.length === 2 && !!cashBankLine;
      const eligible = isQualifyingPayment && isEligibleForAllocation(paymentInfo);

      const allocated = allocatedByLine.get(line.id) || 0;
      const unallocated = Math.max(0, amount - allocated);
      const allocationStatus = !eligible
        ? null
        : allocated <= 0.009
          ? "UNALLOCATED"
          : allocated >= amount - 0.009
            ? "FULLY_ALLOCATED"
            : "PARTIALLY_ALLOCATED";

      return {
        journalLineId: line.id,
        journalEntryId: line.journalEntry.id,
        date: line.journalEntry.entryDate,
        direction,
        amount,
        cashBankAccountName: cashBankLine?.account.accountName || null,
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        sourceNumber: line.sourceNumber,
        description: line.description || line.journalEntry.description || "",
        isQualifyingPayment,
        eligibleForAllocation: eligible,
        allocated,
        unallocated,
        allocationStatus,
        allocations: allocationRowsByLine.get(line.id) || [],
      };
    });

    const filtered =
      !statusFilter || statusFilter === "ALL"
        ? payments
        : payments.filter((p) => p.allocationStatus === statusFilter);

    return NextResponse.json({
      success: true,
      party: { id: party.id, partyName: party.partyName },
      payments: filtered,
    });
  } catch (error) {
    console.error("Get party payments error:", error);
    return NextResponse.json({ success: false, message: "Unable to load party payments" }, { status: 500 });
  }
}
