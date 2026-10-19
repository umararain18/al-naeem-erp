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

// Written by scripts/reclass-legacy-bilty-revenue.ts (Dr Booking
// Income / Cr Unearned Revenue) for a Bilty that was booked BEFORE
// this feature existed and therefore credited Booking Income directly
// at booking time instead of Unearned Revenue. Checked below so a
// legacy Bilty that gets dispatched is never double-recognized AND
// never debits Unearned Revenue for an amount it was never credited.
export const BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE = "BILTY_REVENUE_DEFERRAL";

// Written when a dispatched Bilty is un-dispatched again (removed from
// its Challan - see app/api/challan/[id]/route.ts's removeBiltyIds
// handling) - the exact reverse of BILTY_REVENUE_RECOGNITION, Dr
// Booking Income / Cr Unearned Revenue, putting the Bilty's value back
// where it belongs now that it is no longer actually dispatched.
export const BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE = "BILTY_REVENUE_RECOGNITION_REVERSAL";

// NET count (recognitions - reversals, both non-deleted) rather than a
// plain "does any entry exist" check - a Bilty can now legitimately
// cycle through recognize -> reverse -> recognize more than once (e.g.
// Challan delete reverses it, a later Challan re-attach recognizes it
// again; Challan restore re-recognizes after a block-free Bin round
// trip). A simple existence check would wrongly treat the STALE entry
// from a prior cycle as "already recognized"/"already reversed" and
// silently no-op the second cycle. Net > 0 means currently recognized;
// net <= 0 means currently not (initial state, or fully reversed).
async function getRecognitionNet(tx: Tx, biltyId: string): Promise<number> {
  const [recognizedCount, reversedCount] = await Promise.all([
    tx.journalEntry.count({
      where: { referenceType: BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE, referenceId: biltyId, isDeleted: false },
    }),
    tx.journalEntry.count({
      where: { referenceType: BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE, referenceId: biltyId, isDeleted: false },
    }),
  ]);
  return recognizedCount - reversedCount;
}

async function getActiveBookingIncomeAccountId(tx: Tx): Promise<string> {
  const bookingIncomeAccount = await tx.account.findFirst({
    where: { category: "BOOKING_INCOME", isActive: true },
    select: { id: true },
  });
  if (!bookingIncomeAccount) {
    throw new BiltyRevenueRecognitionError(
      "Required account is not configured. Please configure a BOOKING_INCOME account."
    );
  }
  return bookingIncomeAccount.id;
}

// True only for a Bilty whose OWN booking entry (BILTY_BOOKING,
// app/api/bilty/route.ts) credited Booking Income DIRECTLY - i.e. one
// booked before this feature existed - AND that has not since been
// corrected by scripts/reclass-legacy-bilty-revenue.ts. For such a
// Bilty, Booking Income already holds its full value from that
// original entry; Unearned Revenue was never credited for it at all.
// Dispatching it now must NEVER also run the normal Unearned-Revenue-
// to-Booking-Income recognition below - that would debit Unearned
// Revenue for an amount it never received (pushing it toward a
// negative/incorrect balance) and credit Booking Income a SECOND time
// for the same Bilty. A Bilty booked under the current rule (credits
// Unearned Revenue directly) or one already reclassified by the
// script always returns false here and proceeds normally.
async function isUnreclassifiedLegacyBilty(tx: Tx, biltyId: string): Promise<boolean> {
  const bookingEntry = await tx.journalEntry.findFirst({
    where: { referenceType: "BILTY_BOOKING", referenceId: biltyId, isDeleted: false },
    include: { lines: { include: { account: { select: { category: true } } } } },
  });
  const creditedBookingIncomeDirectly = bookingEntry?.lines.some(
    (l) => l.account.category === "BOOKING_INCOME" && Number(l.credit) > 0
  );
  if (!creditedBookingIncomeDirectly) return false;

  const alreadyReclassified = await tx.journalEntry.findFirst({
    where: { referenceType: BILTY_REVENUE_DEFERRAL_REFERENCE_TYPE, referenceId: biltyId, isDeleted: false },
    select: { id: true },
  });
  return !alreadyReclassified;
}

/**
 * Returns true if this Bilty's revenue was newly recognized by this
 * call, false if it was a no-op (already recognized, nothing to
 * recognize because `total` is 0, or a not-yet-reclassified legacy
 * Bilty whose Booking Income is already correctly sitting in its
 * original booking entry - see isUnreclassifiedLegacyBilty() above).
 */
export async function recognizeBiltyBookingIncome(
  tx: Tx,
  bilty: { id: string; biltyNo: string; total: Prisma.Decimal | number | string },
  params: { entryDate: Date; challanNo: string; createdById: string }
): Promise<boolean> {
  const total = Number(bilty.total);
  if (total <= 0) return false;

  const net = await getRecognitionNet(tx, bilty.id);
  if (net > 0) return false;

  if (await isUnreclassifiedLegacyBilty(tx, bilty.id)) return false;

  const bookingIncomeAccountId = await getActiveBookingIncomeAccountId(tx);
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
            accountId: bookingIncomeAccountId,
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

/**
 * The exact reverse of recognizeBiltyBookingIncome() - called when a
 * previously-dispatched Bilty is un-dispatched (removed from its
 * Challan). A no-op (returns false) if this Bilty's revenue was never
 * actually recognized at dispatch in the first place (e.g. a legacy
 * Bilty recognizeBiltyBookingIncome() itself skipped - nothing to put
 * back), or if it was already reversed once (idempotent, via its own
 * dedicated referenceType, the same pattern as the forward direction).
 */
export async function reverseBiltyBookingIncome(
  tx: Tx,
  bilty: { id: string; biltyNo: string },
  params: { entryDate: Date; reason: string; createdById: string }
): Promise<boolean> {
  const net = await getRecognitionNet(tx, bilty.id);
  if (net <= 0) return false;

  // Latest (not just "any") non-deleted recognition entry - a Bilty
  // past its first recognize/reverse cycle can have more than one
  // historical recognition entry; the most recent one is the one
  // currently "in effect" and whose amount must be reversed now.
  const recognitionEntry = await tx.journalEntry.findFirst({
    where: {
      referenceType: BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE,
      referenceId: bilty.id,
      isDeleted: false,
    },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });
  if (!recognitionEntry) return false;

  const bookingIncomeLine = recognitionEntry.lines.find((l) => Number(l.credit) > 0);
  const amount = Number(bookingIncomeLine?.credit ?? 0);
  if (amount <= 0) return false;

  const bookingIncomeAccountId = await getActiveBookingIncomeAccountId(tx);
  const unearnedRevenueAccountId = await getUnearnedRevenueAccountId(tx);
  const description = `Revenue Recognition Reversal - ${bilty.biltyNo} - ${params.reason}`;

  await tx.journalEntry.create({
    data: {
      entryDate: params.entryDate,
      referenceType: BILTY_REVENUE_RECOGNITION_REVERSAL_REFERENCE_TYPE,
      referenceId: bilty.id,
      description,
      createdById: params.createdById,
      lines: {
        create: [
          {
            accountId: bookingIncomeAccountId,
            debit: amount,
            credit: 0,
            description,
            sourceType: "BILTY",
            sourceId: bilty.id,
            sourceNumber: bilty.biltyNo,
          },
          {
            accountId: unearnedRevenueAccountId,
            debit: 0,
            credit: amount,
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
