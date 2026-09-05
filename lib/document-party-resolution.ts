import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findSettledPartyAccountId } from "@/lib/settlement-correction";
import { getActiveSettlementPayers } from "@/lib/settlement-payments";

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

async function resolveBiltyParty(biltyId: string): Promise<ResolvedDocumentParty | null> {
  const bilty = await prisma.bilty.findUnique({
    where: { id: biltyId },
    select: {
      clearingAgentParty: {
        select: {
          partyName: true,
          account: { select: { id: true, isActive: true } },
        },
      },
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
      }
    }
  }

  // clearingAgentPartyId is a descriptive/planned field set at Bilty
  // booking time - it is NOT itself a Collection accounting fact.
  // Only treat it as a legitimate Collection-side destination once
  // the Bilty has actually been added to a real Challan (activeChallan)
  // - i.e. there is at least a live shipment this Clearing Agent is
  // actually attached to. A Bilty never added to any Challan has no
  // Collection responsibility established at all yet, so this
  // fallback must not manufacture one merely because the field is
  // populated (this previously caused a false ambiguity against a
  // real, established Paid attribution - see the Step 2 hotfix audit).
  if (!collectionResult && activeChallan && bilty.clearingAgentParty?.account?.id && bilty.clearingAgentParty.account.isActive) {
    collectionResult = {
      accountId: bilty.clearingAgentParty.account.id,
      partyName: bilty.clearingAgentParty.partyName,
    };
  }

  // Paid-responsible side - a DIFFERENT accounting component (see
  // resolveBiltyPaidResponsibleParty()'s own module-level reasoning
  // below). Resolved independently of Collection above - never
  // derived from it, never merged into it.
  const paidResult = await resolveBiltyPaidResponsibleParty(biltyId);

  if (collectionResult && paidResult) {
    // Both components resolved. If they name the SAME account there
    // is no real ambiguity. If they differ, this Bilty genuinely has
    // two distinct legitimate destinations (e.g. Collection ->
    // Clearing Agent, Paid -> Consignor) and a document-only posting
    // (no manually-supplied Counter Account) cannot safely infer
    // which one this particular entry is for - guessing would risk
    // crediting the wrong Party's ledger. Require a manually-selected
    // Counter Account instead, exactly the same "never guess when
    // more than one distinct party is genuinely involved" rule this
    // module already applies to multiple Collection payers above.
    return collectionResult.accountId === paidResult.accountId ? collectionResult : null;
  }

  return collectionResult || paidResult;
}

async function resolveChallanParty(challanId: string): Promise<ResolvedDocumentParty | null> {
  const challan = await prisma.challan.findUnique({
    where: { id: challanId },
    select: {
      isSettled: true,
      bilties: {
        select: {
          bilty: {
            select: {
              clearingAgentPartyId: true,
              clearingAgentParty: {
                select: {
                  partyName: true,
                  account: { select: { id: true, isActive: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!challan) return null;

  // Prefer the new multi-payer engine's own explicit Carrier Rent
  // rows first, for the same reason as resolveBiltyParty() above.
  const carrierRentPayers = await getActiveSettlementPayers(prisma, "CARRIER_RENT", { challanId });
  if (carrierRentPayers.length === 1) {
    const account = await prisma.account.findUnique({
      where: { id: carrierRentPayers[0].payerAccountId },
      select: { party: { select: { partyName: true } } },
    });
    return { accountId: carrierRentPayers[0].payerAccountId, partyName: account?.party?.partyName || "Party" };
  }
  if (carrierRentPayers.length > 1) {
    return null;
  }

  if (challan.isSettled) {
    const lines = await prisma.journalLine.findMany({
      where: {
        journalEntry: {
          isDeleted: false,
          referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] },
          referenceId: challanId,
        },
        account: { category: "PARTY" },
      },
      select: {
        accountId: true,
        account: { select: { party: { select: { partyName: true } } } },
      },
    });

    const distinct = new Map<string, string>();
    for (const line of lines) {
      distinct.set(line.accountId, line.account.party?.partyName || "Party");
    }

    if (distinct.size === 1) {
      const [accountId, partyName] = [...distinct.entries()][0];
      return { accountId, partyName };
    }

    // More than one distinct party is genuinely responsible for
    // this Challan's settlement (e.g. Collection -> Clearing Agent,
    // Carrier Rent -> a different Other Party) - which one a
    // Challan-level posting is actually for cannot be inferred here.
    // Falling back to the shared Clearing Agent below would silently
    // misattribute the posting whenever it was really meant for one
    // of the other parties. Require a manually-selected Counter
    // Account instead, exactly as the caller already does when this
    // function returns null for any other reason.
    if (distinct.size > 1) return null;
  }

  const clearingAgentIds = new Set(
    challan.bilties
      .map((cb) => cb.bilty.clearingAgentPartyId)
      .filter((id): id is string => Boolean(id))
  );

  if (clearingAgentIds.size === 1) {
    const withAgent = challan.bilties.find((cb) => cb.bilty.clearingAgentPartyId);
    const account = withAgent?.bilty.clearingAgentParty?.account;

    if (account?.id && account.isActive) {
      return { accountId: account.id, partyName: withAgent!.bilty.clearingAgentParty!.partyName };
    }
  }

  return null;
}

export async function resolveDocumentPartyAccount(
  sourceType: "CHALLAN" | "BILTY",
  sourceId: string
): Promise<ResolvedDocumentParty | null> {
  if (sourceType === "BILTY") return resolveBiltyParty(sourceId);
  return resolveChallanParty(sourceId);
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

export async function getBiltyLegitimatePartyAccountIds(biltyId: string): Promise<Set<string>> {
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

  if (result.size === 0 && bilty.clearingAgentParty?.account?.id && bilty.clearingAgentParty.account.isActive) {
    result.add(bilty.clearingAgentParty.account.id);
  }

  const paidResponsible = await resolveBiltyPaidResponsibleParty(biltyId);
  if (paidResponsible) result.add(paidResponsible.accountId);

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
        result[challanId].receivable.push({ accountId, partyId, partyName });
      } else if (net < 0) {
        result[challanId].payable.push({ accountId, partyId, partyName });
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
