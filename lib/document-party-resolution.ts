import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findSettledPartyAccountId } from "@/lib/settlement-correction";
import { getActiveSettlementPayers } from "@/lib/settlement-payments";
import { computeChallanSettlementSummary } from "@/lib/challan-settlement-summary";
import {
  getGrossBiltyReceivableAccountId,
  getUnclaimedGrossBiltyReceivableAmount,
  getUnclaimedGrossBiltyReceivableAmountForCollection,
} from "@/lib/gross-accounts";
import { resolveBillClientAccountId } from "@/lib/bill-accounting";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// DOCUMENT -> PARTY ACCOUNT RESOLUTION
//
// For Daily Posting, a receipt/payment linked to a Challan or
// Bilty should not force the user to re-select the party the
// document already identifies. This resolves that party from the
// ledger/records already in place - it never guesses when more
// than one distinct party is genuinely involved, since that would
// risk misattributing money to the wrong Party Ledger.
//
// Resolution is intentionally conservative:
//  - BILTY: prefer the established Settlement responsibility for
//    that Bilty's own Collection component (reusing the same
//    ledger lookup Settlement corrections already rely on);
//    fall back to the Bilty's directly-assigned Clearing Agent.
//  - CHALLAN: prefer a single distinct PARTY account across the
//    Challan's entire settlement (covers the common case where
//    one party - e.g. the Clearing Agent - is responsible for
//    everything); fall back to the Clearing Agent shared by all
//    of the Challan's Bilties, if they all agree.
//
// If nothing can be resolved unambiguously, returns null and the
// caller must require a manually-selected Counter Account, exactly
// as before this feature existed.
// ============================================================

export interface ResolvedDocumentParty {
  accountId: string;
  partyName: string;
}

