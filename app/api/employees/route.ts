import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  PayrollValidationError,
  getEmployeeBalance,
  nextEmployeeCode,
  validateEmployeeInput,
} from "@/lib/payroll-accounting";

// ============================================================
// EMPLOYEES - LIST + CREATE
//
// An Employee is its own first-class accounting relationship, NEVER
// a Party. Creation atomically creates exactly one linked Account
// (category EMPLOYEE_PAYABLE) in the SAME transaction, mirroring
// app/api/parties/route.ts's own Party+Account creation pattern
// exactly - so an Employee can never exist without its account, and
// can never end up with more than one.
// ============================================================

const createSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  phone: z.string().optional(),
  joiningDate: z.string().optional(),
  monthlySalary: z.number().min(0),
  notes: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim();
    const status = searchParams.get("status"); // "ACTIVE" | "INACTIVE" | null (all)
    const designation = searchParams.get("designation")?.trim();

    const employees = await prisma.employee.findMany({
      where: {
        isDeleted: status === "BINNED",
        ...(status === "ACTIVE" ? { isActive: true } : {}),
        ...(status === "INACTIVE" ? { isActive: false } : {}),
        ...(designation ? { designation: { equals: designation, mode: "insensitive" } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { employeeCode: { contains: search, mode: "insensitive" } },
                { designation: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { account: { select: { id: true } } },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });

    const items = await Promise.all(
      employees.map(async (employee) => {
        const balanceState = employee.account
          ? await getEmployeeBalance(prisma, employee.account.id)
          : { balance: 0, status: "No Activity" as const };
        return {
          id: employee.id,
          employeeCode: employee.employeeCode,
          name: employee.name,
          designation: employee.designation,
          phone: employee.phone,
          joiningDate: employee.joiningDate ? employee.joiningDate.toISOString() : null,
          monthlySalary: Number(employee.monthlySalary),
          isActive: employee.isActive,
          isDeleted: employee.isDeleted,
          accountId: employee.account?.id ?? null,
          balance: balanceState.balance,
          balanceStatus: balanceState.status,
        };
      })
    );

    return NextResponse.json({
      success: true,
      items,
      total: items.length,
      capabilities: {
        canCreate: hasPermission(currentUser, "employees.create"),
        canEdit: hasPermission(currentUser, "employees.edit"),
        // Matches the actual bin-authorization enforced by DELETE
        // /api/employees/[id] and this same flag on the employee
        // detail page (app/api/employees/[id]/route.ts) - both use
        // "employees.edit", never "accountingTransactions.bin" (a
        // different, unrelated permission this list previously used).
        canBin: hasPermission(currentUser, "employees.edit"),
      },
    });
  } catch (error) {
    console.error("Get employees error:", error);
    return NextResponse.json({ success: false, message: "Unable to load employees" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const result = createSchema.safeParse(body);
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

    try {
      const employee = await prisma.$transaction(
        async (tx) => {
          const employeeCode = await nextEmployeeCode(tx);

          const created = await tx.employee.create({
            data: {
              employeeCode,
              name: data.name.trim(),
              designation: data.designation?.trim() || null,
              phone: data.phone?.trim() || null,
              joiningDate: data.joiningDate ? new Date(`${data.joiningDate}T00:00:00`) : null,
              monthlySalary: data.monthlySalary,
              notes: data.notes?.trim() || null,
              createdById: currentUser.userId,
            },
          });

          // Exactly one Account for this Employee, created atomically -
          // mirrors app/api/parties/route.ts's Party+Account pattern.
          await tx.account.create({
            data: {
              accountName: `${created.name} — Employee Account`,
              accountCode: null,
              accountType: "LIABILITY",
              category: "EMPLOYEE_PAYABLE",
              description: `Automatic account for employee: ${created.name}`,
              employeeId: created.id,
              isSystem: false,
              isActive: true,
            },
          });

          return tx.employee.findUniqueOrThrow({
            where: { id: created.id },
            include: { account: { select: { id: true } } },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json(
        {
          success: true,
          message: "Employee created successfully.",
          employee: {
            id: employee.id,
            employeeCode: employee.employeeCode,
            name: employee.name,
            accountId: employee.account?.id ?? null,
          },
        },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another employee was being created at the same time. Please retry." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("Create employee error:", error);
    return NextResponse.json({ success: false, message: "Unable to create employee" }, { status: 500 });
  }
}
