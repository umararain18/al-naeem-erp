import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  PayrollValidationError,
  getPayslipPaymentState,
  payrollMonthLabel,
  postSalaryRecognition,
  validatePayslipInput,
} from "@/lib/payroll-accounting";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";

// ============================================================
// PAYSLIP - VIEW / EDIT / BIN
//
// Financial fields (Gross Pay/Deduction/Contribution) may only be
// edited while ZERO payments have been recorded yet - editing them
// then reuses the SAME correction pattern already established
// elsewhere in this codebase (e.g. BILTY_BOOKING_CORRECTION): the
// original PAYROLL_SALARY JournalEntry is Bin'd (soft-deleted, never
// hard-deleted) and a fresh one is posted for the corrected amount -
// never a silent edit of historical accounting, never a duplicate
// live salary expense (the old entry is excluded from every report
// the moment it is binned). Once any payment exists, financial
// fields become read-only to guarantee the recognized amount can
// never drift out of sync with payments already made against it.
// ============================================================

const updateSchema = z.object({
  payDate: z.string().min(1),
  grossPay: z.number(),
  deduction: z.number().default(0),
  contribution: z.number().default(0),
  notes: z.string().optional(),
});

async function findSalaryRecognitionEntry(payslipId: string) {
  const line = await prisma.journalLine.findFirst({
    where: { sourceType: "PAYSLIP", sourceId: payslipId, journalEntry: { referenceType: "PAYROLL_SALARY", isDeleted: false } },
    select: { journalEntryId: true },
  });
  return line?.journalEntryId ?? null;
}

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
    const payslip = await prisma.payslip.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, name: true, designation: true, employeeCode: true, account: { select: { id: true } } } },
      },
    });
    if (!payslip || payslip.isDeleted) {
      return NextResponse.json({ success: false, message: "Payslip not found" }, { status: 404 });
    }

    const netPay = Number(payslip.netPay);
    const state = await getPayslipPaymentState(prisma, id, netPay, payslip.employee.account!.id);

    const payments = await prisma.journalLine.findMany({
      where: { sourceType: "PAYSLIP", sourceId: id, journalEntry: { referenceType: "PAYROLL_PAYMENT", isDeleted: false } },
      include: { journalEntry: { select: { entryDate: true } }, account: { select: { accountName: true, category: true } } },
      orderBy: { journalEntry: { entryDate: "asc" } },
    });

    return NextResponse.json({
      success: true,
      payslip: {
        id: payslip.id,
        payslipNo: payslip.payslipNo,
        employeeId: payslip.employee.id,
        employeeName: payslip.employee.name,
        employeeCode: payslip.employee.employeeCode,
        designation: payslip.employee.designation,
        payrollMonth: payslip.payrollMonth,
        payDate: payslip.payDate.toISOString(),
        grossPay: Number(payslip.grossPay),
        deduction: Number(payslip.deduction),
        netPay,
        contribution: Number(payslip.contribution),
        notes: payslip.notes,
        paidAmount: state.paidAmount,
        remainingAmount: state.remainingAmount,
        status: state.status,
        canEditAmounts: state.paidAmount <= 0.01,
        payments: payments
          .filter((p) => p.debit && Number(p.debit) > 0) // only the Cash/Bank-crediting side is the "payment amount"; take the employee-account debit leg
          .map((p) => ({ date: p.journalEntry.entryDate.toISOString(), amount: Number(p.debit) })),
      },
      capabilities: {
        canEdit: hasPermission(currentUser, "employees.edit"),
        canBin: hasPermission(currentUser, "accountingTransactions.bin"),
        canPay: hasPermission(currentUser, "employees.create"),
      },
    });
  } catch (error) {
    console.error("Get payslip error:", error);
    return NextResponse.json({ success: false, message: "Unable to load payslip" }, { status: 500 });
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
    const body = await request.json();
    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid payslip data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    let netPay: number;
    try {
      ({ netPay } = validatePayslipInput(data));
    } catch (error) {
      if (error instanceof PayrollValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      throw error;
    }

    const current = await prisma.payslip.findUnique({
      where: { id },
      include: { employee: { include: { account: { select: { id: true } } } } },
    });
    if (!current || current.isDeleted) {
      return NextResponse.json({ success: false, message: "Payslip not found" }, { status: 404 });
    }

    const state = await getPayslipPaymentState(prisma, id, Number(current.netPay), current.employee.account!.id);
    const amountsChanged =
      data.grossPay !== Number(current.grossPay) ||
      data.deduction !== Number(current.deduction) ||
      data.contribution !== Number(current.contribution);

    if (amountsChanged && state.paidAmount > 0.01) {
      return NextResponse.json(
        {
          success: false,
          message: "Cannot change Gross Pay, Deduction, or Contribution after a payment has been recorded against this payslip.",
        },
        { status: 400 }
      );
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          if (amountsChanged) {
            // Correction: Bin the original recognition entry, post a fresh
            // one for the corrected amount - never a silent historical edit.
            const oldEntryId = await findSalaryRecognitionEntry(id);
            if (oldEntryId) {
              await tx.journalEntry.update({
                where: { id: oldEntryId },
                data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
              });
            }

            const salaryExpenseAccount = await tx.account.findFirst({ where: { category: "SALARY", isActive: true }, select: { id: true } });
            if (!salaryExpenseAccount) {
              throw new PayrollValidationError("No active Salary Expense account exists.");
            }

            await postSalaryRecognition(tx, {
              payslipId: id,
              payslipNo: current.payslipNo,
              employeeAccountId: current.employee.account!.id,
              salaryExpenseAccountId: salaryExpenseAccount.id,
              amount: netPay,
              entryDate: new Date(`${data.payDate}T00:00:00`),
              description: `Salary — ${payrollMonthLabel(current.payrollMonth)} (corrected)`,
              createdById: currentUser.userId,
            });
          }

          await tx.payslip.update({
            where: { id },
            data: {
              payDate: new Date(`${data.payDate}T00:00:00`),
              grossPay: data.grossPay,
              deduction: data.deduction,
              netPay,
              contribution: data.contribution,
              notes: data.notes?.trim() || null,
            },
          });

          const changedFields = diffFields(
            { grossPay: Number(current.grossPay), deduction: Number(current.deduction), contribution: Number(current.contribution), netPay: Number(current.netPay) },
            { grossPay: data.grossPay, deduction: data.deduction, contribution: data.contribution, netPay },
            ["grossPay", "deduction", "contribution", "netPay"]
          );
          if (Object.keys(changedFields).length > 0) {
            const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
            await auditUpdate(tx, {
              actor: actorFromUser(currentUser),
              module: "PAYROLL",
              entityType: "Payslip",
              entityId: id,
              documentNo: current.payslipNo,
              description: `Updated Payslip ${current.payslipNo}: ${summary}`,
              changedFields,
              ...requestContext(request),
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({ success: true, message: "Payslip updated successfully." });
    } catch (error) {
      if (error instanceof PayrollValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      throw error;
    }
  } catch (error) {
    console.error("Update payslip error:", error);
    return NextResponse.json({ success: false, message: "Unable to update payslip" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "accountingTransactions.bin")) {
      return NextResponse.json({ success: false, message: "You do not have permission to move payslips to Bin." }, { status: 403 });
    }

    const { id } = await context.params;
    const current = await prisma.payslip.findUnique({
      where: { id },
      include: { employee: { select: { account: { select: { id: true } } } } },
    });
    if (!current) {
      return NextResponse.json({ success: false, message: "Payslip not found" }, { status: 404 });
    }
    if (current.isDeleted) {
      return NextResponse.json({ success: false, message: "This payslip is already in Bin." }, { status: 400 });
    }

    const state = await getPayslipPaymentState(prisma, id, Number(current.netPay), current.employee.account!.id);
    if (state.paidAmount > 0.01) {
      return NextResponse.json(
        {
          success: false,
          message: "This payslip has recorded payments and cannot be Bin'd. Move the payment(s) to Bin first (via Cash Book), then retry.",
        },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      const entryId = await findSalaryRecognitionEntry(id);
      if (entryId) {
        await tx.journalEntry.update({
          where: { id: entryId },
          data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
        });
      }
      await tx.payslip.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date(), deletedById: currentUser.userId },
      });

      await auditDelete(tx, {
        actor: actorFromUser(currentUser),
        module: "PAYROLL",
        entityType: "Payslip",
        entityId: id,
        documentNo: current.payslipNo,
        description: `Moved Payslip ${current.payslipNo} to Bin`,
        ...requestContext(request),
      });
    });

    return NextResponse.json({ success: true, message: "Payslip moved to Bin successfully." });
  } catch (error) {
    console.error("Bin payslip error:", error);
    return NextResponse.json({ success: false, message: "Unable to move payslip to Bin" }, { status: 500 });
  }
}
