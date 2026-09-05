import { Decimal } from "@prisma/client/runtime/library";

// ============================================================
// SHARED P&L NETTING HELPER
//
// Both app/api/reports/profit-loss/route.ts and
// app/api/dashboard/route.ts must recognize Income/Expense the
// same way: NET of both sides of the account, not just one side.
//
// A correcting/reversing entry (e.g. a Carrier Rent reduction
// posts a credit against the Expense account; a Bilty rent
// reduction posts a debit against the Income account) must
// actually reduce what's reported - summing only debit (for
// expense) or only credit (for income) silently ignores every
// correction ever posted.
// ============================================================

export interface DebitCreditBalance {
  debit: number;
  credit: number;
}

type LineLike = {
  accountId: string;
  debit: number | string | Decimal;
  credit: number | string | Decimal;
};

function toNumber(value: number | string | Decimal): number {
  if (typeof value === "number") return value;
  if (value instanceof Decimal) return value.toNumber();
  return new Decimal(value).toNumber();
}

export function accumulateBalances(lines: LineLike[]): Map<string, DebitCreditBalance> {
  const balances = new Map<string, DebitCreditBalance>();

  for (const line of lines) {
    const existing = balances.get(line.accountId) || { debit: 0, credit: 0 };
    existing.debit += toNumber(line.debit);
    existing.credit += toNumber(line.credit);
    balances.set(line.accountId, existing);
  }

  return balances;
}

/** Recognized Income for an INCOME-type account: credit - debit. */
export function netIncome(balance: DebitCreditBalance | undefined): number {
  if (!balance) return 0;
  return balance.credit - balance.debit;
}

/** Recognized Expense for an EXPENSE-type account: debit - credit. */
export function netExpense(balance: DebitCreditBalance | undefined): number {
  if (!balance) return 0;
  return balance.debit - balance.credit;
}