async function resolveBiltyParty(
  biltyId: string,
  direction: "DEBIT" | "CREDIT" | undefined
): Promise<ResolvedDocumentParty | null> {
  const bilty = await prisma.bilty.findUnique({
    where: { id: biltyId },
    select: {
      challanBilties: {
        where: { challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: {
          challan: {
            select: { id: true, isSettled: true, settlementJournalEntryId: true },
          },
        },
      },
    },
  });

  if (!bilty) return null;

  const activeChallan = bilty.challanBilties[0]?.challan;

  // Collection/To-Pay side - the existing, unmodified resolution
  // chain, just no longer returning early so it can be combined with
  // the Paid-responsible side below (see the precedence rule there).
  let collectionResult: ResolvedDocumentParty | null = null;
  // Tracks whether collectionResult (once set) represents an actual
  // POSTED accounting fact (a real SettlementPayment row, or a real
  // settled JournalLine) versus only the speculative, not-yet-posted
  // direct Clearing Agent fallback below - see its use just before
  // the final candidates check for why this distinction matters.
  let collectionResultIsPosted = false;

  // Prefer the new multi-payer engine's own explicit rows (lib/
  // settlement-payments.ts) when this Bilty has any Collection
  // payment rows recorded - never guess which of several distinct
  // payers a posting is for. Falls through to the existing,
  // unmodified historical resolution below when no such rows exist,
  // so a Bilty that never used the multi-payer engine behaves
  // exactly as before this feature existed.
  if (activeChallan) {
    const payers = await getActiveSettlementPayers(prisma, "COLLECTION", {
      challanId: activeChallan.id,
      biltyId,
    });
    if (payers.length === 1) {
      const account = await prisma.account.findUnique({
        where: { id: payers[0].payerAccountId },
        select: { party: { select: { partyName: true } } },
      });
      collectionResult = { accountId: payers[0].payerAccountId, partyName: account?.party?.partyName || "Party" };
      collectionResultIsPosted = true;
    } else if (payers.length > 1) {
      // Several distinct payers already established for this Bilty's
      // Collection - which one a Daily Posting is really for cannot
      // be inferred. Require a manually-selected Counter Account,
      // exactly as the caller already does for any other ambiguity -
      // this is inherently unresolvable regardless of the Paid side,
      // so it stops here exactly as before this change.
      return null;
    }
  }

  if (!collectionResult && activeChallan?.isSettled && activeChallan.settlementJournalEntryId) {
    const bookingIncomeAccount = await prisma.account.findFirst({
      where: { category: "BOOKING_INCOME", isActive: true },
      select: { id: true },
    });

    if (bookingIncomeAccount) {
      const partyAccountId = await findSettledPartyAccountId(
        prisma,
        activeChallan.id,
        activeChallan.settlementJournalEntryId,
        "COLLECTION",
        bookingIncomeAccount.id,
        biltyId
      );

      if (partyAccountId) {
        const account = await prisma.account.findUnique({
          where: { id: partyAccountId },
          select: { party: { select: { partyName: true } } },
        });

        collectionResult = { accountId: partyAccountId, partyName: account?.party?.partyName || "Party" };
        collectionResultIsPosted = true;
      }
    }
  }

  // No real Collection destination established yet (no multi-payer
  // rows, no historical settled-party lookup) - per the LOCKED rule,
  // the Counter Account must trace to whatever account was ACTUALLY
  // debited in this Bilty's own original booking entry (app/api/
  // bilty/route.ts: "Dr Gross Bilty Receivable / Cr Booking Income"
  // for the FULL total, before any Party is known), never a guess at
  // the Transporter/Clearing Agent merely because they are named on
  // the Challan. Until a real Settlement reclassification moves this
  // Bilty's Collection/To-Pay amount out of Gross Bilty Receivable
  // into a real Party's account (the collectionResultIsPosted===true
  // branches above), the money is still genuinely sitting there - so
  // that is the correct Counter Account, RECEIPT (DEBIT) only, exactly
  // mirroring the Paid-side's own Gross candidate below. See
  // getUnclaimedGrossBiltyReceivableAmountForCollection() in
  // lib/gross-accounts.ts for the exact same Bilty.toPay cap the
  // ceiling check (assertPaidVerificationNotExceeded) re-enforces at
  // write time.
  //
  // NOTE: this candidate is deliberately left with
  // collectionResultIsPosted === false - it reflects where the money
  // CURRENTLY sits, not a prediction of who will eventually be
  // responsible, but it must still defer to a genuinely-established,
  // different candidate below that represents a separate, non-
  // overlapping amount of the same Bilty (the still-unclaimed Paid
  // slice vs. this Bilty's own outstanding To-Pay).
  if (!collectionResult && direction === "DEBIT") {
    const unclaimedForCollection = await getUnclaimedGrossBiltyReceivableAmountForCollection(prisma, biltyId);
    if (unclaimedForCollection > 0.01) {
      collectionResult = {
        accountId: await getGrossBiltyReceivableAccountId(prisma),
        partyName: "Gross Bilty Receivable (Unallocated)",
      };
    }
  }

  // Paid-responsible side - a DIFFERENT accounting component (see
  // resolveBiltyPaidResponsibleParty()'s own module-level reasoning
  // below). Resolved independently of Collection above - never
  // derived from it, never merged into it.
  const paidResult = await resolveBiltyPaidResponsibleParty(biltyId);

  // Gross Bilty Receivable (Unallocated) - RECEIPT only, and only
  // when no real Party already holds the Paid amount. See
  // resolveUnclaimedGrossBiltyReceivable()'s own reasoning below.
  // Never consulted for PAYMENT/CREDIT - that direction has no
  // legitimate destination in this account at all.
  let grossReceivableResult: ResolvedDocumentParty | null = null;
  if (direction === "DEBIT" && !paidResult) {
    grossReceivableResult = await resolveUnclaimedGrossBiltyReceivable(biltyId);
  }

  // A speculative, not-yet-posted Collection candidate (the direct
  // Clearing Agent fallback above) must never block a genuinely
  // established candidate for a DIFFERENT component of the same
  // Bilty - the Paid-responsible Party, or the genuinely unclaimed
  // Gross Bilty Receivable balance. Both represent the Paid slice,
  // which is economically separate from the (still merely predicted)
  // outstanding To-Pay Collection responsibility - so there is no
  // real conflict to guess between here, only two independent facts
  // about two different amounts. `paidResult` and
  // `grossReceivableResult` can never both be set (the latter is
  // gated on `!paidResult` above), so at most one of them is present.
  if (collectionResult && !collectionResultIsPosted && (paidResult || grossReceivableResult)) {
    return paidResult || grossReceivableResult;
  }

  // Never guess when more than one distinct, non-agreeing candidate
  // is genuinely resolved - same rule already applied above for
  // multiple Collection payers, generalized across all three
  // independent components a Bilty can have a legitimate destination
  // for. Exactly one candidate (of any kind) auto-selects; several
  // that disagree require a manually-selected Counter Account.
  const candidates = [collectionResult, paidResult, grossReceivableResult].filter(
    (candidate): candidate is ResolvedDocumentParty => candidate !== null
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const firstAccountId = candidates[0].accountId;
  return candidates.every((candidate) => candidate.accountId === firstAccountId) ? candidates[0] : null;
}

// ============================================================
// BILTY -> GROSS BILTY RECEIVABLE (UNCLAIMED PAID PORTION)
//
// A PAID Bilty's Paid amount is reclassified out of Gross Bilty
// Receivable into a real Party's own account ONLY when
// resolveBiltyPaidResponsibleParty() above finds one (an explicit
// Bilty.paidResponsiblePartyId, or exactly one of Consignor/
// Consignee with a real account). When no such Party exists, the
// Paid amount has nowhere else to go and remains sitting, genuinely
// unclaimed, in Gross Bilty Receivable itself - the SAME account
// Booking Income's offsetting Dr already used at booking time (see
// lib/gross-accounts.ts). This resolves exactly that narrow case:
//
//  - RECEIPT only (checked by the caller via `direction` before this
//    is ever invoked) - Gross Bilty Receivable is never a Payable
//    destination, so it must never be offered for a PAYMENT.
//  - Only up to Bilty.advance (the Paid amount) - never the To-Pay
//    portion, which remains Settlement's business alone (per the
//    LOCKED rule: Paid is not a Collection amount).
//  - Only when the account's OWN ledger balance for this specific
//    Bilty (JournalLine.sourceType="BILTY"/sourceId=biltyId) is
//    still genuinely positive - so once a real Party is later
//    established (Settlement, or an explicit reassignment) and the
//    balance is reclassified away, this naturally stops resolving
//    without needing to re-check anything else.
//
// No new balance calculation model is introduced - this reads the
// exact same JournalLine ledger every other resolver in this file
// already reads, scoped to the one account Bilty creation itself
// wrote to.
// ============================================================

async function resolveUnclaimedGrossBiltyReceivable(biltyId: string): Promise<ResolvedDocumentParty | null> {
  const unclaimed = await getUnclaimedGrossBiltyReceivableAmount(prisma, biltyId);
  if (unclaimed <= 0.01) return null;

  const grossAccountId = await getGrossBiltyReceivableAccountId(prisma);
  return { accountId: grossAccountId, partyName: "Gross Bilty Receivable (Unallocated)" };
}

// ============================================================
// CHALLAN -> COUNTERPARTY (LOCKED RULE)
//
// The counterparty for a Challan-linked Daily Posting line is
// resolved from TWO things only: the transaction's direction, and
// the Challan's CURRENTLY OUTSTANDING accounting position - NEVER
// from a party's ROLE on the Challan (Transporter, Clearing Agent,
// etc.) merely because that party is present on the document.
//
// direction (mirrors app/api/daily-posting/route.ts's own
// DEBIT/CREDIT contract exactly - "DEBIT: Main Account receives
// money" = a RECEIPT, "CREDIT: Main Account pays money" = a PAYMENT):
//   DEBIT  (RECEIPT) -> eligible parties = those with an outstanding
//           RECEIVABLE against this Challan.
//   CREDIT (PAYMENT) -> eligible parties = those with an outstanding
//           PAYABLE against this Challan.
//
// Eligibility is read from computeChallanSettlementSummary()'s own
// `partyNet` (lib/challan-settlement-summary.ts) - the SAME
// authoritative source the Challan Detail "Party Net Position" panel
// and Final Settlement itself already read. This is DELIBERATELY NOT
// getChallanResponsibleParties() below, which sums only the raw
// Settlement JournalLines: that misses a Carrier Rent liability split
// across multiple payers via the multi-payer engine (e.g. a Clearing
// Agent attributed part of the Carrier Rent, the Transporter left
// owed the remainder - both real, currently-outstanding Payables) and
// does not reduce a party's balance for a Daily Posting payment
// already recorded against this Challan since. partyNet accounts for
// both. No second balance calculation is introduced here.
//
// Exactly one eligible party -> auto-select it.
// Zero or more than one eligible party -> return null (never guess);
// the caller requires a manually-selected Counter Account, exactly as
// for any other unresolved document.
// ============================================================

export interface ChallanEligibleParty {
  accountId: string;
  partyName: string;
  amount: number;
}

// Shared by resolveChallanParty() and getChallanEligiblePartyAccountIds()
// below, and by the Daily Posting search-documents route's multi-party
// UI selector - the ONE place that reads partyNet for a given direction,
// so the auto-resolution decision, the backend eligibility check, and
// what the UI offers the user can never disagree.
export async function getChallanEligibleParties(
  challanId: string,
  direction: "DEBIT" | "CREDIT"
): Promise<ChallanEligibleParty[]> {
  const summary = await computeChallanSettlementSummary(challanId);
  if (!summary) return [];

  const wantDirection = direction === "DEBIT" ? "RECEIVABLE" : "PAYABLE";
  return summary.partyNet
    .filter((p) => p.direction === wantDirection)
    .map((p) => ({ accountId: p.accountId, partyName: p.partyName, amount: Math.abs(p.net) }));
}

async function resolveChallanParty(
  challanId: string,
  direction: "DEBIT" | "CREDIT" | undefined
): Promise<ResolvedDocumentParty | null> {
  // Without a known direction there is no way to tell Receivable from
  // Payable eligibility apart - never guess.
  if (!direction) return null;

  const eligible = await getChallanEligibleParties(challanId, direction);

  if (eligible.length === 1) {
    return { accountId: eligible[0].accountId, partyName: eligible[0].partyName };
  }

  return null;
}

// ============================================================
// CHALLAN -> ELIGIBLE PARTY ACCOUNT IDS FOR A GIVEN DIRECTION
//
// Used ONLY to validate a manually-supplied Counter Account against
// the LOCKED Receivable/Payable rule above - never to auto-select
// one. Mirrors getBiltyLegitimatePartyAccountIds()'s role for BILTY,
// but scoped to exactly the direction-appropriate side (Receivable
// for DEBIT/RECEIPT, Payable for CREDIT/PAYMENT), per the LOCKED
// rule's explicit requirement that a PAYMENT must never accept a
// Receivable party's account and vice versa.
// ============================================================
export async function getChallanEligiblePartyAccountIds(
  challanId: string,
  direction: "DEBIT" | "CREDIT"
): Promise<Set<string>> {
  const eligible = await getChallanEligibleParties(challanId, direction);
  return new Set(eligible.map((p) => p.accountId));
}

export async function resolveDocumentPartyAccount(
  sourceType: "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH" | "BILL",
  sourceId: string,
  // Consulted for CHALLAN (see resolveChallanParty() above), for
  // BILTY's own narrow Gross Bilty Receivable fallback (see
  // resolveUnclaimedGrossBiltyReceivable() above), and for
  // PRIVATE_PHONCH's own multi-party eligibility (see
  // resolvePrivatePhonchParty() above) - PHONCH/BILL resolution is
  // entirely unaffected by this parameter.
  direction?: "DEBIT" | "CREDIT"
): Promise<ResolvedDocumentParty | null> {
  if (sourceType === "BILTY") return resolveBiltyParty(sourceId, direction);
  if (sourceType === "PHONCH") return resolvePhonchParty(sourceId);
  if (sourceType === "PRIVATE_PHONCH") return resolvePrivatePhonchParty(sourceId, direction);
  if (sourceType === "BILL") return resolveBillParty(sourceId);
  return resolveChallanParty(sourceId, direction);
}

// ============================================================
// PHONCH -> TRANSPORTER (unambiguous - a Phonch has exactly one,
// always-required Transporter field, unlike Bilty/Challan's
// multi-party fallback chains above).
// ============================================================

// ============================================================
// BILL -> CLIENT PARTY (unambiguous - a Bill has exactly one, always-
// required Client Party field, same shape as Phonch's own Transporter
// above).
// ============================================================

async function resolveBillParty(billId: string): Promise<ResolvedDocumentParty | null> {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    select: {
      clientName: true,
      clientParty: { select: { account: { select: { id: true, isActive: true } } } },
    },
  });

  if (!bill) return null;

  // A selected Party's account must be active to be a valid posting
  // destination (unchanged rule) - the shared Walk-in Customers system
  // account (for a random/one-time client, no selected Party) is
  // always active by construction, so it's always eligible once it
  // exists.
  if (bill.clientParty) {
    if (!bill.clientParty.account || !bill.clientParty.account.isActive) return null;
    return { accountId: bill.clientParty.account.id, partyName: bill.clientName };
  }

  const walkInAccountId = await resolveBillClientAccountId(prisma, null);
  if (!walkInAccountId) return null;
  return { accountId: walkInAccountId, partyName: bill.clientName };
}

