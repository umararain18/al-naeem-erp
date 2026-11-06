import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// LEDGER-TRUE PAID ATTRIBUTION - the one place every caller that
// needs to know "is this Bilty's own Paid amount currently, truly
// attributed to a real party" reads from, instead of asking whether a
// PAID SettlementPayment row merely EXISTS or has isActive: true.
//
// SettlementPayment.isActive is, by design, never flipped for a PAID
// row by Unsettle (see that model's own schema doc comment - PAID is
// "resolved independently of any Challan/Settlement"), and the row's
// own journalEntryId is never updated by a later reassignment either
// (lib/settlement-payments.ts's reassignPaidResponsibility only ever
// changes payerAccountId). Both are therefore unreliable signals for
// "is the underlying ledger entry still live" once something DOES
// reverse that entry at the ledger level - which Unsettle's own
// reverseChallanSettlementEntries (lib/challan-lifecycle.ts) can do,
// tagging its reversal SETTLEMENT_UNSETTLE_REVERSAL (a Challan-level
// referenceType whose own referenceId is the Challan's id, never the
// Bilty's - unusable for the referenceId===biltyId disambiguation the
// PAID establishment/correction entries themselves rely on to stay
// distinct from a Collection-component event sharing the identical
// sourceType:"BILTY"/sourceId tag).
//
// Production signature this closes (Challan 6405 / Bilty 395, DS
// Motors; Challan 6504 / Bilty 4164, MWT -> Zam Zam): Unsettle
// reversed a Paid establishment at the ledger level; every caller
// that trusted "a PAID row exists / isActive" kept believing it was
// still live - reassignPaidResponsibility() released a credit with no
// live debit behind it, and Finalize Settlement's own "already
// established, skip" check never re-established it.
//
// This module is intentionally a LEAF (no imports from this codebase)
// so lib/settlement-payments.ts, lib/bilty-paid-verification.ts, and
// lib/gross-accounts.ts can all import from it without a circular
// dependency (lib/settlement-payments.ts already imports FROM
// lib/bilty-paid-verification.ts).
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.009;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Ledger-true, per account: every JournalLine (tagged sourceType:
 * "BILTY"/sourceId:biltyId) belonging to this Bilty's own Paid-
 * component lineage - its establishment/correction/reassignment
 * entries, PLUS any LIVE entry that reverses one of those, however
 * that reversal itself is tagged (walked via reversesEntryId, never
 * guessed by referenceType membership - see this module's own header
 * comment for why that allowlist approach missed Unsettle's own
 * reversal). A dead original and its live reversal cancel to net 0 by
 * simple debit-credit arithmetic once both are included, with no
 * reversal-mechanism allowlist to keep up to date.
 */
export async function getPaidAccountNetBalances(tx: Tx, biltyId: string): Promise<Map<string, number>> {
  const paidComponentEntries = await tx.journalEntry.findMany({
    where: {
      OR: [
        { referenceType: { in: ["SETTLEMENT_PAYMENT", "SETTLEMENT_PAYMENT_CORRECTION"] }, referenceId: biltyId },
        { referenceType: "PAID_RESPONSIBILITY_REASSIGNMENT", referenceId: biltyId },
      ],
    },
    select: { id: true },
  });
  const paidComponentEntryIds = paidComponentEntries.map((e) => e.id);
  if (paidComponentEntryIds.length === 0) return new Map();

  const reversalEntries = await tx.journalEntry.findMany({
    where: { reversesEntryId: { in: paidComponentEntryIds }, isDeleted: false },
    select: { id: true },
  });

  const relevantEntryIds = [...paidComponentEntryIds, ...reversalEntries.map((e) => e.id)];
  const paidTaggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      journalEntryId: { in: relevantEntryIds },
      journalEntry: { isDeleted: false },
    },
    select: { accountId: true, debit: true, credit: true },
  });
  const byAccount = new Map<string, number>();
  for (const line of paidTaggedLines) {
    const prior = byAccount.get(line.accountId) || 0;
    byAccount.set(line.accountId, round2(prior + Number(line.debit) - Number(line.credit)));
  }
  return byAccount;
}

