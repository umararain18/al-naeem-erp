import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// EMPLOYEES & PAYROLL - SHARED ACCOUNTING/VALIDATION (Step 16)
//
// Employee is its OWN first-class accounting relationship - never a
// Party (approved design). Each active Employee has exactly one
// linked Account (category EMPLOYEE_PAYABLE, AccountType LIABILITY),
// created atomically with the Employee, exactly mirroring how Party
// creation atomically creates its own 1:1 Account
// (app/api/parties/route.ts).
//
// Sign convention (LIABILITY side, identical direction to every
// other payable account already in the system):
//   balance = totalCredit - totalDebit on the employee's own account
//   > 0  => payable to the employee (we owe them)
//   = 0  => settled
//   < 0  => paid in advance (we've paid them more than recognized)
//
// Two distinct referenceTypes, never touching Bilty/Challan/
// Settlement/Daily Posting:
//   "PAYROLL_SALARY"  - salary recognition, posted ONCE per payslip
//                        (Dr Salary Expense / Cr Employee Account)
//   "PAYROLL_PAYMENT" - each actual payment, any number of times
//                        (Dr Employee Account / Cr Cash or Bank)
// Both tag their lines JournalLine.sourceType="PAYSLIP",
// sourceId=<payslip.id>, sourceNumber=<payslip.payslipNo> - the SAME
// convention already used for Bilty/Challan - so "paid amount" for a
// given payslip is always DERIVED from real JournalLines, never a
// second, independently-stored balance.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.01;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export class PayrollValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PayrollValidationError";
    this.status = status;
  }
}

// ------------------------------------------------------------
// HUMAN-FRIENDLY, RACE-SAFE SEQUENTIAL IDENTIFIERS
//
// Computed inside the SAME Serializable transaction that creates the
// row - a genuine race is caught by Postgres as a serialization
// failure (P2034) and surfaced as a retryable error, exactly like
// the Manual Journal Number (app/api/journal-entries/route.ts).
// Counts ALL rows including soft-deleted ones, so a number is never
// reused after a Bin action.
// ------------------------------------------------------------

export async function nextEmployeeCode(tx: Tx): Promise<string> {
  const count = await tx.employee.count();
  return `EMP-${String(count + 1).padStart(5, "0")}`;
}

export async function nextPayslipNo(tx: Tx): Promise<string> {
  const count = await tx.payslip.count();
  return `PS-${String(count + 1).padStart(5, "0")}`;
}

// ------------------------------------------------------------
// EMPLOYEE VALIDATION
// ------------------------------------------------------------