// A manually-supplied Counter Account for a Bill-linked Daily Posting
// line must belong to that EXACT Bill's own Client Party - the only
// legitimate counterparty, mirroring getPhonchEligiblePartyAccountIds()
// exactly (reused via resolveBillParty() above, never a second,
// separately-written Client lookup). An empty set (no active Client
// account) rejects every manually-supplied account, matching
// Phonch's/Bilty's own "nothing established -> reject everything"
// behavior.
export async function getBillEligiblePartyAccountIds(billId: string): Promise<Set<string>> {
  const resolved = await resolveBillParty(billId);
  return resolved ? new Set([resolved.accountId]) : new Set();
}

async function resolvePhonchParty(phonchId: string): Promise<ResolvedDocumentParty | null> {
  const phonch = await prisma.phonch.findUnique({
    where: { id: phonchId },
    select: {
      transporterParty: {
        select: { partyName: true, account: { select: { id: true, isActive: true } } },
      },
    },
  });

  if (!phonch || !phonch.transporterParty.account || !phonch.transporterParty.account.isActive) return null;

  return { accountId: phonch.transporterParty.account.id, partyName: phonch.transporterParty.partyName };
}

// A manually-supplied Counter Account for a Showroom Phonch-linked
// Daily Posting line must belong to that EXACT Phonch's own
// Transporter - the only legitimate counterparty, per
// resolvePhonchParty() above (reused here, never a second, separately
// -written Transporter lookup). An empty set (no active Transporter
// account) rejects every manually-supplied account, matching Bilty's
// own "nothing established -> reject everything" behavior.
export async function getPhonchEligiblePartyAccountIds(phonchId: string): Promise<Set<string>> {
  const resolved = await resolvePhonchParty(phonchId);
  return resolved ? new Set([resolved.accountId]) : new Set();
}

