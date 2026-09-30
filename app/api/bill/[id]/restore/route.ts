import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

// Mirrors app/api/phonch/[id]/restore/route.ts exactly.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "bill.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    const restored = await prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findUnique({ where: { id }, select: { id: true, isDeleted: true, billNo: true } });
      if (!bill) return null;
      if (!bill.isDeleted) throw new Error("NOT_BINNED");
      const restoredBill = await tx.bill.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "BILL",
        entityType: "Bill",
        entityId: id,
        documentNo: bill.billNo,
        description: `Restored Bill ${bill.billNo} from Bin`,
        ...requestContext(request),
      });

      return restoredBill;
    });

    if (!restored) {
      return NextResponse.json({ success: false, message: "Bill not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Bill restored successfully.", billId: id });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json({ success: false, message: "Only binned Bills can be restored" }, { status: 400 });
    }
    console.error("Restore bill error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore Bill" }, { status: 500 });
  }
}
