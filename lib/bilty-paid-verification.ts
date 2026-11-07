import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveBiltyPaidResponsibleParty } from "@/lib/document-party-resolution";
import { getGrossBiltyReceivableAccountId, getUnclaimedGrossBiltyReceivableTotalAmount } from "@/lib/gross-accounts";
import { getLedgerTruePaidAttributedAmount, getLedgerTruePaidAttributedAmountBatch } from "@/lib/paid-attribution";

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
  /** True when there is nothing to attribute (paidAmount <= 0), or a
   * real PAID SettlementPayment row (Dr responsiblePartyAccountId /
   * Cr Gross Bilty Receivable) already exists for this Bilty - i.e.
   * the Paid amount has actually been MOVED OUT of Gross onto the
   * resolved party's own account, not merely that a party happens to
   * be resolvable. `verifiedReceivedAmount` above only measures Daily
   * Posting credits against the resolved party's account - it stays
   * fully "verified" even when that account was credited with NO
   * offsetting debit ever posted (production Challan 6405 / Bilty
   * 395: Finalize Settlement's own "nothing to settle" path skipped
   * establishing this attribution entirely - see that route's own
   * comment - leaving DS Motors with a false Payable and Gross still
   * holding the full Paid amount, while this state's own
   * unverifiedAmount already read 0). Callers showing a "Paid
   * Verified" badge must gate on isAttributed too, never
   * unverifiedAmount alone. */
  isAttributed: boolean;
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
  //
  // CRITICAL: "SETTLEMENT_PAYMENT"/"..._CORRECTION"/"..._REVERSAL" are
  // NOT exclusive to the Paid component - a Collection ("To-Pay")
  // SettlementPayment lifecycle event uses the IDENTICAL sourceType:
  // "BILTY"/sourceId:<this Bilty> tag (confirmed live - both "Settlement
  // Payment - Bilty 108 Paid - 7000" and "Settlement Payment - Bilty
  // 108 To-Pay - 50000" carry that same tag). The two are reliably
  // distinguished only by the JournalEntry's own referenceId, set at
  // write time by createSettlementPayment() (lib/settlement-payments.ts):
  // a Paid-component event's referenceId is this Bilty's own id; a
  // Collection-component event's referenceId is the Bilty's owning
  // Challan's id. Filtering on this explicit relation (never on
  // description text) is what makes this an accurate PAID-only query -
  // without it, a Collection payer's own real receipts get counted as
  // if they verified the unrelated Paid amount too (confirmed live on
  // Bilty 108: 7,000 Paid + 50,000 Collection receipts wrongly summed
  // to a reported 57,000 "verified").
  const paidTaggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      account: { category: "PARTY" },
      OR: [
        {
          journalEntry: {
            isDeleted: false,
            referenceType: { in: ["SETTLEMENT_PAYMENT", "SETTLEMENT_PAYMENT_CORRECTION", "SETTLEMENT_PAYMENT_REVERSAL"] },
            referenceId: biltyId,
            ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
          },
        },
        // PAID_RESPONSIBILITY_REASSIGNMENT is exclusively a Paid-
        // component referenceType - Collection has no mechanism under
        // this name at all - so it is never ambiguous and needs no
        // referenceId filter.
        {
          journalEntry: {
            isDeleted: false,
            referenceType: "PAID_RESPONSIBILITY_REASSIGNMENT",
            ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
          },
        },
      ],
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

  // A receipt posted directly to Gross Bilty Receivable (never a
  // PARTY account, so never included in relevantAccountIds above) is
  // just as real a verification as one posted to a Paid-responsible
  // Party - see getUnclaimedGrossBiltyReceivableAmount() in
  // lib/gross-accounts.ts, which is what makes that destination
  // eligible for the PAID component in the first place. Scoped to the
  // exact same account/sourceType/sourceId/referenceType/isDeleted
  // shape as the Party-account query above, so it can never double-
  // count a line already counted there (the two account sets are
  // disjoint - Gross is never a PARTY-category account).
  //
  // A Gross-credited receipt may ALSO represent the Collection/To-Pay
  // component now (see getUnclaimedGrossBiltyReceivableAmountForCollection()
  // in lib/gross-accounts.ts) - a Daily Posting line carries no tag
  // distinguishing which component it was for, so this PAID-only
  // verification must never count more of it than the Paid amount
  // itself allows, or a large Collection receipt credited to the same
  // account would wrongly appear to over-verify Paid.
  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  const grossLines = await tx.journalLine.findMany({
    where: {
      accountId: grossAccountId,
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
  const grossVerifiedAmount = round2(
    Math.min(paidAmount, Math.max(0, grossLines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)))
  );
  verifiedReceivedAmount = round2(verifiedReceivedAmount + grossVerifiedAmount);

  const isInconsistent = verifiedReceivedAmount > paidAmount + EPS;
  const unverifiedAmount = isInconsistent ? 0 : Math.max(0, round2(paidAmount - verifiedReceivedAmount));

  // Ledger-true, not "a PAID row exists / isActive" - see
  // lib/paid-attribution.ts's own header comment for why that row-
  // level signal goes stale once Unsettle reverses the underlying
  // entry (production Challan 6405 / Bilty 395).
  //
  // WALK-IN (no resolvable Paid-responsible party at all, `responsible`
  // null): getLedgerTruePaidAttributedAmount only ever looks at
  // SETTLEMENT_PAYMENT*/PAID_RESPONSIBILITY_REASSIGNMENT-tagged
  // entries - a real party-establishment mechanism this Bilty, by
  // definition, never has anything to establish (there is no party to
  // establish it TO; see resolveBiltyPaidResponsibleParty's own null
  // return and getBiltyLegitimatePartyAccountIds's own Gross Bilty
  // Receivable fallback, which is this Bilty's own correct, final
  // destination). For a walk-in, "attributed" instead means "verified
  // straight into Gross" - `grossVerifiedAmount` above already
  // computes exactly that, capped at paidAmount - so a walk-in Bilty
  // whose Paid amount was fully received via a Daily Posting credit to
  // Gross is correctly reported as attributed, never forced through a
  // party it structurally cannot have.
  let isAttributed = paidAmount <= EPS;
  if (!isAttributed && !responsible) {
    isAttributed = grossVerifiedAmount >= paidAmount - EPS;
  } else if (!isAttributed) {
    const attributed = await getLedgerTruePaidAttributedAmount(tx, biltyId, paidAmount);
    isAttributed = attributed >= paidAmount - EPS;
  }

  return {
    biltyId,
    paidAmount,
    responsiblePartyAccountId: responsible?.accountId || null,
    responsiblePartyName: responsible?.partyName || null,
    verifiedReceivedAmount,
    unverifiedAmount,
    isInconsistent,
    isAttributed,
  };
}

// ------------------------------------------------------------
// BATCH - byte-for-byte the SAME computation as getBiltyPaidVerification()
// above, for every Bilty in `biltyIds`, but issuing a small constant
// number of queries total instead of ~6 PER Bilty (2x bilty lookup -
// one here, one duplicated inside resolveBiltyPaidResponsibleParty -
// plus 3 separate JournalLine scans, one of them behind a per-call
// getGrossBiltyReceivableAccountId() lookup). Confirmed the dominant
// cost of GET /api/challan at production-like volume (800 Bilties):
// ~4.2s of a ~4.4s request, almost entirely this one function called
// once per Bilty via Promise.all in computeChallanSettlementSummaryBatch.
// Never used for a single-Bilty, in-transaction write-path check
// (assertPaidVerificationNotExceeded below still calls the single-item
// function, which also supports `excludeJournalEntryId` - meaningless
// in a read-only list context, so this batch form has no such param).
// ------------------------------------------------------------

export async function getBiltyPaidVerificationBatch(
  tx: Tx,
  biltyIds: string[]
): Promise<Map<string, BiltyPaidVerificationState>> {
  const result = new Map<string, BiltyPaidVerificationState>();
  if (biltyIds.length === 0) return result;

  // Replaces BOTH the single `tx.bilty.findUnique` in
  // getBiltyPaidVerification() AND the duplicate one inside
  // resolveBiltyPaidResponsibleParty() - one query, every field
  // either of those two ever needed.
  const bilties = await tx.bilty.findMany({
    where: { id: { in: biltyIds } },
    select: {
      id: true,
      advance: true,
      paidResponsibleParty: { select: { partyName: true, account: { select: { id: true, isActive: true } } } },
      consignorParty: { select: { partyName: true, account: { select: { id: true, isActive: true } } } },
      consigneeParty: { select: { partyName: true, account: { select: { id: true, isActive: true } } } },
    },
  });

  // Pure in-memory port of resolveBiltyPaidResponsibleParty()'s own
  // logic (lib/document-party-resolution.ts) - identical rules, just
  // fed from the single bulk fetch above instead of its own query.
  function resolveResponsible(b: (typeof bilties)[number]): { accountId: string; partyName: string } | null {
    if (Number(b.advance) <= 0) return null;
    if (b.paidResponsibleParty?.account?.id && b.paidResponsibleParty.account.isActive) {
      return { accountId: b.paidResponsibleParty.account.id, partyName: b.paidResponsibleParty.partyName };
    }
    const consignorValid = b.consignorParty?.account?.id && b.consignorParty.account.isActive;
    const consigneeValid = b.consigneeParty?.account?.id && b.consigneeParty.account.isActive;
    if (consignorValid && !consigneeValid) return { accountId: b.consignorParty!.account!.id, partyName: b.consignorParty!.partyName };
    if (consigneeValid && !consignorValid) return { accountId: b.consigneeParty!.account!.id, partyName: b.consigneeParty!.partyName };
    return null;
  }

  const paidAmountByBiltyId = new Map<string, number>();
  const responsibleByBiltyId = new Map<string, { accountId: string; partyName: string } | null>();
  for (const b of bilties) {
    paidAmountByBiltyId.set(b.id, round2(Number(b.advance)));
    responsibleByBiltyId.set(b.id, resolveResponsible(b));
  }

  // paidTaggedLines, for every Bilty at once - same two referenceType
  // shapes as the single-item query's own OR, just fetched together
  // and re-separated in-memory. The first shape's `referenceId: biltyId`
  // (always the SAME id as that line's own sourceId - see this
  // module's header comment) is checked explicitly per-line below,
  // never left to an independent `referenceId: { in: biltyIds }`
  // filter, which could not by itself guarantee a line's sourceId and
  // its OWN journalEntry's referenceId are the SAME Bilty rather than
  // two different ones that both happen to be in this batch.
  const paidTaggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: { in: biltyIds },
      account: { category: "PARTY" },
      journalEntry: {
        isDeleted: false,
        referenceType: { in: ["SETTLEMENT_PAYMENT", "SETTLEMENT_PAYMENT_CORRECTION", "SETTLEMENT_PAYMENT_REVERSAL", "PAID_RESPONSIBILITY_REASSIGNMENT"] },
      },
    },
    select: { accountId: true, sourceId: true, journalEntry: { select: { referenceType: true, referenceId: true } } },
  });

  const relevantAccountIdsByBiltyId = new Map<string, Set<string>>();
  for (const line of paidTaggedLines) {
    if (!line.sourceId) continue;
    const isReassignment = line.journalEntry.referenceType === "PAID_RESPONSIBILITY_REASSIGNMENT";
    if (!isReassignment && line.journalEntry.referenceId !== line.sourceId) continue;
    const set = relevantAccountIdsByBiltyId.get(line.sourceId) || new Set<string>();
    set.add(line.accountId);
    relevantAccountIdsByBiltyId.set(line.sourceId, set);
  }
  for (const [biltyId, responsible] of responsibleByBiltyId) {
    if (!responsible) continue;
    const set = relevantAccountIdsByBiltyId.get(biltyId) || new Set<string>();
    set.add(responsible.accountId);
    relevantAccountIdsByBiltyId.set(biltyId, set);
  }

  // DAILY_POSTING verification lines against any relevant account,
  // for every Bilty at once - fetched WITHOUT an accountId filter
  // (each Bilty's own relevant set differs), filtered against the
  // right Bilty's own set in-memory instead; exactly equivalent to N
  // separate `accountId: { in: relevantAccountIds } ` queries.
  const verificationLines =
    relevantAccountIdsByBiltyId.size > 0
      ? await tx.journalLine.findMany({
          where: {
            sourceType: "BILTY",
            sourceId: { in: [...relevantAccountIdsByBiltyId.keys()] },
            journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
          },
          select: { accountId: true, sourceId: true, debit: true, credit: true },
        })
      : [];
  const partyVerifiedByBiltyId = new Map<string, number>();
  for (const line of verificationLines) {
    if (!line.sourceId) continue;
    const relevant = relevantAccountIdsByBiltyId.get(line.sourceId);
    if (!relevant || !relevant.has(line.accountId)) continue;
    partyVerifiedByBiltyId.set(line.sourceId, (partyVerifiedByBiltyId.get(line.sourceId) || 0) + Number(line.credit) - Number(line.debit));
  }

  // Gross Bilty Receivable receipts - ONE account-id lookup (not one
  // per Bilty) plus ONE query across every Bilty, instead of N+N.
  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  const grossLines = await tx.journalLine.findMany({
    where: {
      accountId: grossAccountId,
      sourceType: "BILTY",
      sourceId: { in: biltyIds },
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
    },
    select: { sourceId: true, debit: true, credit: true },
  });
  const grossNetByBiltyId = new Map<string, number>();
  for (const line of grossLines) {
    if (!line.sourceId) continue;
    grossNetByBiltyId.set(line.sourceId, (grossNetByBiltyId.get(line.sourceId) || 0) + Number(line.credit) - Number(line.debit));
  }

  // Ledger-true attribution, batched - same "isAttributed" check as
  // getBiltyPaidVerification(), never "a PAID row exists / isActive"
  // (see lib/paid-attribution.ts's own header comment for why that
  // row-level signal goes stale once Unsettle reverses the underlying
  // entry).
  const attributedAmountByBiltyId = await getLedgerTruePaidAttributedAmountBatch(tx, paidAmountByBiltyId);

  for (const biltyId of biltyIds) {
    const paidAmount = paidAmountByBiltyId.get(biltyId) ?? 0;
    const responsible = responsibleByBiltyId.get(biltyId) ?? null;

    const partyVerifiedAmount = round2(Math.max(0, partyVerifiedByBiltyId.get(biltyId) || 0));
    const grossVerifiedAmount = round2(Math.min(paidAmount, Math.max(0, grossNetByBiltyId.get(biltyId) || 0)));
    const verifiedReceivedAmount = round2(partyVerifiedAmount + grossVerifiedAmount);

    const isInconsistent = verifiedReceivedAmount > paidAmount + EPS;
    const unverifiedAmount = isInconsistent ? 0 : Math.max(0, round2(paidAmount - verifiedReceivedAmount));
    // WALK-IN (no resolvable Paid-responsible party) - see
    // getBiltyPaidVerification's own identical comment above.
    // `getLedgerTruePaidAttributedAmountBatch` only ever sees a real
    // party-establishment mechanism this Bilty structurally cannot
    // have, so attribution instead means "verified straight into
    // Gross" (grossVerifiedAmount, already capped at paidAmount).
    const isAttributed =
      paidAmount <= EPS ||
      (responsible
        ? (attributedAmountByBiltyId.get(biltyId) ?? 0) >= paidAmount - EPS
        : grossVerifiedAmount >= paidAmount - EPS);

    result.set(biltyId, {
      biltyId,
      paidAmount,
      responsiblePartyAccountId: responsible?.accountId || null,
      responsiblePartyName: responsible?.partyName || null,
      verifiedReceivedAmount,
      unverifiedAmount,
      isInconsistent,
      isAttributed,
    });
  }

  return result;
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

  // Gross Bilty Receivable is not a Party account, so it can never
  // match state.responsiblePartyAccountId below - it needs its own
  // cap. A receipt credited here may represent EITHER the Paid or the
  // Collection/To-Pay component (a Daily Posting line carries no
  // separate tag distinguishing which), so the ceiling is the Bilty's
  // full total genuinely unclaimed balance - see
  // getUnclaimedGrossBiltyReceivableTotalAmount() in
  // lib/gross-accounts.ts, which both the Paid-side and the
  // Collection-side auto-resolve candidates in lib/document-party-
  // resolution.ts individually cap below (at advance / at toPay
  // respectively), so this combined ceiling can never disagree with
  // either of them about how much is genuinely still sitting there.
  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  if (counterAccountId === grossAccountId) {
    const unclaimed = await getUnclaimedGrossBiltyReceivableTotalAmount(tx, biltyId, excludeJournalEntryId);
    if (round2(amount) > unclaimed + EPS) {
      throw new BiltyPaidVerificationError(
        "GROSS_RECEIVABLE_OVER_RECEIPT",
        `This receipt of ${round2(amount)} would exceed this Bilty's genuinely unclaimed Gross Bilty Receivable balance (${unclaimed}).`
      );
    }
    return;
  }

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
