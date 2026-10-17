import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "ownCarrier.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const current = await prisma.carrierSlip.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ success: false, message: "Slip not found" }, { status: 404 });
    }
    if (!current.isDeleted) {
      return NextResponse.json({ success: false, message: "This slip is not in the Bin" }, { status: 400 });
    }

    const existingActive = await prisma.carrierSlip.findFirst({
      where: { carrierId: current.carrierId, slipNo: current.slipNo, isDeleted: false, id: { not: id } },
    });
    if (existingActive) {
      return NextResponse.json(
        { success: false, message: "Another active slip already uses this slip number for this carrier" },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.carrierSlip.update({ where: { id }, data: { isDeleted: false, deletedAt: null, deletedById: null } });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "OWN_CARRIER",
        entityType: "CarrierSlip",
        entityId: id,
        documentNo: `Slip ${current.slipNo}`,
        description: `Restored Carrier Slip ${current.slipNo} from Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Slip restored successfully" });
  } catch (error) {
    console.error("Restore carrier slip error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
