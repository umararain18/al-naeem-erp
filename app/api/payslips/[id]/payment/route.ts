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
  round2,
} from "@/lib/payroll-accounting";

// ============================================================
// RECORD AN ACTUAL SALARY PAYMENT
//
// Creates its OWN JournalEntry directly (referenceType:
// "PAYROLL_PAYMENT") - the same architecture already built and
// tested for Manual Journal Entry this session. This means it:
//   - appears in Cash Book naturally (source-agnostic query)
//   - is automatically invisible to Daily Posting (referenceType
//     filter excludes it - zero changes to Daily Posting's own code)
//   - never creates a SettlementPayment or touches Bilty/Challan
//
// APPROVED DESIGN DECISION: a payment MAY exceed this payslip's own
// remaining amount - this is a deliberate advance against the
// employee (matches the spec's own worked example: Salary 30,000 /
// Payment 45,000 -> -15,000 "Paid in Advance"). There is intentionally
// no upper cap here beyond amount > 0; PayslipPaymentState/
// EmployeeBalanceState already classify a negative remaining/balance
// as "Paid in Advance". The Serializable transaction + idempotencyKey
// still guard against a double-submit creating two JournalEntries for
// the exact same request.
// ============================================================

const paySchema = z.object({
  amount: z.number(),
  paymentDate: z.string().min(1),
  accountId: z.string().min(1), // a CASH or BANK account
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "employees.create")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json();
    const result = paySchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid payment data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;

    const amount = round2(data.amount);
    if (amount <= 0) {
      return NextResponse.json({ success: false, message: "Payment amount must be greater than zero." }, { status: 400 });
    }

    const paymentDate = new Date(`${data.paymentDate}T00:00:00`);
    if (Number.isNaN(paymentDate.getTime())) {
      return NextResponse.json({ success: false, message: "Invalid payment date." }, { status: 400 });
    }

    const cashBankAccount = await prisma.account.findUnique({ where: { id: data.accountId }, select: { id: true, category: true, isActive: true } });
    if (!cashBankAccount || !cashBankAccount.isActive) {
      return NextResponse.json({ success: false, message: "Selected Cash/Bank account was not found or is inactive." }, { status: 400 });
    }
    if (cashBankAccount.category !== "CASH" && cashBankAccount.category !== "BANK") {
      return NextResponse.json({ success: false, message: "Payment account must be a Cash or Bank account." }, { status: 400 });
    }

    const payslip = await prisma.payslip.findUnique({
      where: { id },
      include: { employee: { include: { account: { select: { id: true } } } } },
    });
    if (!payslip || payslip.isDeleted) {
      return NextResponse.json({ success: false, message: "Payslip not found" }, { status: 404 });
    }
    if (!payslip.employee.account) {
      return NextResponse.json({ success: false, message: "This employee has no linked account" }, { status: 400 });
    }

    const entryId = data.idempotencyKey ? `payslippay_${data.idempotencyKey}` : undefined;

    try {
      await prisma.$transaction(
        async (tx) => {
          // A payment MAY exceed this payslip's own remaining amount
          // (approved design decision) - this represents a deliberate
          // advance against the employee, and correctly drives their
          // PayslipPaymentState/EmployeeBalanceState into "Paid in
          // Advance" (negative remaining / negative balance). The
          // Serializable transaction here still guards idempotency
          // (see the P2002 replay handling below) and keeps this
          // payment's JournalEntry+lines atomic.
          const description = `Salary Payment — ${payrollMonthLabel(payslip.payrollMonth)}`;

          await tx.journalEntry.create({
            data: {
              ...(entryId ? { id: entryId } : {}),
              entryDate: paymentDate,
              referenceType: "PAYROLL_PAYMENT",
              referenceId: payslip.payslipNo,
              description,
              createdById: currentUser.userId,
              lines: {
                create: [
                  {
                    accountId: payslip.employee.account!.id,
                    description,
                    debit: amount,
                    credit: 0,
                    sourceType: "PAYSLIP",
                    sourceId: id,
                    sourceNumber: payslip.payslipNo,
                  },
                  {
                    accountId: cashBankAccount.id,
                    description,
                    debit: 0,
                    credit: amount,
                    sourceType: "PAYSLIP",
                    sourceId: id,
                    sourceNumber: payslip.payslipNo,
                  },
                ],
              },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      const newState = await getPayslipPaymentState(prisma, id, Number(payslip.netPay), payslip.employee.account!.id);

      return NextResponse.json(
        { success: true, message: "Payment recorded successfully.", state: newState },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof PayrollValidationError) {
        return NextResponse.json({ success: false, message: error.message }, { status: error.status });
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another payment for this payslip happened at the same time. Please retry." },
          { status: 409 }
        );
      }
      const isIdempotencyCollision = entryId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!isIdempotencyCollision) throw error;

      return NextResponse.json({
        success: true,
        message: "This payment was already processed.",
        idempotentReplay: true,
        state: await getPayslipPaymentState(prisma, id, Number(payslip.netPay), payslip.employee.account!.id),
      });
    }
  } catch (error) {
    console.error("Record salary payment error:", error);
    return NextResponse.json({ success: false, message: "Unable to record payment" }, { status: 500 });
  }
}
