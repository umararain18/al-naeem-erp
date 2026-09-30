import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  PayrollValidationError,
  getPayslipPaymentState,
  isValidPayrollMonth,
  nextPayslipNo,
  payrollMonthLabel,
  postSalaryRecognition,
  validatePayslipInput,
} from "@/lib/payroll-accounting";
import { auditCreate, actorFromUser, requestContext } from "@/lib/audit-log";

// ============================================================
// PAYSLIPS - LIST (Payroll register) + CREATE
//
// CRITICAL: creating a Payslip recognizes salary accounting (Dr
// Salary Expense / Cr Employee Account) exactly ONCE, immediately -
// it does NOT create any payment. "Paid"/"Remaining"/Status are
// always derived fresh from actual JournalLines (see
// lib/payroll-accounting.ts), never stored redundantly.
// ============================================================

const createSchema = z.object({
  employeeId: z.string().min(1),
  payrollMonth: z.string().min(1), // "YYYY-MM"
  payDate: z.string().min(1),
  grossPay: z.number(),
  deduction: z.number().default(0),
  contribution: z.number().default(0),
  notes: z.string().optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .optional(),
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
    const payrollMonth = searchParams.get("payrollMonth");
    const employeeId = searchParams.get("employeeId");
    const search = searchParams.get("search")?.trim();
    const statusFilter = searchParams.get("status"); // Unpaid | Partially Paid | Paid | Paid in Advance

    const payslips = await prisma.payslip.findMany({
      where: {
        isDeleted: false,
        ...(payrollMonth ? { payrollMonth } : {}),
        ...(employeeId ? { employeeId } : {}),
        ...(search
          ? {
              OR: [
                { payslipNo: { contains: search, mode: "insensitive" } },
                { employee: { name: { contains: search, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      include: {
        employee: { select: { id: true, name: true, designation: true, account: { select: { id: true } } } },
      },
      orderBy: [{ payDate: "desc" }, { createdAt: "desc" }],
    });

    const items = await Promise.all(
      payslips.map(async (p) => {
        const netPay = Number(p.netPay);
        const state = await getPayslipPaymentState(prisma, p.id, netPay, p.employee.account!.id);
        return {
          id: p.id,
          payslipNo: p.payslipNo,
          employeeId: p.employee.id,
          employeeName: p.employee.name,
          designation: p.employee.designation,
          payrollMonth: p.payrollMonth,
          payDate: p.payDate.toISOString(),
          grossPay: Number(p.grossPay),
          deduction: Number(p.deduction),
          netPay,
          contribution: Number(p.contribution),
          paidAmount: state.paidAmount,
          remainingAmount: state.remainingAmount,
          status: state.status,
        };
      })
    );

    const filtered = statusFilter ? items.filter((i) => i.status === statusFilter) : items;

    const totals = filtered.reduce(
      (acc, i) => ({
        grossPay: acc.grossPay + i.grossPay,
        deduction: acc.deduction + i.deduction,
        netPay: acc.netPay + i.netPay,
        paid: acc.paid + i.paidAmount,
        payable: acc.payable + i.remainingAmount,
      }),
      { grossPay: 0, deduction: 0, netPay: 0, paid: 0, payable: 0 }
    );

    return NextResponse.json({
      success: true,
      items: filtered,
      total: filtered.length,
      totals,
      capabilities: {
        canCreate: hasPermission(currentUser, "employees.create"),
        canEdit: hasPermission(currentUser, "employees.edit"),
        canBin: hasPermission(currentUser, "accountingTransactions.bin"),
      },
    });
  } catch (error) {
    console.error("Get payslips error:", error);
    return NextResponse.json({ success: false, message: "Unable to load payslips" }, { status: 500 });
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
        { success: false, message: "Invalid payslip data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    if (!isValidPayrollMonth(data.payrollMonth)) {
      return NextResponse.json({ success: false, message: "Invalid payroll month (expected YYYY-MM)" }, { status: 400 });
    }

    let netPay: number;
    try {
      ({ netPay } = validatePayslipInput(data));
    } catch (error) {
      if (error instanceof PayrollValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      throw error;
    }

    const employee = await prisma.employee.findUnique({
      where: { id: data.employeeId },
      include: { account: { select: { id: true } } },
    });
    if (!employee || employee.isDeleted) {
      return NextResponse.json({ success: false, message: "Selected employee was not found" }, { status: 404 });
    }
    if (!employee.isActive) {
      return NextResponse.json({ success: false, message: "Cannot create a payslip for an inactive employee" }, { status: 400 });
    }
    if (!employee.account) {
      return NextResponse.json({ success: false, message: "This employee has no linked account" }, { status: 400 });
    }

    const payslipId = data.idempotencyKey ? `payslip_${data.idempotencyKey}` : undefined;

    // Idempotent replay check FIRST, before the business duplicate
    // check below - otherwise a genuine double-submit (same
    // idempotencyKey) would be misreported as "already has a payslip
    // for this period" instead of a silent success replay, since the
    // first successful call already created exactly that condition.
    if (payslipId) {
      const alreadyProcessed = await prisma.payslip.findUnique({ where: { id: payslipId } });
      if (alreadyProcessed) {
        return NextResponse.json({
          success: true,
          message: "This payslip was already processed.",
          idempotentReplay: true,
          payslip: { id: alreadyProcessed.id, payslipNo: alreadyProcessed.payslipNo },
        });
      }
    }

    // Duplicate-payslip protection (Part 21) - clear server-side
    // pre-check, backed by the DB's own @@unique([employeeId,
    // payrollMonth]) constraint as the hard guarantee.
    const existing = await prisma.payslip.findFirst({
      where: { employeeId: data.employeeId, payrollMonth: data.payrollMonth, isDeleted: false },
    });
    if (existing) {
      return NextResponse.json(
        { success: false, message: "This employee already has a payslip for this payroll period." },
        { status: 409 }
      );
    }

    const salaryExpenseAccount = await prisma.account.findFirst({
      where: { category: "SALARY", isActive: true },
      select: { id: true },
    });
    if (!salaryExpenseAccount) {
      return NextResponse.json(
        {
          success: false,
          message: "No active Salary Expense account exists. Create one first (Accounts → New Account, category: Salary).",
        },
        { status: 400 }
      );
    }

    try {
      const payslip = await prisma.$transaction(
        async (tx) => {
          // Re-check duplicate INSIDE the transaction against live state.
          const dup = await tx.payslip.findFirst({
            where: { employeeId: data.employeeId, payrollMonth: data.payrollMonth, isDeleted: false },
          });
          if (dup) {
            throw new PayrollValidationError("This employee already has a payslip for this payroll period.", 409);
          }

          const payslipNo = await nextPayslipNo(tx);

          const created = await tx.payslip.create({
            data: {
              ...(payslipId ? { id: payslipId } : {}),
              payslipNo,
              employeeId: data.employeeId,
              payrollMonth: data.payrollMonth,
              payDate: new Date(`${data.payDate}T00:00:00`),
              grossPay: data.grossPay,
              deduction: data.deduction,
              netPay,
              contribution: data.contribution,
              notes: data.notes?.trim() || null,
              createdById: currentUser.userId,
            },
          });

          await postSalaryRecognition(tx, {
            payslipId: created.id,
            payslipNo: created.payslipNo,
            employeeAccountId: employee.account!.id,
            salaryExpenseAccountId: salaryExpenseAccount.id,
            amount: netPay,
            entryDate: created.payDate,
            description: `Salary — ${payrollMonthLabel(data.payrollMonth)}`,
            createdById: currentUser.userId,
          });

          await auditCreate(tx, {
            actor: actorFromUser(currentUser),
            module: "PAYROLL",
            entityType: "Payslip",
            entityId: created.id,
            documentNo: created.payslipNo,
            description: `Created Payslip ${created.payslipNo} for ${employee.name} (${payrollMonthLabel(data.payrollMonth)}, Net Pay Rs. ${netPay.toLocaleString()})`,
            newValues: { employeeId: data.employeeId, payrollMonth: data.payrollMonth, grossPay: data.grossPay, deduction: data.deduction, netPay },
            ...requestContext(request),
          });

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json(
        { success: true, message: "Payslip created successfully.", payslip: { id: payslip.id, payslipNo: payslip.payslipNo } },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof PayrollValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another payslip submission happened at the same time. Please retry." },
          { status: 409 }
        );
      }
      const isIdempotencyCollision = payslipId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!isIdempotencyCollision) throw error;

      const existingPayslip = await prisma.payslip.findUnique({ where: { id: payslipId! } });
      if (!existingPayslip) {
        return NextResponse.json(
          { success: false, message: "This submission could not be completed. Please try again." },
          { status: 409 }
        );
      }
      return NextResponse.json({
        success: true,
        message: "This payslip was already processed.",
        idempotentReplay: true,
        payslip: { id: existingPayslip.id, payslipNo: existingPayslip.payslipNo },
      });
    }
  } catch (error) {
    console.error("Create payslip error:", error);
    return NextResponse.json({ success: false, message: "Unable to create payslip" }, { status: 500 });
  }
}
