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
    if (!hasPermission(currentUser, "privatePhonch.restore")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const phonch = await prisma.$transaction(async (tx) => {
      const current = await tx.privatePhonch.findUnique({ where: { id }, select: { id: true, isDeleted: true, phonchNo: true } });
      if (!current) return null;
      if (!current.isDeleted) {
        throw new Error("NOT_BINNED");
      }

      // Restore the document-owned PRIVATE_PHONCH entry Bin'd
      // alongside this PrivatePhonch (see the DELETE handler's own
      // comment in app/api/private-phonch/[id]/route.ts).
      // PRIVATE_PHONCH is replace-on-edit, so past edits can each
      // leave behind an older, already-historical soft-deleted row
      // (edits are blocked while Bin'd, so Binning always happens
      // strictly after any such edit) - taking the single newest one
      // by createdAt is what the Bin operation itself just touched,
      // never an older edit-replaced entry.
      const entryToRestore = await tx.journalEntry.findFirst({
        where: { referenceType: "PRIVATE_PHONCH", referenceId: id, isDeleted: true },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (entryToRestore) {
        await tx.journalEntry.update({
          where: { id: entryToRestore.id },
          data: { isDeleted: false, deletedAt: null, deletedById: null },
        });
      }

      const restored = await tx.privatePhonch.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null, deletedById: null },
      });

      await auditRestore(tx, {
        actor: actorFromUser(currentUser),
        module: "PRIVATE_PHONCH",
        entityType: "PrivatePhonch",
        entityId: id,
        documentNo: current.phonchNo,
        description: `Restored Private Phonch ${current.phonchNo} from Bin`,
        ...requestContext(request),
      });

      return restored;
    });

    if (!phonch) {
      return NextResponse.json({ success: false, message: "Private Phonch not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: "Private Phonch restored successfully.", phonchId: phonch.id });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_BINNED") {
      return NextResponse.json({ success: false, message: "Only binned Private Phonch records can be restored" }, { status: 400 });
    }
    console.error("Restore private phonch error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore Private Phonch" }, { status: 500 });
  }
}