// ============================================================
// PRIVATE PHONCH -> ELIGIBLE PAYABLE PARTIES (Transporter + every
// distinct Clearing Agent named on a vehicle row)
//
// Unlike Showroom Phonch above (one always-required Transporter,
// unambiguous), a Private Phonch can have SEVERAL distinct payable
// parties at once. Eligibility is based ONLY on the actual
// outstanding accounting position for THIS Private Phonch - never
// merely "it is the Transporter" / "it is a Clearing Agent" / "it is
// the first party" (per the LOCKED rule this mirrors from the
// Challan resolver):
//
//   CREDIT (PAYMENT - the main Cash/Bank account pays OUT):
//     eligible = Transporter, if their Carrier Payable total minus
//     what has already been paid to them (via Daily Posting tagged to
//     this Private Phonch) is still > 0; PLUS each distinct Clearing
//     Agent whose own CA Payable total minus what has already been
//     paid to them is still > 0.
//
//   DEBIT (RECEIPT - the main Cash/Bank account receives money, e.g. a
//   Clearing Agent depositing amanat with ANC - see Case 11): eligible
//   = every distinct Clearing Agent named on this Private Phonch,
//   regardless of their current payable balance (a deposit is a real,
//   independent receipt, not capped by what is currently owed); PLUS
//   the Transporter, but ONLY while a Delivery Recovery is actually
//   outstanding (a fully-paid, Total Rent = 0 vehicle's Delivery
//   Charges - see resolvePrivatePhonchInput()'s own doc comment in
//   lib/private-phonch-accounting.ts). Unlike a Clearing Agent
//   deposit, the Transporter's own recovery IS netted against what
//   has already been received, via
//   getPrivatePhonchDeliveryRecoveryState() - it is a real, capped
//   receivable, not an uncapped deposit.
//
// Exactly one eligible party -> the caller may auto-select it. Zero or
// more than one -> return null (never guess); the caller requires a
// manually-selected Counter Account, exactly as for Bilty/Challan.
// ============================================================

