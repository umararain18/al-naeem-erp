import type { Prisma, PrismaClient } from "@prisma/client";
import { getUnearnedRevenueAccountId } from "@/lib/gross-accounts";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// BILTY REVENUE RECOGNITION - Dr Unearned Revenue / Cr Booking
// Income, for the exact amount a Bilty's own booking entry credited
// to Unearned Revenue (see app/api/bilty/route.ts). Fired the moment
// a Bilty is actually DISPATCHED - added to a Challan, whether at
// Challan creation (app/api/challan/route.ts) or via a later edit
// that adds it to an existing Challan (app/api/challan/[id]/route.ts)
// - never at booking time, and never more than once per Bilty.
//
// Idempotency has two independent layers:
//  1. The natural one: a Bilty must be BiltyStatus.PENDING to be
//     added to a Challan at all, and flips to IN_TRANSIT the moment
//     it is - so under normal operation this function is simply never
//     called twice for the same Bilty.
//  2. This function's own explicit guard below, querying for an
//     existing JournalEntry tagged referenceType
//     "BILTY_REVENUE_RECOGNITION" + referenceId = this Bilty's own id
//     (a NEW referenceType value, scoped to the Bilty - not the
//     Challan - so it is unambiguous even if a Bilty were ever somehow
//     re-dispatched). Defense in depth: a retried request, a double
//     dispatch-loop iteration, or any future code path that calls this
//     twice for the same Bilty is still a safe no-op, never a double
//     credit to Booking Income.
// ============================================================

export class BiltyRevenueRecognitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiltyRevenueRecognitionError";
  }
}

export const BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE = "BILTY_REVENUE_RECOGNITION";

/**
 * Returns true if this Bilty's revenue was newly recognized by this
 * call, false if it was a no-op (already recognized, or nothing to
 * recognize because `total` is 0).
 */
export async function recognizeBiltyBookingIncome(
  tx: Tx,
  bilty: { id: string; biltyNo: string; total: Prisma.Decimal | number | string },
  params: { entryDate: Date; challanNo: string; createdById: string }
): Promise<boolean> {
  const total = Number(bilty.total);
  if (total <= 0) return false;

  const alreadyRecognized = await tx.journalEntry.findFirst({
    where: {
      referenceType: BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
      referenceId: bilty.id,
      isDeleted: false,
    },
    select: { id: true },
  });
  if (alreadyRecognized) return false;

  const bookingIncomeAccount = await tx.account.findFirst({
    where: { category: "BOOKING_INCOME", isActive: true },
    select: { id: true },
  });
  if (!bookingIncomeAccount) {
    throw new BiltyRevenueRecognitionError(
      "Required account is not configured. Please configure a BOOKING_INCOME account."
    );
  }

  const unearnedRevenueAccountId = await getUnearnedRevenueAccountId(tx);
  const description = `Revenue Recognition - ${bilty.biltyNo} - dispatched via Challan ${params.challanNo}`;

  await tx.journalEntry.create({
    data: {
      entryDate: params.entryDate,
      referenceType: BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
      referenceId: bilty.id,
      description,
      createdById: params.createdById,
      lines: {
        create: [
          {
            accountId: unearnedRevenueAccountId,
            debit: total,
            credit: 0,
            description,
            sourceType: "BILTY",
            sourceId: bilty.id,
            sourceNumber: bilty.biltyNo,
          },
          {
            accountId: bookingIncomeAccount.id,
            debit: 0,
            credit: total,
            description,
            sourceType: "BILTY",
            sourceId: bilty.id,
            sourceNumber: bilty.biltyNo,
          },
        ],
      },
    },
  });

  return true;
}
