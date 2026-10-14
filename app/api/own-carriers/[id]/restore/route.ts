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
    const current = await prisma.ownCarrier.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ success: false, message: "Carrier not found" }, { status: 404 });
    }
    if (!current.isDeleted) {
      return NextResponse.json({ success: false, message: "This carrier is not in the Bin" }, { status: 400 });
    }

    const existingActive = await prisma.ownCarrier.findFirst({
      where: { carrierNumber: current.carrierNumber, isDeleted: false, id: { not: id } },
    });
    if (existingActive) {
      return NextResponse.json(
        { success: false, message: "Another active carrier already uses this carrier/vehicle number" },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.ownCarrier.update({ where: { id }, data: { isDeleted: false, deletedAt: null, deletedById: null } });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "OWN_CARRIER",
        entityType: "OwnCarrier",
        entityId: id,
        documentNo: current.carrierNumber,
        description: `Restored Own Carrier ${current.carrierNumber} from Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Carrier restored successfully" });
  } catch (error) {
    console.error("Restore own carrier error:", error);
    return NextResponse.json({ success: false, message: "Something went wrong" }, { status: 500 });
  }
}