/**
 * Ledger-true: how much of this Bilty's own Paid amount is CURRENTLY,
 * truly attributed to some real party right now - the sum of every
 * positive (debit/Receivable-like) balance getPaidAccountNetBalances()
 * returns, capped at `paidAmountCap` (a data anomaly must never read
 * as "more than 100% attributed"). 0 when nothing is currently, truly
 * attributed - every caller that used to ask "does a PAID row exist"
 * to decide whether Paid is already handled for this Bilty should ask
 * this instead.
 */
export async function getLedgerTruePaidAttributedAmount(tx: Tx, biltyId: string, paidAmountCap: number): Promise<number> {
  const netBalances = await getPaidAccountNetBalances(tx, biltyId);
  const totalAttributed = round2([...netBalances.values()].filter((v) => v > EPS).reduce((s, v) => s + v, 0));
  return Math.min(round2(paidAmountCap), totalAttributed);
}

/**
 * Batched form of getLedgerTruePaidAttributedAmount() above - a small
 * FIXED number of queries across every Bilty at once instead of 2-3
 * per Bilty, for a list/detail page showing many Bilties together
 * (e.g. getBiltyPaidVerificationBatch in lib/bilty-paid-verification.ts).
 * Returns exactly what the single-item function would have returned
 * for each id, capped at that Bilty's own `paidAmountCapByBiltyId`
 * entry (0 if missing).
 */
export async function getLedgerTruePaidAttributedAmountBatch(
  tx: Tx,
  paidAmountCapByBiltyId: Map<string, number>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const biltyIds = [...paidAmountCapByBiltyId.keys()];
  if (biltyIds.length === 0) return result;

  const paidComponentEntries = await tx.journalEntry.findMany({
    where: {
      OR: [
        { referenceType: { in: ["SETTLEMENT_PAYMENT", "SETTLEMENT_PAYMENT_CORRECTION"] }, referenceId: { in: biltyIds } },
        { referenceType: "PAID_RESPONSIBILITY_REASSIGNMENT", referenceId: { in: biltyIds } },
      ],
    },
    select: { id: true },
  });
  const paidComponentEntryIds = paidComponentEntries.map((e) => e.id);
  if (paidComponentEntryIds.length === 0) return result;

  const reversalEntries = await tx.journalEntry.findMany({
    where: { reversesEntryId: { in: paidComponentEntryIds }, isDeleted: false },
    select: { id: true },
  });
  const relevantEntryIds = [...paidComponentEntryIds, ...reversalEntries.map((e) => e.id)];

  const paidTaggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: { in: biltyIds },
      journalEntryId: { in: relevantEntryIds },
      journalEntry: { isDeleted: false },
    },
    select: { sourceId: true, accountId: true, debit: true, credit: true },
  });

  const netByBiltyAccount = new Map<string, Map<string, number>>();
  for (const line of paidTaggedLines) {
    if (!line.sourceId) continue;
    const byAccount = netByBiltyAccount.get(line.sourceId) || new Map<string, number>();
    const prior = byAccount.get(line.accountId) || 0;
    byAccount.set(line.accountId, round2(prior + Number(line.debit) - Number(line.credit)));
    netByBiltyAccount.set(line.sourceId, byAccount);
  }

  for (const [biltyId, cap] of paidAmountCapByBiltyId) {
    const byAccount = netByBiltyAccount.get(biltyId);
    if (!byAccount) {
      result.set(biltyId, 0);
      continue;
    }
    const totalAttributed = round2([...byAccount.values()].filter((v) => v > EPS).reduce((s, v) => s + v, 0));
    result.set(biltyId, Math.min(round2(cap), totalAttributed));
  }

  return result;
}
