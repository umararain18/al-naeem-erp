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
 * Account (ASSET/CASH, isSystem: false) + exactly one dedicated Own
 * Carrier Income Account (INCOME/CARRIER_INCOME, isSystem: false) in
 * the SAME transaction - mirroring app/api/parties/route.ts and
 * app/api/employees/route.ts's own Party+Account / Employee+Account
 * creation pattern exactly, so a carrier can never exist without
 * either account and never end up with more than one of each
 * (Account.ownCarrierId / ownCarrierIncomeId are both @unique). The
 * income account is credited only at Trip CLOSE (see
 * lib/carrier-trip.ts's recognizeCarrierTripChallanIncome) - never at
 * dispatch, unlike every other income account in this schema.
 */
export async function createOwnCarrierWithAccount(
  tx: Tx,
  input: {
    carrierNumber: string;
    driverName?: string | null;
    driverPhone?: string | null;
    notes?: string | null;
    currentDriverId?: string | null;
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

  const incomeAccount = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Own Carrier Income`,
      accountType: "INCOME",
      category: "CARRIER_INCOME",
      description: `Automatic Own Carrier Income account for own carrier: ${carrier.carrierNumber} - credited only when a Trip linking one of this carrier's own-carrier Challans is closed.`,
      ownCarrierIncomeId: carrier.id,
      isSystem: false,
      isActive: true,
    },
  });

  return { carrier, account, incomeAccount };
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
      currentDriver: { select: { id: true, name: true } },
    },
  });
  if (!carrier || carrier.isDeleted) {
    throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");
  }
  return carrier;
}

/**
 * Lazy find-or-create for a carrier's own "<carrier> — Own Carrier
 * Income" account - the normal path is createOwnCarrierWithAccount()
 * creating it up front, but this exists as a defensive fallback (same
 * "never hard-fail on a missing system account" precedent as
 * lib/gross-accounts.ts's getOrCreateSystemAccount) for any carrier
 * row that predates this account existing.
 */
export async function getOrCreateOwnCarrierIncomeAccountId(tx: Tx, carrierId: string): Promise<string> {
  const existing = await tx.account.findUnique({ where: { ownCarrierIncomeId: carrierId }, select: { id: true } });
  if (existing) return existing.id;

  const carrier = await tx.ownCarrier.findUnique({ where: { id: carrierId }, select: { carrierNumber: true } });
  if (!carrier) throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");

  const created = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Own Carrier Income`,
      accountType: "INCOME",
      category: "CARRIER_INCOME",
      description: `Automatic Own Carrier Income account for own carrier: ${carrier.carrierNumber} - credited only when a Trip linking one of this carrier's own-carrier Challans is closed.`,
      ownCarrierIncomeId: carrierId,
      isSystem: false,
      isActive: true,
    },
    select: { id: true },
  });
  return created.id;
}
