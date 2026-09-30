import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { PayrollValidationError, getEmployeeBalance, validateEmployeeInput } from "@/lib/payroll-accounting";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

// ============================================================
// EMPLOYEE - VIEW / EDIT / BIN
//
// Edit NEVER touches the linked Account (Employee ID and Account ID
// are both preserved for the life of the record - approved design,
// no account-reassignment workflow in v1). Bin is a plain record-
// level soft delete (isDeleted/deletedAt/deletedById on Employee
// itself) - it NEVER deletes the Account, NEVER deletes JournalLines,
// so historical Employee Ledger remains fully intact and queryable
// even for a binned employee (only its APPEARANCE in the active
// Employee Accounts list/Payroll selector is suppressed).
// ============================================================

const updateSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  phone: z.string().optional(),
  joiningDate: z.string().optional(),
  monthlySalary: z.number().min(0),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;

    // See the identical guard in app/api/challan/[id]/route.ts - a raw
    // null byte in the id is rejected by PostgreSQL's text encoding
    // before Prisma even gets to compare it against a real row,
    // throwing an exception that would otherwise become an
    // unexplained 500. A real Employee id can never contain one.
    if (id.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        account: { select: { id: true, accountName: true } },
        payslips: {
          where: { isDeleted: false },
          orderBy: [{ payrollMonth: "desc" }],
          take: 5,
          select: { id: true, payslipNo: true, payrollMonth: true, grossPay: true, deduction: true, netPay: true },
        },
      },
    });

    if (!employee || employee.isDeleted) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    const balanceState = employee.account
      ? await getEmployeeBalance(prisma, employee.account.id)
      : { balance: 0, status: "No Activity" as const };

    return NextResponse.json({
      success: true,
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        name: employee.name,
        designation: employee.designation,
        phone: employee.phone,
        joiningDate: employee.joiningDate ? employee.joiningDate.toISOString() : null,
        monthlySalary: Number(employee.monthlySalary),
        isActive: employee.isActive,
        notes: employee.notes,
        accountId: employee.account?.id ?? null,
        accountName: employee.account?.accountName ?? null,
        balance: balanceState.balance,
        balanceStatus: balanceState.status,
        recentPayslips: employee.payslips.map((p) => ({
          id: p.id,
          payslipNo: p.payslipNo,
          payrollMonth: p.payrollMonth,
          grossPay: Number(p.grossPay),
          deduction: Number(p.deduction),
          netPay: Number(p.netPay),
        })),
      },
      capabilities: {
        canEdit: hasPermission(currentUser, "employees.edit"),
        canBin: hasPermission(currentUser, "employees.edit"),
      },
    });
  } catch (error) {
    console.error("Get employee error:", error);
    return NextResponse.json({ success: false, message: "Unable to load employee" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid employee data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    try {
      validateEmployeeInput(data);
    } catch (error) {
      if (error instanceof PayrollValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      throw error;
    }

    const current = await prisma.employee.findUnique({ where: { id } });
    if (!current || current.isDeleted) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    const updated = await prisma.employee.update({
      where: { id },
      data: {
        name: data.name.trim(),
        designation: data.designation?.trim() || null,
        phone: data.phone?.trim() || null,
        joiningDate: data.joiningDate ? new Date(`${data.joiningDate}T00:00:00`) : null,
        monthlySalary: data.monthlySalary,
        isActive: data.isActive ?? current.isActive,
        notes: data.notes?.trim() || null,
        // employeeCode, account link, and every audit field are
        // intentionally untouched - no account reassignment in v1.
      },
    });

    const changedFields = diffFields(
      { name: current.name, designation: current.designation, phone: current.phone, monthlySalary: Number(current.monthlySalary), isActive: current.isActive },
      { name: updated.name, designation: updated.designation, phone: updated.phone, monthlySalary: Number(updated.monthlySalary), isActive: updated.isActive },
      ["name", "designation", "phone", "monthlySalary", "isActive"]
    );
    if (Object.keys(changedFields).length > 0) {
      const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
      await auditUpdate(prisma, {
        actor: actorFromUser(currentUser),
        module: "EMPLOYEE",
        entityType: "Employee",
        entityId: id,
        documentNo: current.employeeCode,
        description: `Updated Employee ${current.employeeCode}: ${summary}`,
        changedFields,
        ...requestContext(request),
      });
    }

    return NextResponse.json({ success: true, message: "Employee updated successfully.", employeeId: updated.id });
  } catch (error) {
    console.error("Update employee error:", error);
    return NextResponse.json({ success: false, message: "Unable to update employee" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;

    // See the identical guard in this file's GET handler.
    if (id.includes("\u0000")) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }

    const current = await prisma.employee.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ success: false, message: "Employee not found" }, { status: 404 });
    }
    if (current.isDeleted) {
      return NextResponse.json({ success: false, message: "This employee is already in Bin." }, { status: 400 });
    }

    const deleted = await prisma.employee.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
    });

    await auditDelete(prisma, {
      actor: actorFromUser(currentUser),
      module: "EMPLOYEE",
      entityType: "Employee",
      entityId: id,
      documentNo: current.employeeCode,
      description: `Moved Employee ${current.employeeCode} (${current.name}) to Bin`,
      ...requestContext(request),
    });

    return NextResponse.json({ success: true, message: "Employee moved to Bin successfully.", employeeId: deleted.id });
  } catch (error) {
    console.error("Bin employee error:", error);
    return NextResponse.json({ success: false, message: "Unable to move employee to Bin" }, { status: 500 });
  }
}