export async function getPrivatePhonchEligibleParties(
  phonchId: string,
  direction: "DEBIT" | "CREDIT"
): Promise<ChallanEligibleParty[]> {
  const phonch = await prisma.privatePhonch.findUnique({
    where: { id: phonchId },
    select: {
      transporterParty: {
        select: { partyName: true, account: { select: { id: true, isActive: true } } },
      },
      vehicles: {
        select: {
          totalRent: true,
          deliveryCharges: true,
          carrierPayable: true,
          deliveryRecoveryParty: true,
          clearingAgentParty: {
            select: { id: true, partyName: true, account: { select: { id: true, isActive: true } } },
          },
        },
      },
    },
  });
  if (!phonch) return [];

  // Distinct Clearing Agents named on this Private Phonch, each with
  // their OWN summed CA Payable across every vehicle row that names
  // them (Case 3: the same Clearing Agent on several rows sums into
  // one relevant payable, never counted per-row) - zero-rent vehicles
  // attributed to a Clearing Agent for Delivery Recovery instead never
  // contribute here (their caPayable is always 0), see caRecoveryTotals
  // below for their own, opposite-polarity total.
  const caTotals = new Map<string, { partyName: string; accountId: string; accountIsActive: boolean; total: number }>();
  // Each Clearing Agent's own Delivery Recovery total, from zero-rent
  // vehicles explicitly attributed to them (never combined with
  // caTotals above - see resolvePrivatePhonchInput()'s own
  // mutual-exclusivity guard).
  const caRecoveryTotals = new Map<string, { partyName: string; accountId: string; accountIsActive: boolean; total: number }>();
  for (const v of phonch.vehicles) {
    if (!v.clearingAgentParty?.account) continue;
    if (Number(v.totalRent) <= 0.009 && v.deliveryRecoveryParty === "CLEARING_AGENT") {
      const existing = caRecoveryTotals.get(v.clearingAgentParty.id) || {
        partyName: v.clearingAgentParty.partyName,
        accountId: v.clearingAgentParty.account.id,
        accountIsActive: v.clearingAgentParty.account.isActive,
        total: 0,
      };
      existing.total = Math.round((existing.total + Number(v.deliveryCharges)) * 100) / 100;
      caRecoveryTotals.set(v.clearingAgentParty.id, existing);
      continue;
    }
    const netRent = Number(v.totalRent) - Number(v.deliveryCharges);
    const caPayable = Math.max(0, Math.round((netRent - Number(v.carrierPayable)) * 100) / 100);
    const existing = caTotals.get(v.clearingAgentParty.id) || {
      partyName: v.clearingAgentParty.partyName,
      accountId: v.clearingAgentParty.account.id,
      accountIsActive: v.clearingAgentParty.account.isActive,
      total: 0,
    };
    existing.total = Math.round((existing.total + caPayable) * 100) / 100;
    caTotals.set(v.clearingAgentParty.id, existing);
  }

  if (direction === "DEBIT") {
    const result: ChallanEligibleParty[] = [];
    for (const ca of caTotals.values()) {
      if (!ca.accountIsActive) continue;
      result.push({ accountId: ca.accountId, partyName: ca.partyName, amount: ca.total });
    }

    // Clearing Agent Delivery Recovery - a real, CAPPED receivable
    // (unlike a deposit above), netted against what has already been
    // received via the SAME generic getPrivatePhonchDeliveryRecoveryState()
    // the Transporter's own recovery uses below. Updates (never
    // duplicates) an existing deposit-eligible entry for the same
    // account - a Clearing Agent with a 0 CA Payable elsewhere on this
    // Private Phonch would otherwise already be in `result` once, with
    // an uninformative amount of 0.
    if (caRecoveryTotals.size > 0) {
      const { getPrivatePhonchDeliveryRecoveryState } = await import("@/lib/private-phonch-accounting");
      for (const ca of caRecoveryTotals.values()) {
        if (!ca.accountIsActive || ca.total <= 0.009) continue;
        const state = await getPrivatePhonchDeliveryRecoveryState(prisma, phonchId, ca.accountId, ca.total);
        if (state.remainingDue > 0.009) {
          const existing = result.find((r) => r.accountId === ca.accountId);
          if (existing) existing.amount = state.remainingDue;
          else result.push({ accountId: ca.accountId, partyName: ca.partyName, amount: state.remainingDue });
        }
      }
    }

    const transporterAccountForRecovery = phonch.transporterParty.account;
    if (transporterAccountForRecovery?.isActive) {
      const totalTransporterDeliveryRecovery = Math.round(
        phonch.vehicles.reduce(
          (s, v) => s + (Number(v.totalRent) <= 0.009 && v.deliveryRecoveryParty !== "CLEARING_AGENT" ? Number(v.deliveryCharges) : 0),
          0
        ) * 100
      ) / 100;
      if (totalTransporterDeliveryRecovery > 0.009) {
        const { getPrivatePhonchDeliveryRecoveryState } = await import("@/lib/private-phonch-accounting");
        const state = await getPrivatePhonchDeliveryRecoveryState(prisma, phonchId, transporterAccountForRecovery.id, totalTransporterDeliveryRecovery);
        if (state.remainingDue > 0.009) {
          result.push({ accountId: transporterAccountForRecovery.id, partyName: phonch.transporterParty.partyName, amount: state.remainingDue });
        }
      }
    }

    return result;
  }

  // CREDIT (PAYMENT) - net each candidate's total against what has
  // already been paid to them via Daily Posting tagged to this
  // Private Phonch, using the SAME getPrivatePhonchPaymentState()
  // every other payment-state read already uses - never a second,
  // separately-computed "remaining" figure.
  const { getPrivatePhonchPaymentState } = await import("@/lib/private-phonch-accounting");

  const result: ChallanEligibleParty[] = [];

  const transporterAccount = phonch.transporterParty.account;
  if (transporterAccount?.isActive) {
    const totalCarrierPayable = Math.round(
      phonch.vehicles.reduce((s, v) => s + Number(v.carrierPayable), 0) * 100
    ) / 100;
    if (totalCarrierPayable > 0.009) {
      const state = await getPrivatePhonchPaymentState(prisma, phonchId, transporterAccount.id, totalCarrierPayable, undefined, true);
      if (state.remainingDue > 0.009) {
        result.push({ accountId: transporterAccount.id, partyName: phonch.transporterParty.partyName, amount: state.remainingDue });
      }
    }
  }

  for (const ca of caTotals.values()) {
    if (!ca.accountIsActive || ca.total <= 0.009) continue;
    const state = await getPrivatePhonchPaymentState(prisma, phonchId, ca.accountId, ca.total);
    if (state.remainingDue > 0.009) {
      result.push({ accountId: ca.accountId, partyName: ca.partyName, amount: state.remainingDue });
    }
  }

  return result;
}

