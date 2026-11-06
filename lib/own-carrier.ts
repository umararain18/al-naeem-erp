import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// OWN CARRIER - carrier-level helpers (create/bin/restore, Driver
// Cash account). Trip/line-level logic lives in lib/carrier-trip.ts.
// See prisma/schema.prisma's own module comment for the full design
// rationale.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export class OwnCarrierError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OwnCarrierError";
    this.code = code;
  }
}

/**
 * Creates exactly one OwnCarrier + exactly one dedicated Driver Cash
 * Account (ASSET/CASH, isSystem: false) + exactly one dedicated
 * Carrier Profit Account (INCOME/CARRIER_INCOME, isSystem: false) in
 * the SAME transaction - mirroring app/api/parties/route.ts and
 * app/api/employees/route.ts's own Party+Account / Employee+Account
 * creation pattern exactly, so a carrier can never exist without
 * either account and never end up with more than one of each
 * (Account.ownCarrierId / ownCarrierIncomeId are both @unique - the
 * Prisma field/relation names were never renamed when this became
 * "Carrier Profit" instead of "Own Carrier Income", only the account's
 * own display name/description and what posts to it - see
 * lib/carrier-trip.ts's own module comment for the current design).
 * ONE account nets the whole carrier's profit: credited with Carrier
 * Rent at Trip CLOSE (lib/carrier-trip.ts's
 * recognizeCarrierTripChallanIncome), debited with every trip expense
 * and driver salary (postExpenseCashLine/postExpenseOfficeLine/
 * postExpenseCreditLine/postDriverSalaryLine) - its own net balance
 * IS the carrier's profit, and (being accountType INCOME) already
 * shows as its own P&L line via the existing, fully generic
 * app/api/reports/profit-loss/route.ts, no report code required.
 */
export async function createOwnCarrierWithAccount(
  tx: Tx,
  input: {
    carrierNumber: string;
    driverName?: string | null;
    driverPhone?: string | null;
    notes?: string | null;
    currentDriverId?: string | null;
    defaultPumpPartyId?: string | null;
    defaultPaidFrom?: string | null;
    createdById: string;
  }
) {
  const carrier = await tx.ownCarrier.create({
    data: {
      carrierNumber: input.carrierNumber,
      driverName: input.driverName || null,
      driverPhone: input.driverPhone || null,
      notes: input.notes || null,
      currentDriverId: input.currentDriverId || null,
      defaultPumpPartyId: input.defaultPumpPartyId || null,
      defaultPaidFrom: input.defaultPaidFrom || null,
      isActive: true,
      createdById: input.createdById,
    },
  });

  const account = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Driver Cash`,
      accountType: "ASSET",
      category: "CASH",
      description: `Automatic Driver Cash account for own carrier: ${carrier.carrierNumber}`,
      ownCarrierId: carrier.id,
      isSystem: false,
      isActive: true,
    },
  });

  const profitAccount = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Carrier Profit`,
      accountType: "INCOME",
      category: "CARRIER_INCOME",
      description: `Automatic Carrier Profit account for own carrier: ${carrier.carrierNumber} - credited with Carrier Rent and debited with every trip expense and driver salary, both ONLY at Trip close (see "Trip in Progress" below for where these sit while a Trip is still open). Its own net balance IS this carrier's profit.`,
      ownCarrierIncomeId: carrier.id,
      isSystem: false,
      isActive: true,
    },
  });

  const tripInProgressAccount = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Trip in Progress`,
      accountType: "ASSET",
      category: "OTHER_ASSET",
      description: `Automatic clearing account for own carrier: ${carrier.carrierNumber} - every OPEN Trip's own expense/diesel/salary lines debit this account instead of Carrier Profit directly, so an open Trip's own expenses never show in P&L. Trip CLOSE moves the Trip's total expense from here into Carrier Profit in one entry (Dr Carrier Profit / Cr Trip in Progress); Reopen reverses it.`,
      ownCarrierTripInProgressId: carrier.id,
      isSystem: false,
      isActive: true,
    },
  });

  const salaryPayableAccount = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Driver Salary Payable`,
      accountType: "LIABILITY",
      category: "EMPLOYEE_PAYABLE",
      description: `Automatic Driver Salary Payable account for own carrier: ${carrier.carrierNumber} - credited (increased) by the day-based salary accrual at Trip CLOSE and by "Allocate idle salary"; debited (decreased) whenever salary is actually paid out. Its own net balance IS what is currently owed to the driver.`,
      ownCarrierSalaryPayableId: carrier.id,
      isSystem: false,
      isActive: true,
    },
  });

  return { carrier, account, profitAccount, tripInProgressAccount, salaryPayableAccount };
}

/**
 * Driver Cash's own running balance - always derived live from the
 * real ledger (debit - credit, same ASSET-account convention as
 * Office Cash), never a second, independently-tracked number. One
 * continuous balance across every Trip (see CarrierTrip.status's own
 * doc comment) - closing one Trip never resets it.
 */
export async function getDriverCashBalance(tx: Tx, accountId: string): Promise<number> {
  const result = await tx.journalLine.aggregate({
    where: { accountId, journalEntry: { isDeleted: false } },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(result._sum.debit || 0);
  const credit = Number(result._sum.credit || 0);
  return Math.round((debit - credit) * 100) / 100;
}

export async function getOwnCarrierOrThrow(tx: Tx, carrierId: string) {
  const carrier = await tx.ownCarrier.findUnique({
    where: { id: carrierId },
    include: {
      driverCashAccount: true,
      ownCarrierIncomeAccount: true,
      tripInProgressAccount: true,
      salaryPayableAccount: true,
      currentDriver: { select: { id: true, name: true } },
    },
  });
  if (!carrier || carrier.isDeleted) {
    throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");
  }
  return carrier;
}

/**
 * Lazy find-or-create for a carrier's own "<carrier> — Carrier
 * Profit" account - the normal path is createOwnCarrierWithAccount()
 * creating it up front, but this exists as a defensive fallback (same
 * "never hard-fail on a missing system account" precedent as
 * lib/gross-accounts.ts's getOrCreateSystemAccount) for any carrier
 * row that predates this account existing.
 */
export async function getOrCreateCarrierProfitAccountId(tx: Tx, carrierId: string): Promise<string> {
  const existing = await tx.account.findUnique({ where: { ownCarrierIncomeId: carrierId }, select: { id: true } });
  if (existing) return existing.id;

  const carrier = await tx.ownCarrier.findUnique({ where: { id: carrierId }, select: { carrierNumber: true } });
  if (!carrier) throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");

  const created = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Carrier Profit`,
      accountType: "INCOME",
      category: "CARRIER_INCOME",
      description: `Automatic Carrier Profit account for own carrier: ${carrier.carrierNumber} - credited with Carrier Rent at Trip close, debited with every trip expense and driver salary.`,
      ownCarrierIncomeId: carrierId,
      isSystem: false,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Lazy find-or-create for a carrier's own "<carrier> — Trip in
 * Progress" clearing account - same defensive-fallback precedent as
 * getOrCreateCarrierProfitAccountId above, for any carrier row that
 * predates this account existing.
 */
