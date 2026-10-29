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
 * Account (ASSET/CASH, isSystem: false) in the SAME transaction -
 * mirroring app/api/parties/route.ts and app/api/employees/route.ts's
 * own Party+Account / Employee+Account creation pattern exactly, so a
 * carrier can never exist without its account and never end up with
 * more than one (Account.ownCarrierId is @unique).
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

  return { carrier, account };
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
    include: { driverCashAccount: true, currentDriver: { select: { id: true, name: true } } },
  });
  if (!carrier || carrier.isDeleted) {
    throw new OwnCarrierError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");
  }
  return carrier;
}
