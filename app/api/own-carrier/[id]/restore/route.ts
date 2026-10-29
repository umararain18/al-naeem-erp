import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

// Mirrors app/api/bill/[id]/restore/route.ts exactly.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    const restored = await prisma.$transaction(async (tx) => {
      const carrier = await tx.ownCarrier.findUnique({ where: { id }, select: { id: true, isDeleted: true, carrierNumber: true } });
      if (!carrier) return null;
      if (!carrier.isDeleted) throw new Error("NOT_BINNED");

      const restoredCarrier = await tx.ownCarrier.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "OWN_CARRIER",
        entityType: "OwnCarrier",
        entityId: id,
        documentNo: carrier.carrierNumber,
        description: `Restored Own Carrier ${carrier.carrierNumber} from Bin`,
        ...requestContext(request),
      });

      return restoredCarrier;
    });

    if (!restored) {
      return NextResponse.json({ success: false, message: "Own Carrier not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Own Carrier restored successfully.", carrierId: id });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json({ success: false, message: "Only binned Own Carriers can be restored" }, { status: 400 });
    }
    console.error("Restore own carrier error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore Own Carrier" }, { status: 500 });
  }
}