export async function getOrCreateTripInProgressAccountId(tx: Tx, carrierId: string): Promise<string> {
  const existing = await tx.account.findUnique({ where: { ownCarrierTripInProgressId: carrierId }, select: { id: true } });
  if (existing) return existing.id;

  const carrier = await tx.ownCarrier.findUnique({ where: { id: carrierId }, select: { carrierNumber: true } });
  if (!carrier) throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");

  const created = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Trip in Progress`,
      accountType: "ASSET",
      category: "OTHER_ASSET",
      description: `Automatic clearing account for own carrier: ${carrier.carrierNumber} - every OPEN Trip's own expense/diesel/salary lines debit this account instead of Carrier Profit directly, so an open Trip's own expenses never show in P&L.`,
      ownCarrierTripInProgressId: carrierId,
      isSystem: false,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Lazy find-or-create for a carrier's own "<carrier> — Driver Salary
 * Payable" account - same defensive-fallback precedent as
 * getOrCreateCarrierProfitAccountId/getOrCreateTripInProgressAccountId
 * above, for any carrier row that predates this account existing.
 */
export async function getOrCreateDriverSalaryPayableAccountId(tx: Tx, carrierId: string): Promise<string> {
  const existing = await tx.account.findUnique({ where: { ownCarrierSalaryPayableId: carrierId }, select: { id: true } });
  if (existing) return existing.id;

  const carrier = await tx.ownCarrier.findUnique({ where: { id: carrierId }, select: { carrierNumber: true } });
  if (!carrier) throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");

  const created = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Driver Salary Payable`,
      accountType: "LIABILITY",
      category: "EMPLOYEE_PAYABLE",
      description: `Automatic Driver Salary Payable account for own carrier: ${carrier.carrierNumber} - credited (increased) by the day-based salary accrual at Trip CLOSE and by "Allocate idle salary"; debited (decreased) whenever salary is actually paid out.`,
      ownCarrierSalaryPayableId: carrierId,
      isSystem: false,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

// ============================================================
// ENGINE OIL STOCK (Own Carrier Part 3) - a single, global (never
// per-carrier) system account. Current stock liters and the moving
// weighted-average rate are both derived live from JournalLine.
// liters/ratePerLiter across every live line on this account tagged
// sourceType "ENGINE_OIL" - never a separate inventory table (see
// that field's own schema doc comment).
// ============================================================

const ENGINE_OIL_STOCK_ACCOUNT_CODE = "ENGINE-OIL-STOCK";
export const ENGINE_OIL_SOURCE_TYPE = "ENGINE_OIL";

export async function getOrCreateEngineOilStockAccountId(tx: Tx): Promise<string> {
  const existing = await tx.account.findFirst({
    where: { accountCode: ENGINE_OIL_STOCK_ACCOUNT_CODE, isSystem: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await tx.account.create({
    data: {
      accountName: "Engine Oil Stock",
      accountCode: ENGINE_OIL_STOCK_ACCOUNT_CODE,
      accountType: "ASSET",
      category: "OTHER_ASSET",
      description: "Engine Oil inventory, valued at a moving weighted-average rate - debited (liters + Rs) on purchase (Daily Posting), credited (liters + Rs, at the CURRENT average rate) on issue to a Trip at CLOSE.",
      isSystem: true,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

export interface EngineOilStockState {
  accountId: string;
  liters: number;
  /** Rs value of the remaining stock - debit minus credit on the
   * account itself, the real ledger balance (never liters × rate
   * computed independently - this IS the numerator rate is derived
   * from). */
  valueRs: number;
  /** valueRs / liters - null when liters is 0 (nothing in stock, rate
   * is undefined) or negative (a data inconsistency: more issued than
   * ever purchased - never divided by a non-positive quantity). */
  avgRatePerLiter: number | null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Reads Engine Oil Stock's own current state straight from the
 * ledger: every live JournalLine on this account (both the Rs amount
 * AND its own liters) summed debit-minus-credit. A purchase posted
 * WITHOUT liters (e.g. a generic Journal Entry, never Daily Posting's
 * own dedicated fields) contributes to valueRs but not to liters -
 * documented as the one way liters tracking can under-count, never
 * silently guessed around.
 */
export async function getEngineOilStockState(tx: Tx): Promise<EngineOilStockState> {
  const accountId = await getOrCreateEngineOilStockAccountId(tx);
  // `liters` is always a plain positive magnitude on every line (same
  // convention as debit/credit themselves) - net stock liters is
  // therefore debit-liters MINUS credit-liters, never a blind sum,
  // read row-by-row (purchase/issue counts stay low enough that this
  // never needs a second aggregate query).
  const lines = await tx.journalLine.findMany({
    where: { accountId, journalEntry: { isDeleted: false } },
    select: { debit: true, credit: true, liters: true },
  });
  let valueRs = 0;
  let liters = 0;
  for (const l of lines) {
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    valueRs += debit - credit;
    if (l.liters != null) liters += debit > 0 ? Number(l.liters) : -Number(l.liters);
  }
  valueRs = round2(valueRs);
  liters = round2(liters);
  const avgRatePerLiter = liters > 0.009 ? round2(valueRs / liters) : null;
  return { accountId, liters, valueRs, avgRatePerLiter };
}

// ============================================================
// OWNER_DRAWING / OFFICE_OVERHEAD trip lines (lib/carrier-trip.ts) -
// see CarrierTripLine.expenseAccountId's own schema doc comment for
// why both reuse that one column.
// ============================================================

const DEFAULT_OWNER_DRAWING_ACCOUNT_CODE = "OWNER-DRAWINGS-DEFAULT";

/**
 * Lazy find-or-create for the ONE default Owner Drawings account
 * ("Owner Drawings - Naeem Shb") - a global, non-per-carrier system
 * account (isSystem: true, found/kept by accountCode, same precedent
 * as lib/gross-accounts.ts's getOrCreateSystemAccount), auto-created
 * on first use rather than requiring a manual Accounts-page setup
 * step. Only ever used as OWNER_DRAWING's own DEFAULT selection - the
 * UI still lets a different OWNER_DRAWING-category account be picked
 * instead (e.g. a second owner), so this is never the only valid
 * choice, just the one that always exists.
 */
export async function getOrCreateDefaultOwnerDrawingAccountId(tx: Tx): Promise<string> {
  const existing = await tx.account.findFirst({
    where: { accountCode: DEFAULT_OWNER_DRAWING_ACCOUNT_CODE, isSystem: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await tx.account.create({
    data: {
      accountName: "Owner Drawings - Naeem Shb",
      accountCode: DEFAULT_OWNER_DRAWING_ACCOUNT_CODE,
      accountType: "EQUITY",
      category: "OWNER_DRAWING",
      description: "Default Owner Drawings account - debited for the Owner's own personal expenses taken from a carrier's Driver Cash (OWNER_DRAWING trip lines). Never a cost of running any trip.",
      isSystem: true,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * True for an Account that may be selected as an OFFICE_OVERHEAD trip
 * line's own Dr target - any ACTIVE EXPENSE-type Account that does
 * NOT belong to a specific carrier (not Driver Cash, not Carrier
 * Profit, not Trip in Progress). Deliberately excludes every
 * carrier-specific account so an office overhead expense (Kitchen,
 * Office Repair, Utility, ...) can never be miscategorized as, or
 * collide with, a carrier's own trip accounting.
 */
export function isEligibleOfficeOverheadAccount(account: {
  accountType: string;
  isActive: boolean;
  ownCarrierId: string | null;
  ownCarrierIncomeId: string | null;
  ownCarrierTripInProgressId: string | null;
}): boolean {
  return (
    account.accountType === "EXPENSE" &&
    account.isActive &&
    account.ownCarrierId === null &&
    account.ownCarrierIncomeId === null &&
    account.ownCarrierTripInProgressId === null
  );
}
