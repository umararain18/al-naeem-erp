import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveBiltyPaidResponsibleParty } from "@/lib/document-party-resolution";

// ============================================================
// BILTY PAID -> VERIFIED ANC RECEIPT (derived, no new stored state)
//
// "Paid" (Bilty.advance) is recognized from the Bilty at booking
// time and never touches a JournalLine on its own (see
// app/api/bilty/route.ts) - it does NOT mean ANC has actually
// received that cash. Actual receipt is verified ONLY through a
// real Daily Posting: a JournalLine tagged sourceType "BILTY",
// sourceId = this Bilty, crediting the resolved Paid-responsible
// Party's account (Consignor or Consignee - see
// lib/document-party-resolution.ts's resolveBiltyPaidResponsibleParty,
// which is the SAME account this module reads, so a Collection/
// To-Pay posting to a DIFFERENT party - Driver/Clearing Agent/Other
// Party, per the Final Settlement rules - is naturally excluded by
// account, not by any new tagging convention).
//
// This is a PURE READ, derived every time from the existing ledger -
// no new persisted "verified" flag, matching the same philosophy
// getVerifiedAdvance() (lib/settlement-correction.ts /
// app/api/challan/[id]/settle/route.ts) already uses for its own,
// narrower purpose.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.009;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class BiltyPaidVerificationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BiltyPaidVerificationError";
    this.code = code;
  }
}

export interface BiltyPaidVerificationState {
  biltyId: string;
  paidAmount: number;
  responsiblePartyAccountId: string | null;
  responsiblePartyName: string | null;
  verifiedReceivedAmount: number;
  unverifiedAmount: number;
  /** True only if verifiedReceivedAmount somehow exceeds paidAmount -
   * a data inconsistency that must be surfaced explicitly, never
   * silently clamped. Should never occur if every Daily Posting is
   * validated through this same module. */
  isInconsistent: boolean;
}

export async function getBiltyPaidVerification(
  tx: Tx,
  biltyId: string,
  // When set, EXCLUDES this one JournalEntry's own Bilty-tagged lines from
  // the "already verified" sum - used only when EDITING an existing Daily
  // Posting receipt against the SAME Bilty, so the row's own prior amount
  // is not double-counted against itself before the new amount is checked
  // (see assertPaidVerificationNotExceeded below). Never set by Create,
  // which has no existing row to exclude - its behavior is unchanged.
  excludeJournalEntryId?: string
): Promise<BiltyPaidVerificationState> {
  const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { advance: true } });
  const paidAmount = bilty ? round2(Number(bilty.advance)) : 0;

  const responsible = await resolveBiltyPaidResponsibleParty(biltyId, tx);

  // Verified-received must survive a Paid-responsibility reassignment
  // (Consignor -> Consignee, lib/settlement-payments.ts's
  // reassignPaidResponsibility()): an already-verified receipt was
  // posted to whichever account was responsible AT THAT TIME, which
  // may no longer be the CURRENTLY resolved one. Rather than scope
  // this to only the current account (which would make an already-
  // verified receipt vanish the moment responsibility changes), sum
  // Daily-Posting credits across every account that has EVER been
  // tagged by a PAID-component JournalLine for this Bilty
  // (establishment/correction/reversal/reassignment - all real,
  // existing referenceTypes, never description/keyword matching)
  // plus the current one, so history is never lost and nothing is
  // ever double-counted (each Daily Posting line is still counted
  // exactly once, by its own accountId).
  const paidTaggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      journalEntry: {
        isDeleted: false,
        referenceType: {
          in: [
            "SETTLEMENT_PAYMENT",
            "SETTLEMENT_PAYMENT_CORRECTION",
            "SETTLEMENT_PAYMENT_REVERSAL",
            "PAID_RESPONSIBILITY_REASSIGNMENT",
          ],
        },
        ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
      },
      account: { category: "PARTY" },
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  const relevantAccountIds = new Set(paidTaggedLines.map((l) => l.accountId));
  if (responsible) relevantAccountIds.add(responsible.accountId);

  let verifiedReceivedAmount = 0;
  if (relevantAccountIds.size > 0) {
    const lines = await tx.journalLine.findMany({
      where: {
        accountId: { in: [...relevantAccountIds] },
        sourceType: "BILTY",
        sourceId: biltyId,
        journalEntry: {
          referenceType: "DAILY_POSTING",
          isDeleted: false,
          ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
        },
      },
      select: { debit: true, credit: true },
    });
    // Party account CREDIT = money they paid ANC (their balance
    // decreases) - the same direction convention buildLinePair()
    // (app/api/daily-posting/route.ts) already uses for any receipt.
    verifiedReceivedAmount = round2(
      Math.max(0, lines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0))
    );
  }

  const isInconsistent = verifiedReceivedAmount > paidAmount + EPS;
  const unverifiedAmount = isInconsistent ? 0 : Math.max(0, round2(paidAmount - verifiedReceivedAmount));

  return {
    biltyId,
    paidAmount,
    responsiblePartyAccountId: responsible?.accountId || null,
    responsiblePartyName: responsible?.partyName || null,
    verifiedReceivedAmount,
    unverifiedAmount,
    isInconsistent,
  };
}

/**
 * Validates that a NEW Daily Posting receipt of `amount` credited to
 * `counterAccountId` for this Bilty would not verify more than the
 * Paid amount allows. A no-op (never rejects) unless the Counter
 * Account IS the resolved Paid-responsible party AND the posting is
 * a receipt (main account DEBIT, i.e. the party's own line is a
 * CREDIT) - any other Bilty-tagged posting (e.g. to a Collection/
 * To-Pay party) is a different, unrelated destination and is left
 * alone. Must be called with the SAME `tx` the write itself uses, so
 * it is re-checked against live, in-transaction state.
 */
export async function assertPaidVerificationNotExceeded(
  tx: Tx,
  biltyId: string,
  counterAccountId: string,
  amount: number,
  direction: "DEBIT" | "CREDIT",
  // See getBiltyPaidVerification() above - only ever set when EDITING an
  // existing Daily Posting receipt, to exclude its own prior contribution.
  excludeJournalEntryId?: string
): Promise<void> {
  // direction here is the MAIN account's own direction (per Daily
  // Posting's existing convention) - DEBIT means the main account
  // (Cash/Bank) receives money, which credits the counter account
  // (the Party) - i.e. a receipt from them. Only that shape can ever
  // verify a Paid amount.
  if (direction !== "DEBIT") return;

  const state = await getBiltyPaidVerification(tx, biltyId, excludeJournalEntryId);
  if (!state.responsiblePartyAccountId || state.responsiblePartyAccountId !== counterAccountId) return;

  if (state.isInconsistent) {
    throw new BiltyPaidVerificationError(
      "PAID_VERIFICATION_INCONSISTENT",
      `This Bilty's verified ANC receipt (${state.verifiedReceivedAmount}) already exceeds its Paid amount (${state.paidAmount}) - a data inconsistency. Resolve this before posting further receipts.`
    );
  }

  if (round2(state.verifiedReceivedAmount + amount) > state.paidAmount + EPS) {
    throw new BiltyPaidVerificationError(
      "PAID_OVER_VERIFICATION",
      `This receipt of ${round2(amount)} would exceed this Bilty's remaining unverified Paid amount (${state.unverifiedAmount}). Paid = ${state.paidAmount}, already verified = ${state.verifiedReceivedAmount}.`
    );
  }
}
