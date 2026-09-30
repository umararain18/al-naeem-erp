import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { auditRestore, actorFromUser, requestContext } from "@/lib/audit-log";

// Restores a Bin'd Employee record - the smallest safe extension of
// the existing restore pattern (clears isDeleted/deletedAt/
// deletedById), scoped to Employee specifically since Employee is a
// business record (like Bilty/Challan), not a JournalEntry, so the
// existing POST /api/accounting-transactions/[id]/restore cannot
// apply here. Never touches the linked Account or any JournalLine.

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const current = await prisma.employee.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }
    if (!current.isDeleted) {
      return NextResponse.json({ success: false, message: "This employee is not in Bin." }, { status: 400 });
    }

    const restored = await prisma.employee.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null, deletedById: null },
    });

    await auditRestore(prisma, {
      actor: actorFromUser(currentUser),
      module: "EMPLOYEE",
      entityType: "Employee",
      entityId: id,
      documentNo: current.employeeCode,
      description: `Restored Employee ${current.employeeCode} (${current.name}) from Bin`,
      ...requestContext(request),
    });

    return NextResponse.json({ success: true, message: "Employee restored successfully.", employeeId: restored.id });
  } catch (error) {
    console.error("Restore employee error:", error);
    return NextResponse.json({ success: false, message: "Unable to restore employee" }, { status: 500 });
  }
}
