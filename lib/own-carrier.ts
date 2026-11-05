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

  return { carrier, account, profitAccount, tripInProgressAccount };
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
