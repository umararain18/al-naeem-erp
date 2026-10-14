import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// OWN CARRIER REGISTER (Phase 1) - see prisma/schema.prisma's own
// module comment for the full design rationale (why this is a new
// master entity, distinct from Party/Challan.transporterPartyId, and
// why Driver Cash is a real ledger Account rather than a stored
// number).
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
 * more than one.
 */
export async function createOwnCarrierWithAccount(
  tx: Tx,
  input: { carrierNumber: string; driverName?: string | null; driverPhone?: string | null; notes?: string | null; createdById: string }
) {
  const carrier = await tx.ownCarrier.create({
    data: {
      carrierNumber: input.carrierNumber,
      driverName: input.driverName || null,
      driverPhone: input.driverPhone || null,
      notes: input.notes || null,
      isActive: true,
      createdById: input.createdById,
    },
  });

  const account = await tx.account.create({
    data: {
      accountName: `${carrier.carrierNumber} — Driver Cash`,
      accountCode: null,
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

/** Convenience default only (like lib/payroll-accounting.ts's nextEmployeeCode()) - the real
 * concurrency guarantee is the @@unique([carrierId, slipNo]) constraint, caught as a Prisma
 * P2002 by the creation route. */
export async function suggestNextSlipNo(tx: Tx, carrierId: string): Promise<string> {
  const count = await tx.carrierSlip.count({ where: { carrierId } });
  return String(count + 1);
}