async function resolvePrivatePhonchParty(
  phonchId: string,
  direction: "DEBIT" | "CREDIT" | undefined
): Promise<ResolvedDocumentParty | null> {
  // Without a known direction there is no way to tell the PAYMENT-
  // eligible set from the DEPOSIT-eligible set apart - never guess.
  if (!direction) return null;

  const eligible = await getPrivatePhonchEligibleParties(phonchId, direction);
  if (eligible.length === 1) {
    return { accountId: eligible[0].accountId, partyName: eligible[0].partyName };
  }
  return null;
}

export async function getPrivatePhonchEligiblePartyAccountIds(
  phonchId: string,
  direction: "DEBIT" | "CREDIT"
): Promise<Set<string>> {
  const eligible = await getPrivatePhonchEligibleParties(phonchId, direction);
  return new Set(eligible.map((p) => p.accountId));
}

// ============================================================
// BILTY PAID-AMOUNT RESPONSIBILITY (Consignor / Consignee)
//
// The Paid ("advance") portion of a Bilty is recognized from the
// Bilty itself (see app/api/bilty/route.ts) but never automatically
// means ANC has actually received it - see
// getBiltyPaidVerification() in lib/bilty-paid-verification.ts for
// that separate, derived "Unverified" calculation. This function
// only answers "which Party is CONSIDERED responsible for that Paid
// amount" - a distinct question, per the finalized business rules.
//
// Resolution order (never guessed, per the explicit business rule):
//  1. Bilty.paidResponsiblePartyId, if explicitly set (and still a
//     real, active PARTY account) - always wins once set.
//  2. If not set: auto-resolve ONLY when exactly one of
//     consignorParty/consigneeParty has a real, active PARTY
//     account - the unambiguous case.
//  3. If BOTH have valid accounts and neither was explicitly chosen,
//     or NEITHER has one: unresolved (null) - the caller must not
//     guess, and must not fabricate an account.
// ============================================================

