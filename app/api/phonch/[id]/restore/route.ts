import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "phonch.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const phonch = await prisma.$transaction(async (tx) => {
      const current = await tx.phonch.findUnique({ where: { id }, select: { id: true, isDeleted: true, phonchNo: true } });
      if (!current) return null;
      if (!current.isDeleted) {
        throw new Error("NOT_BINNED");
      }
      const restored = await tx.phonch.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "SHOWROOM_PHONCH",
        entityType: "Phonch",
        entityId: id,
        documentNo: current.phonchNo,
        description: `Restored Showroom Phonch ${current.phonchNo} from Bin`,
        ...requestContext(request),
      });

      return restored;
    });

    if (!phonch) {
      return NextResponse.json({ success: false, message: "Phonch not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Phonch restored successfully.", phonchId: phonch.id });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json({ success: false, message: "Only binned Phonch records can be restored" }, { status: 400 });
    }
    console.error("Restore phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore Phonch" }, { status: 500 });
  }
}
