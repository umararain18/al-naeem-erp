import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// Restores a Bin'd Payslip AND its associated PAYROLL_SALARY
// JournalEntry together, atomically - keeps the two isDeleted flags
// in sync (see app/api/payslips/[id]/route.ts's DELETE for why both
// exist). Reuses the exact isDeleted/deletedAt/deletedById clearing
// pattern already used by every other restore in this app.

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "accountingTransactions.restore")) {
      return NextResponse.json({ success: false, message: "You do not have permission to restore payslips." }, { status: 403 });
    }

    const { id } = await context.params;
    const current = await prisma.payslip.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ success: false, message: "Payslip not found" }, { status: 404 });
    }
    if (!current.isDeleted) {
      return NextResponse.json({ success: false, message: "This payslip is not in Bin." }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      const line = await tx.journalLine.findFirst({
        where: { sourceType: "PAYSLIP", sourceId: id, journalEntry: { referenceType: "PAYROLL_SALARY" } },
        select: { journalEntryId: true },
      });
      if (line) {
        await tx.journalEntry.update({
          where: { id: line.journalEntryId },
          data: { isDeleted: false, deletedAt: null, deletedById: null },
        });
      }
      await tx.payslip.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });
    });

    return NextResponse.json({ success: true, message: "Payslip restored successfully.", payslipId: id });
  } catch (error) {
    console.error("Restore payslip error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore payslip" }, { status: 500 });
  }
}