export async function resolveBiltyPaidResponsibleParty(
  biltyId: string,
  tx: Tx = prisma
): Promise<ResolvedDocumentParty | null> {
  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: {
      advance: true,
      paidResponsibleParty: {
        select: { partyName: true, account: { select: { id: true, isActive: true } } },
      },
      consignorParty: {
        select: { partyName: true, account: { select: { id: true, isActive: true } } },
      },
      consigneeParty: {
        select: { partyName: true, account: { select: { id: true, isActive: true } } },
      },
    },
  });

  if (!bilty) return null;
  if (Number(bilty.advance) <= 0) return null;

  if (bilty.paidResponsibleParty?.account?.id && bilty.paidResponsibleParty.account.isActive) {
    return { accountId: bilty.paidResponsibleParty.account.id, partyName: bilty.paidResponsibleParty.partyName };
  }

  const consignorValid = bilty.consignorParty?.account?.id && bilty.consignorParty.account.isActive;
  const consigneeValid = bilty.consigneeParty?.account?.id && bilty.consigneeParty.account.isActive;

  if (consignorValid && !consigneeValid) {
    return { accountId: bilty.consignorParty!.account!.id, partyName: bilty.consignorParty!.partyName };
  }
  if (consigneeValid && !consignorValid) {
    return { accountId: bilty.consigneeParty!.account!.id, partyName: bilty.consigneeParty!.partyName };
  }

  // Both valid (explicit selection required, never guessed) or
  // neither valid (nothing to attribute to) - either way, unresolved.
  return null;
}

// ============================================================
// DAILY POSTING HARD-REJECTION SUPPORT
//
// The full SET of every Party account this Bilty currently has a
// real, ledger-or-explicitly-established reason to receive a
// Bilty-tagged Daily Posting for - Collection/To-Pay candidates
// (even when genuinely ambiguous between several, unlike
// resolveBiltyParty()'s single-best-guess-or-null contract above)
// PLUS the Paid-responsibility candidate, if resolved. Used only to
// tell "a real, recognized destination" apart from "an unrelated
// Party" for the Daily Posting mismatch guard
// (app/api/daily-posting/route.ts) - never to auto-select one.
// ============================================================