export function validateEmployeeInput(input: {
  name: string;
  monthlySalary: number;
  joiningDate?: string;
}): void {
  if (!input.name || !input.name.trim()) {
    throw new PayrollValidationError("Employee name is required.");
  }
  if (typeof input.monthlySalary !== "number" || input.monthlySalary < 0) {
    throw new PayrollValidationError("Monthly salary cannot be negative.");
  }
  if (input.joiningDate) {
    const date = new Date(`${input.joiningDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      throw new PayrollValidationError("Invalid joining date.");
    }
  }
}

// ------------------------------------------------------------
// PAYSLIP VALIDATION
// ------------------------------------------------------------

export function validatePayslipInput(input: {
  grossPay: number;
  deduction: number;
  contribution: number;
  payDate: string;
}): { netPay: number } {
  const grossPay = round2(Number(input.grossPay) || 0);
  const deduction = round2(Number(input.deduction) || 0);
  const contribution = round2(Number(input.contribution) || 0);

  if (grossPay < 0) {
    throw new PayrollValidationError("Gross Pay cannot be negative.");
  }
  if (deduction < 0) {
    throw new PayrollValidationError("Deduction cannot be negative.");
  }
  if (contribution < 0) {
    throw new PayrollValidationError("Contribution cannot be negative.");
  }
  if (deduction > grossPay) {
    throw new PayrollValidationError("Deduction cannot exceed Gross Pay.");
  }

  const netPay = round2(grossPay - deduction);
  if (netPay < 0) {
    throw new PayrollValidationError("Net Pay cannot be negative.");
  }

  const payDate = new Date(`${input.payDate}T00:00:00`);
  if (Number.isNaN(payDate.getTime())) {
    throw new PayrollValidationError("Invalid pay date.");
  }

  return { netPay };
}

export function isValidPayrollMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

// ------------------------------------------------------------
// PAYSLIP PAYMENT STATE - derived purely from JournalLines, never
// stored redundantly (Part 20). "Paid" = sum of DEBITS to the
// employee's own account tagged sourceType:"PAYSLIP", sourceId=this
// payslip, under a PAYROLL_PAYMENT entry specifically (excludes the
// salary-recognition entry's own CREDIT leg to the same account).
// ------------------------------------------------------------

export interface PayslipPaymentState {
  netPay: number;
  paidAmount: number;
  remainingAmount: number;
  status: "Unpaid" | "Partially Paid" | "Paid" | "Paid in Advance";
}

export async function getPayslipPaymentState(
  tx: Tx,
  payslipId: string,
  netPay: number,
  employeeAccountId: string
): Promise<PayslipPaymentState> {
  // CRITICAL: must filter by accountId too - a PAYROLL_PAYMENT entry
  // has TWO lines both tagged sourceType:"PAYSLIP"/sourceId (the
  // employee-account debit leg AND the cash/bank-account credit leg).
  // Without the accountId filter, summing debit-credit across BOTH
  // legs always nets to zero regardless of the real amount paid.
  const paymentLines = await tx.journalLine.findMany({
    where: {
      accountId: employeeAccountId,
      sourceType: "PAYSLIP",
      sourceId: payslipId,
      journalEntry: { referenceType: "PAYROLL_PAYMENT", isDeleted: false },
    },
    select: { debit: true, credit: true },
  });

  const paidAmount = round2(
    paymentLines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0)
  );

  const remainingAmount = round2(netPay - paidAmount);

  let status: PayslipPaymentState["status"];
  if (paidAmount <= EPS) {
    status = "Unpaid";
  } else if (remainingAmount > EPS) {
    status = "Partially Paid";
  } else if (Math.abs(remainingAmount) <= EPS) {
    status = "Paid";
  } else {
    status = "Paid in Advance";
  }

  return { netPay, paidAmount, remainingAmount, status };
}

// ------------------------------------------------------------
// EMPLOYEE OVERALL BALANCE - sum of EVERY JournalLine ever posted to
// the employee's own account, regardless of which payslip (Part 6).
// Positive = payable to them, negative = paid in advance.
// ------------------------------------------------------------

export interface EmployeeBalanceState {
  balance: number;
  status: "No Activity" | "Payable" | "Paid" | "Paid in Advance";
}

export async function getEmployeeBalance(tx: Tx, accountId: string): Promise<EmployeeBalanceState> {
  const lines = await tx.journalLine.findMany({
    where: { accountId, journalEntry: { isDeleted: false } },
    select: { debit: true, credit: true },
  });

  if (lines.length === 0) {
    return { balance: 0, status: "No Activity" };
  }

  const balance = round2(lines.reduce((sum, l) => sum + Number(l.credit) - Number(l.debit), 0));

  let status: EmployeeBalanceState["status"];
  if (balance > EPS) status = "Payable";
  else if (balance < -EPS) status = "Paid in Advance";
  else status = "Paid";

  return { balance, status };
}

// ------------------------------------------------------------
// SALARY RECOGNITION - posted ONCE per payslip, at creation, inside
// the SAME transaction as the Payslip row itself. Debits the Salary
// Expense account, credits the Employee's own account.
// ------------------------------------------------------------

export async function postSalaryRecognition(
  tx: Tx,
  params: {
    payslipId: string;
    payslipNo: string;
    employeeAccountId: string;
    salaryExpenseAccountId: string;
    amount: number;
    entryDate: Date;
    description: string;
    createdById: string | null;
  }
): Promise<void> {
  if (params.amount <= 0) return; // a zero-gross-pay payslip recognizes nothing

  await tx.journalEntry.create({
    data: {
      entryDate: params.entryDate,
      referenceType: "PAYROLL_SALARY",
      referenceId: params.payslipNo,
      description: params.description,
      createdById: params.createdById,
      lines: {
        create: [
          {
            accountId: params.salaryExpenseAccountId,
            description: params.description,
            debit: params.amount,
            credit: 0,
            sourceType: "PAYSLIP",
            sourceId: params.payslipId,
            sourceNumber: params.payslipNo,
          },
          {
            accountId: params.employeeAccountId,
            description: params.description,
            debit: 0,
            credit: params.amount,
            sourceType: "PAYSLIP",
            sourceId: params.payslipId,
            sourceNumber: params.payslipNo,
          },
        ],
      },
    },
  });
}

// ------------------------------------------------------------
// EMPLOYEE LEDGER DATA - the single source of truth read by the
// screen ledger (app/api/employees/[id]/ledger/route.ts) AND both
// exports (ledger/pdf, ledger/excel), so all three can never drift
// out of sync with each other. Reads the employee's own Account's
// real JournalLines directly - not a second ledger table.
// ------------------------------------------------------------

export interface EmployeeLedgerEntry {
  id: string;
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface EmployeeLedgerData {
  employee: { id: string; employeeCode: string; name: string; designation: string | null; accountName: string };
  currentBalance: number;
  currentStatus: EmployeeBalanceState["status"];
  entries: EmployeeLedgerEntry[];
  summary: { openingBalance: number; totalDebit: number; totalCredit: number; closingBalance: number };
}

export async function getEmployeeLedgerData(
  tx: Tx,
  employeeId: string,
  filters: { from?: string | null; to?: string | null; search?: string | null }
): Promise<EmployeeLedgerData | null> {
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    include: { account: { select: { id: true, accountName: true } } },
  });
  if (!employee || !employee.account) return null;

  const accountId = employee.account.id;
  const dateFilter: { gte?: Date; lt?: Date } = {};
  if (filters.from) dateFilter.gte = new Date(`${filters.from}T00:00:00`);
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    dateFilter.lt = end;
  }

  const allLines = await tx.journalLine.findMany({
    where: { accountId, journalEntry: { isDeleted: false } },
    include: { journalEntry: { select: { entryDate: true, referenceType: true, description: true } } },
    orderBy: [{ journalEntry: { entryDate: "asc" } }, { createdAt: "asc" }],
  });

  let openingBalance = 0;
  const inRangeLines = [];
  for (const line of allLines) {
    const entryDate = line.journalEntry.entryDate;
    if (dateFilter.gte && entryDate < dateFilter.gte) {
      openingBalance += Number(line.credit) - Number(line.debit);
      continue;
    }
    if (dateFilter.lt && entryDate >= dateFilter.lt) continue;
    inRangeLines.push(line);
  }
  openingBalance = round2(openingBalance);

  const payslipIds = [...new Set(allLines.map((l) => l.sourceId).filter((v): v is string => !!v))];
  const payslips = payslipIds.length
    ? await tx.payslip.findMany({ where: { id: { in: payslipIds } }, select: { id: true, payrollMonth: true } })
    : [];
  const payslipById = new Map(payslips.map((p) => [p.id, p]));

  let runningBalance = openingBalance;
  const entries: EmployeeLedgerEntry[] = inRangeLines.map((line) => {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    runningBalance = round2(runningBalance + credit - debit);

    let description = line.description || line.journalEntry.description || "—";
    const payslip = line.sourceId ? payslipById.get(line.sourceId) : null;
    if (payslip) {
      const monthLabel = payrollMonthLabel(payslip.payrollMonth);
      if (line.journalEntry.referenceType === "PAYROLL_SALARY") {
        description = `Salary — ${monthLabel}`;
      } else if (line.journalEntry.referenceType === "PAYROLL_PAYMENT") {
        description = `Salary Payment — ${monthLabel}`;
      }
    }

    return { id: line.id, date: line.journalEntry.entryDate.toISOString(), description, debit, credit, balance: runningBalance };
  });

  // Search only narrows which rows are DISPLAYED - Total Debit/Total
  // Credit/Closing Balance below are computed from the FULL (search-
  // unfiltered) period, matching every other ledger's "search must
  // not distort the accounting balance" rule. Each row's own
  // `balance` was already computed above from the full period too,
  // so it stays the true running balance even when displayed within
  // a filtered subset.
  const filteredEntries = filters.search
    ? entries.filter((e) => e.description.toLowerCase().includes(filters.search!.toLowerCase()))
    : entries;

  const totalDebit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const totalCredit = round2(entries.reduce((s, e) => s + e.credit, 0));
  const closingBalance = entries.length > 0 ? entries[entries.length - 1].balance : openingBalance;

  const overallBalance = round2(allLines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0));
  const overallStatus: EmployeeBalanceState["status"] =
    allLines.length === 0 ? "No Activity" : overallBalance > EPS ? "Payable" : overallBalance < -EPS ? "Paid in Advance" : "Paid";

  return {
    employee: {
      id: employee.id,
      employeeCode: employee.employeeCode,
      name: employee.name,
      designation: employee.designation,
      accountName: employee.account.accountName,
    },
    currentBalance: overallBalance,
    currentStatus: overallStatus,
    entries: filteredEntries,
    summary: { openingBalance, totalDebit, totalCredit, closingBalance },
  };
}

export function payrollMonthLabel(payrollMonth: string): string {
  const [year, month] = payrollMonth.split("-").map(Number);
  if (!year || !month) return payrollMonth;
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1))
  );
}