export async function getBiltyLegitimatePartyAccountIds(
  biltyId: string,
  // Only consulted for the Gross Bilty Receivable exception below -
  // RECEIPT only, see resolveUnclaimedGrossBiltyReceivable().
  direction?: "DEBIT" | "CREDIT"
): Promise<Set<string>> {
  const result = new Set<string>();

  const bilty = await prisma.bilty.findUnique({
    where: { id: biltyId },
    select: {
      clearingAgentParty: { select: { account: { select: { id: true, isActive: true } } } },
      consignorParty: { select: { account: { select: { id: true, isActive: true } } } },
      consigneeParty: { select: { account: { select: { id: true, isActive: true } } } },
      challanBilties: {
        where: { challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: { challan: { select: { id: true, isSettled: true, settlementJournalEntryId: true } } },
      },
    },
  });
  if (!bilty) return result;

  const activeChallan = bilty.challanBilties[0]?.challan;

  if (activeChallan) {
    const payers = await getActiveSettlementPayers(prisma, "COLLECTION", { challanId: activeChallan.id, biltyId });
    for (const p of payers) result.add(p.payerAccountId);

    if (payers.length === 0 && activeChallan.isSettled && activeChallan.settlementJournalEntryId) {
      const bookingIncomeAccount = await prisma.account.findFirst({
        where: { category: "BOOKING_INCOME", isActive: true },
        select: { id: true },
      });
      if (bookingIncomeAccount) {
        const oldPartyAccountId = await findSettledPartyAccountId(
          prisma,
          activeChallan.id,
          activeChallan.settlementJournalEntryId,
          "COLLECTION",
          bookingIncomeAccount.id,
          biltyId
        );
        if (oldPartyAccountId) result.add(oldPartyAccountId);
      }
    }
  }

  // No real Collection destination established yet - mirrors
  // resolveBiltyParty()'s own replacement of the old Clearing Agent
  // guess (see that function's own comment for the full reasoning):
  // the money is still genuinely sitting in Gross Bilty Receivable
  // until a real Settlement reclassification moves it out, so THAT
  // is the legitimate manually-selectable destination here too -
  // RECEIPT (DEBIT) only, capped at Bilty.toPay exactly like the
  // write-time ceiling check.
  if (result.size === 0 && direction === "DEBIT") {
    const unclaimedForCollection = await getUnclaimedGrossBiltyReceivableAmountForCollection(prisma, biltyId);
    if (unclaimedForCollection > 0.01) {
      result.add(await getGrossBiltyReceivableAccountId(prisma));
    }
  }

  const paidResponsible = await resolveBiltyPaidResponsibleParty(biltyId);
  if (paidResponsible) result.add(paidResponsible.accountId);

  // Gross Bilty Receivable (Unallocated) - RECEIPT only, and only
  // when no real Party already holds the Paid amount (mirrors
  // resolveBiltyParty()'s exact same gate). Added before the safety
  // fallback below so its presence correctly takes precedence over
  // that cruder, unestablished-party fallback.
  if (direction === "DEBIT" && !paidResponsible) {
    const grossReceivable = await resolveUnclaimedGrossBiltyReceivable(biltyId);
    if (grossReceivable) result.add(grossReceivable.accountId);
  }

  // SAFETY FALLBACK: when NOTHING resolves above (no Collection
  // payer/settlement, no Clearing Agent, no Paid responsibility), a
  // Bilty-linked Daily Posting must still never accept a completely
  // unrelated Party - falling through to "anything goes" here would
  // let a manually-supplied Counter Account with no relationship to
  // this Bilty at all slip past the mismatch guard entirely. Fall
  // back to the Bilty's own directly-named parties (Consignor/
  // Consignee/Clearing Agent) - fields that have always existed on
  // every Bilty, historical or not - rather than inventing any new
  // relationship or fabricating an account. Only applies when
  // nothing else resolved above, so a Bilty that DOES have an
  // established party keeps the strict single-match guard unchanged.
  if (result.size === 0) {
    if (bilty.consignorParty?.account?.id && bilty.consignorParty.account.isActive) {
      result.add(bilty.consignorParty.account.id);
    }
    if (bilty.consigneeParty?.account?.id && bilty.consigneeParty.account.isActive) {
      result.add(bilty.consigneeParty.account.id);
    }
    if (bilty.clearingAgentParty?.account?.id && bilty.clearingAgentParty.account.isActive) {
      result.add(bilty.clearingAgentParty.account.id);
    }
  }

  return result;
}

// ============================================================
// CHALLAN -> RESPONSIBLE PARTIES (Receivable / Payable)
//
// Purely informational, for the "Kis Se Lena Hai / Kis Ko Dena
// Hai" display on Challan Details. This identifies WHO the
// existing challan.financials receivable/payable totals belong to
// by reading the same Settlement + Settlement Correction
// JournalLines those totals are ultimately derived from - it does
// NOT recompute or duplicate the amounts themselves (those remain
// exactly lib/challan-financials.ts's numbers).
//
// A Challan can have more than one party on either side (e.g.
// different Bilties settled to different Clearing Agents) - all
// of them are returned, the UI decides how to compactly display
// more than one.
// ============================================================

export interface ChallanResponsibleParty {
  accountId: string;
  partyId: string;
  partyName: string;
  // Absolute net amount (already computed below from the same
  // debit/credit sum that decides receivable vs payable) - exposed so
  // a multi-party UI selector can label each option without a second,
  // separate balance calculation.
  amount: number;
}

export interface ChallanResponsibleParties {
  receivable: ChallanResponsibleParty[];
  payable: ChallanResponsibleParty[];
}

export async function getChallanResponsiblePartiesBatch(
  challanIds: string[]
): Promise<Record<string, ChallanResponsibleParties>> {
  const result: Record<string, ChallanResponsibleParties> = {};
  for (const id of challanIds) {
    result[id] = { receivable: [], payable: [] };
  }

  if (challanIds.length === 0) return result;

  const lines = await prisma.journalLine.findMany({
    where: {
      journalEntry: {
        isDeleted: false,
        referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] },
        referenceId: { in: challanIds },
      },
      account: { category: "PARTY" },
    },
    select: {
      accountId: true,
      debit: true,
      credit: true,
      journalEntry: { select: { referenceId: true } },
      account: { select: { partyId: true, party: { select: { partyName: true } } } },
    },
  });

  const perChallan = new Map<string, Map<string, { partyId: string; partyName: string; net: number }>>();

  for (const line of lines) {
    const challanId = line.journalEntry.referenceId;
    if (!challanId || !line.account.partyId) continue;

    const parties = perChallan.get(challanId) || new Map<string, { partyId: string; partyName: string; net: number }>();
    const existing = parties.get(line.accountId) || {
      partyId: line.account.partyId,
      partyName: line.account.party?.partyName || "Party",
      net: 0,
    };
    existing.net += Number(line.debit) - Number(line.credit);
    parties.set(line.accountId, existing);
    perChallan.set(challanId, parties);
  }

  for (const [challanId, parties] of perChallan.entries()) {
    if (!result[challanId]) result[challanId] = { receivable: [], payable: [] };

    for (const [accountId, { partyId, partyName, net }] of parties.entries()) {
      if (net > 0) {
        result[challanId].receivable.push({ accountId, partyId, partyName, amount: net });
      } else if (net < 0) {
        result[challanId].payable.push({ accountId, partyId, partyName, amount: -net });
      }
    }
  }

  return result;
}

export async function getChallanResponsibleParties(
  challanId: string
): Promise<ChallanResponsibleParties> {
  const batch = await getChallanResponsiblePartiesBatch([challanId]);
  return batch[challanId] || { receivable: [], payable: [] };
}
