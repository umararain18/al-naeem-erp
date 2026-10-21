import { prisma } from "@/lib/prisma";
import { getBiltyPaidVerification } from "@/lib/bilty-paid-verification";
import {
  getSettledPartyAccountIdsBatch,
  SETTLEMENT_NET_REFERENCE_TYPES,
} from "@/lib/settlement-correction";

// ============================================================
// CHALLAN SETTLEMENT SUMMARY (read-side, batched)
//
// The dimensionally-SEPARATED summary Final Settlement already shows
// (Bilty Rent / Paid+Verified+Unverified / To-Pay Due+Received+
// Remaining / Carrier Rent Due+Paid+Remaining) - computed here for
// the Challan Detail page AND the Challan list, from the SAME
// authoritative sources FinalSettlementOperations.tsx already reads,
// batched so a list of many Challans costs a small, FIXED number of
// queries rather than one query per Bilty/Challan.
//
// This is a PURE READ. It never creates/edits/deletes a
// JournalEntry/JournalLine/SettlementPayment, never touches
// Challan.outstandingReceivable/outstandingPayable (still written
// elsewhere, untouched here), and never recomputes PAID verification
// itself - it reuses getBiltyPaidVerification() exactly.
//
// "paidOrReceived" PRECEDENCE (per Bilty/Challan, per component) -
// EXCLUSIVE, never additive across tiers (a past version of this
// file added a Daily Posting figure ON TOP of live SettlementPayment
// rows, and separately let one combined-challan Daily Posting entry
// get rechecked once per sibling Bilty - together these tripled a
// single real payment on a production Challan):
//   1. Live SettlementPayment rows for that component, if any exist -
//      used EXCLUSIVELY (summed, capped at `total`). Nothing else is
//      added on top, ever.
//   2. Otherwise, REAL Daily Posting Cash/Bank-paired activity against
//      the OLD single-payer mechanism's currently-attributed party -
//      correlated per LINE and STRICTLY scoped to this component's own
//      document (sourceType:"BILTY"/this Bilty's own id for To-Pay/
//      Collection; sourceType:"CHALLAN"/this Challan's own id for
//      Carrier Rent) - a Carrier-Rent-tagged line is never read for
//      To-Pay and vice versa, and a Challan-level line is never
//      rechecked once per Bilty.
//   3. Otherwise, the SAME "verified advance" finalize-settlement
//      itself already netted into Challan.outstandingReceivable/
//      outstandingPayable at settlement time - ANY Daily Posting
//      activity ever recorded against that party's account,
//      regardless of tagging (see app/api/challan/[id]/finalize-
//      settlement/route.ts's own verifiedAdvanceByAccountId) - so a
//      Challan whose component was already fully covered by a
//      pre-existing advance BEFORE settlement (and so never got its
//      own post-settlement Daily Posting line at all) still shows
//      correctly, instead of appearing newly, wrongly DUE.
//   4. Otherwise: zero payment activity - never fabricated.
// `paidOrReceived` is ALWAYS capped at `total` (never exceeds the
// amount actually due), regardless of which tier produced it. Tiers
// 2 and 3 NEVER run once tier 1 has anything - a component is either
// on the live multi-payer engine or it isn't; the two are never mixed.
// A settlement's own reclassification entry (Dr responsible party /
// Cr Gross Bilty Receivable or Gross Carrier Rent Payable) is NONE of
// these three tiers - it tells us WHO is now responsible for an
// amount, never that they have actually paid/remitted it, and is
// never read as such (a past bug here did exactly that, making an
// unpaid Carrier Rent/To-Pay show as fully "Received"/"Paid" the
// moment settlement ran, with no actual cash/bank line anywhere).
// That responsible party is still surfaced, display-only, via
// `residualPartyName` whenever `remaining > 0`.
// ============================================================

export interface SettlementPayerBreakdown {
  accountId: string;
  partyId: string | null;
  partyName: string;
  amount: number;
}

export interface ComponentSummary {
  total: number;
  paidOrReceived: number;
  remaining: number;
  payers: SettlementPayerBreakdown[];
  /** true when paidOrReceived came from tier 2 or 3 (real Daily
   * Posting activity, or the settlement-time verified advance) -
   * never tier 1 (live SettlementPayment rows). */
  isHistoricalFallback: boolean;
  /** The economic residual claimant - the party the old single-payer
   * mechanism's floor logic (lib/settlement-payments.ts's
   * ensureOldAttributionWithinFloor()) still attributes this
   * component's unpaid remainder to (i.e. whoever finalize-settlement
   * established as the default responsible party for To-Pay's
   * Collection or for Carrier Rent). Display-only - "who this is still
   * due from/to", never folded into `paidOrReceived`. Present only
   * when `remaining > 0` and that party could be safely resolved;
   * never a guess - left unset otherwise. */
  residualPartyName?: string;
}

export interface BiltySettlementSummary {
  biltyId: string;
  biltyNo: string;
  rent: number;
  paidAmount: number;
  paidVerified: number;
  paidUnverified: number;
  paidResponsiblePartyName: string | null;
  paidIsInconsistent: boolean;
  toPay: ComponentSummary;
}

export interface PartyNetEntry {
  accountId: string;
  partyId: string | null;
  partyName: string;
  net: number;
  direction: "RECEIVABLE" | "PAYABLE";
}

export interface ChallanSettlementSummary {
  challanId: string;
  bilties: BiltySettlementSummary[];
  carrierRent: ComponentSummary;
  /**
   * Cross-component party net position(s) for this Challan - NEVER
   * put inside ComponentSummary, NEVER blended with To-Pay/Carrier
   * Rent's own total/remaining above. This is the same authoritative
   * "this party's total net across every Collection + Carrier Rent
   * JournalLine on this Challan" getPartyNetFromSettlement() itself
   * computes (same referenceType set, same referenceId scope -
   * SETTLEMENT_NET_REFERENCE_TYPES / [challanId, ...biltyIds] - see
   * lib/settlement-correction.ts), reused here rather than
   * recalculated from currently-visible payer rows alone, so a
   * party's residual OLD-mechanism attribution (e.g. a Bilty's
   * toPay-floor stand-in - see syncCollectionFloorForNewEngineRows()
   * in lib/settlement-payments.ts) is never missed just because the
   * new multi-payer engine hasn't touched that specific slice.
   *
   * PAID is deliberately EXCLUDED from this net - a Bilty's Paid
   * amount is informational/context only per the approved business
   * rule and must never be silently netted against a party's
   * Collection/Carrier-Rent position. Positive net = RECEIVABLE
   * (that party owes ANC); negative = PAYABLE (ANC owes that party).
   * Zero-net parties are omitted - never fabricated.
   *
   * ALSO includes subsequent Daily Posting activity attributable to
   * THIS Challan (a receipt/payment actually recorded against it) -
   * Daily Posting cannot be found via JournalEntry.referenceType/
   * referenceId (its referenceId is the Cash/Bank account, not this
   * Challan/Bilty), so it is correlated the same way
   * computeChallanFinancialsBatch() (lib/challan-financials.ts)
   * already does: via JournalLine.sourceType/sourceId ("CHALLAN"/this
   * challanId or "BILTY"/one of its Bilty ids). Only the PARTY-side
   * line of each matched entry is summed, and the same PAID-lifecycle
   * exclusion set used for the settlement-side net is reused here, so
   * a Bilty's own Paid receipt never leaks in just because it happens
   * to be tagged sourceType:"BILTY".
   */
  partyNet: PartyNetEntry[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyComponent(total: number): ComponentSummary {
  return { total, paidOrReceived: 0, remaining: Math.max(0, round2(total)), payers: [], isHistoricalFallback: false };
}

export async function computeChallanSettlementSummaryBatch(
  challanIds: string[]
): Promise<Record<string, ChallanSettlementSummary>> {
  const result: Record<string, ChallanSettlementSummary> = {};
  if (challanIds.length === 0) return result;

  const challans = await prisma.challan.findMany({
    where: { id: { in: challanIds } },
    select: {
      id: true,
      carrierRent: true,
      isSettled: true,
      settlementJournalEntryId: true,
      bilties: {
        select: {
          bilty: { select: { id: true, biltyNo: true, total: true, toPay: true, isDeleted: true } },
        },
        orderBy: { addedAt: "asc" },
      },
    },
  });

  const allBiltyIds = challans.flatMap((c) => c.bilties.map((cb) => cb.bilty.id)).filter((id, i, arr) => {
    return arr.indexOf(id) === i;
  });

  // ------------------------------------------------------------
  // 1. NEW engine: every active SettlementPayment row for every
  //    Challan on this page, in ONE query.
  // ------------------------------------------------------------
  const rows = challanIds.length > 0
    ? await prisma.settlementPayment.findMany({
        where: { challanId: { in: challanIds } },
        select: { challanId: true, biltyId: true, component: true, payerAccountId: true, amount: true },
      })
    : [];

  type RowGroupKey = string; // `${challanId}:${component}:${biltyId ?? ""}`
  const rowsByGroup = new Map<RowGroupKey, { payerAccountId: string; amount: number }[]>();
  for (const r of rows) {
    if (r.component === "PAID") continue; // Paid is never part of this Collection/Carrier-Rent grouping.
    const key: RowGroupKey = `${r.challanId}:${r.component}:${r.biltyId ?? ""}`;
    const list = rowsByGroup.get(key) || [];
    list.push({ payerAccountId: r.payerAccountId, amount: Number(r.amount) });
    rowsByGroup.set(key, list);
  }

  // ------------------------------------------------------------
  // 2. Party names for every distinct payer account touched by the
  //    NEW engine's rows, in ONE query.
  // ------------------------------------------------------------
  const distinctPayerAccountIds = [...new Set(rows.map((r) => r.payerAccountId))];
  const payerAccounts = distinctPayerAccountIds.length > 0
    ? await prisma.account.findMany({
        where: { id: { in: distinctPayerAccountIds } },
        select: { id: true, accountName: true, party: { select: { id: true, partyName: true } } },
      })
    : [];
  const payerAccountById = new Map(payerAccounts.map((a) => [a.id, a]));

  function payersFor(key: RowGroupKey): SettlementPayerBreakdown[] {
    const list = rowsByGroup.get(key) || [];
    return list.map((r) => {
      const account = payerAccountById.get(r.payerAccountId);
      return {
        accountId: r.payerAccountId,
        partyId: account?.party?.id || null,
        partyName: account?.party?.partyName || account?.accountName || "Party",
        amount: r.amount,
      };
    });
  }

  // ------------------------------------------------------------
  // 3. OLD-mechanism fallback accounts (Booking Income / Carrier
  //    Rent expense) - fetched once, shared across every fallback
  //    lookup below, exactly matching the account category
  //    ensureOldAttributionWithinFloor() itself already matches
  //    against for the SAME two components.
  // ------------------------------------------------------------
  const [bookingIncomeAccount, carrierRentExpenseAccount] = await Promise.all([
    prisma.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } }),
    prisma.account.findFirst({ where: { category: "CARRIER_RENT", isActive: true }, select: { id: true } }),
  ]);

  // ------------------------------------------------------------
  // 4. Paid verification - reused exactly as-is, per Bilty,
  //    concurrently (the same pattern the Challan Detail GET already
  //    uses for paidVerification.perBilty).
  // ------------------------------------------------------------
  const paidVerificationByBiltyId = new Map<string, Awaited<ReturnType<typeof getBiltyPaidVerification>>>();
  await Promise.all(
    allBiltyIds.map(async (biltyId) => {
      const state = await getBiltyPaidVerification(prisma, biltyId);
      paidVerificationByBiltyId.set(biltyId, state);
    })
  );

  // ------------------------------------------------------------
  // 4.5. REAL (cash/bank-backed) Daily Posting activity, split into
  //    TWO SEPARATE maps by the line's OWN sourceType - never merged,
  //    which is what keeps To-Pay/Collection (Bilty-scoped) and
  //    Carrier Rent (Challan-scoped) from leaking into each other,
  //    and keeps a Challan-level Carrier Rent payment from being
  //    rechecked once per sibling Bilty when computing To-Pay (the
  //    exact amplification that tripled a real payment in production
  //    before this fix). Each line carries its own sourceType/sourceId
  //    independently (app/api/daily-posting/route.ts) - a single
  //    combined voucher can legitimately record several unrelated
  //    Bilties/Challans' own receipts/payments in one JournalEntry, so
  //    ownership is always resolved from each line's OWN sourceId,
  //    never from "the first matching line in this whole entry".
  //
  //    PAID exclusion CANNOT reuse the settlement-side JournalEntry-id
  //    exclusion further below: a PAID verification receipt is posted
  //    as its OWN, separate DAILY_POSTING entry, tagged
  //    sourceType:"BILTY"/sourceId:<biltyId> - the EXACT SAME tag
  //    shape a legitimate Collection Daily Posting on that same Bilty
  //    also uses. The tag alone cannot distinguish them - only the
  //    ACCOUNT can, via the authoritative
  //    SettlementPayment.payerAccountId for every component:"PAID"
  //    row, per Bilty.
  // ------------------------------------------------------------
  const allPaidRows = allBiltyIds.length > 0
    ? await prisma.settlementPayment.findMany({
        where: { component: "PAID", biltyId: { in: allBiltyIds } },
        select: { biltyId: true, payerAccountId: true },
      })
    : [];
  const paidPayerAccountIdsByBiltyId = new Map<string, Set<string>>();
  for (const row of allPaidRows) {
    if (!row.biltyId) continue;
    const set = paidPayerAccountIdsByBiltyId.get(row.biltyId) || new Set<string>();
    set.add(row.payerAccountId);
    paidPayerAccountIdsByBiltyId.set(row.biltyId, set);
  }

  const dailyPostingLines =
    challanIds.length > 0 || allBiltyIds.length > 0
      ? await prisma.journalLine.findMany({
          where: {
            journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
            OR: [
              { sourceType: "CHALLAN", sourceId: { in: challanIds } },
              ...(allBiltyIds.length > 0 ? [{ sourceType: "BILTY", sourceId: { in: allBiltyIds } }] : []),
            ],
          },
          select: {
            accountId: true,
            debit: true,
            credit: true,
            sourceType: true,
            sourceId: true,
            account: { select: { category: true } },
          },
        })
      : [];

  // Keyed `${challanId}:${accountId}` - CHALLAN-sourced lines only
  // (Carrier Rent's own domain).
  const dailyPostingNetByChallanAccount = new Map<string, number>();
  // Keyed `${biltyId}:${accountId}` - BILTY-sourced lines only
  // (To-Pay/Collection's own domain).
  const dailyPostingNetByBiltyAccount = new Map<string, number>();
  for (const l of dailyPostingLines) {
    if (l.account.category !== "PARTY") continue; // never the Cash/Bank side.
    if (!l.sourceId) continue;
    if (l.sourceType === "CHALLAN") {
      const key = `${l.sourceId}:${l.accountId}`;
      dailyPostingNetByChallanAccount.set(key, round2((dailyPostingNetByChallanAccount.get(key) || 0) + Number(l.debit) - Number(l.credit)));
    } else if (l.sourceType === "BILTY") {
      if (paidPayerAccountIdsByBiltyId.get(l.sourceId)?.has(l.accountId)) continue; // PAID exclusion.
      const key = `${l.sourceId}:${l.accountId}`;
      dailyPostingNetByBiltyAccount.set(key, round2((dailyPostingNetByBiltyAccount.get(key) || 0) + Number(l.debit) - Number(l.credit)));
    }
  }

  // ------------------------------------------------------------
  // 4.6. "Verified advance" - the EXACT SAME figure finalize-
  //    settlement itself already netted into
  //    Challan.outstandingReceivable/outstandingPayable at settlement
  //    time (see app/api/challan/[id]/finalize-settlement/route.ts's
  //    own verifiedAdvanceByAccountId): ANY Daily Posting activity
  //    ever recorded against a party's account, with NO
  //    sourceType/sourceId scoping at all. This is the ONLY way a
  //    component that was already fully covered by a pre-existing
  //    advance BEFORE this Challan was even settled - and so never
  //    got its own post-settlement, document-tagged Daily Posting
  //    line - still shows correctly here instead of appearing newly,
  //    wrongly DUE. Computed per account, batched, only for accounts
  //    this function might actually need it for (every OLD-mechanism
  //    attributed party, resolved just below).
  // ------------------------------------------------------------
  async function getVerifiedAdvanceByAccountId(accountIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (accountIds.length === 0) return map;
    const lines = await prisma.journalLine.findMany({
      where: { accountId: { in: accountIds }, journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false } },
      select: { accountId: true, debit: true, credit: true },
    });
    for (const l of lines) {
      map.set(l.accountId, round2((map.get(l.accountId) || 0) + Number(l.debit) - Number(l.credit)));
    }
    for (const [accountId, net] of map) {
      map.set(accountId, Math.max(0, net));
    }
    return map;
  }

  // ------------------------------------------------------------
  // 5. Assemble, falling back to the OLD single-payer mechanism only
  //    for a component with ZERO live rows on an already-settled
  //    Challan - never for an unsettled one (nothing to fall back
  //    to), never fabricated.
  // ------------------------------------------------------------
  // Raw candidate account IDs per Challan, gathered while building
  // bilties/carrierRent below - resolved into actual net figures in
  // ONE pass per Challan afterward (step 6), then given names in one
  // final batched query across every Challan (step 7).
  const candidateAccountIdsByChallan = new Map<string, Set<string>>();

  // Accounts behind a tier-2/tier-3 (Daily-Posting- or verified-
  // advance-sourced) payer entry from buildComponentSummary() below -
  // these arrive with partyName: "" and are named in step 7's one
  // batched query, alongside partyNet.
  const pendingNameAccountIds = new Set<string>();

  for (const challan of challans) {
    const candidates = new Set<string>();
    candidateAccountIdsByChallan.set(challan.id, candidates);

    const bilties: BiltySettlementSummary[] = [];

    // The OLD single-payer mechanism's default party for EACH Bilty's
    // Collection, and for this Challan's Carrier Rent - resolved
    // UNCONDITIONALLY (not just when no live rows exist for that
    // component), because a party's residual OLD-mechanism
    // attribution (e.g. syncCollectionFloorForNewEngineRows()'s
    // toPay-floor stand-in) can remain non-zero even once the new multi-payer
    // engine already has its own rows for that same component - see
    // PartyNetEntry's own doc comment above for why this must be
    // considered for an authoritative party net, not just for the
    // historical-fallback ComponentSummary path.
    const oldPartyLookupRequests: { key: string; component: "COLLECTION" | "CARRIER_RENT"; incomeOrExpenseAccountId: string; biltyId: string | null }[] = [];
    if (challan.isSettled && challan.settlementJournalEntryId) {
      if (bookingIncomeAccount) {
        for (const cb of challan.bilties) {
          if (cb.bilty.isDeleted) continue;
          oldPartyLookupRequests.push({
            key: cb.bilty.id,
            component: "COLLECTION",
            incomeOrExpenseAccountId: bookingIncomeAccount.id,
            biltyId: cb.bilty.id,
          });
        }
      }
      if (carrierRentExpenseAccount && Number(challan.carrierRent || 0) > 0) {
        oldPartyLookupRequests.push({
          key: "CARRIER_RENT",
          component: "CARRIER_RENT",
          incomeOrExpenseAccountId: carrierRentExpenseAccount.id,
          biltyId: null,
        });
      }
    }
    const oldPartyResults =
      oldPartyLookupRequests.length > 0
        ? await getSettledPartyAccountIdsBatch(
            prisma,
            challan.id,
            challan.settlementJournalEntryId as string,
            oldPartyLookupRequests.map((r) => ({ component: r.component, incomeOrExpenseAccountId: r.incomeOrExpenseAccountId, biltyId: r.biltyId }))
          )
        : [];
    const oldCollectionPartyByBiltyId = new Map<string, string | null>();
    let oldCarrierRentPartyAccountId: string | null = null;
    oldPartyLookupRequests.forEach((r, i) => {
      if (r.component === "COLLECTION") oldCollectionPartyByBiltyId.set(r.key, oldPartyResults[i]);
      else oldCarrierRentPartyAccountId = oldPartyResults[i];
    });
    for (const id of oldPartyResults) {
      if (id) candidates.add(id);
    }

    // Tier 3 ("verified advance") for every OLD-mechanism attributed
    // party on THIS Challan, resolved once, up front - never re-run
    // per Bilty/component below.
    const verifiedAdvanceByAccountId = await getVerifiedAdvanceByAccountId(
      [...new Set(oldPartyResults.filter((id): id is string => !!id))]
    );

    // Builds a component's paidOrReceived/remaining/payers from the
    // THREE tiers this module's own doc comment describes - STRICTLY
    // in precedence order, never summed across tiers (tier 2's "all
    // Daily Posting ever on this account" would otherwise double-
    // count a line tier 1 already found).
    function buildComponentSummary(
      total: number,
      livePayers: SettlementPayerBreakdown[],
      oldPartyAccountId: string | null,
      dpSign: "RECEIVE" | "PAY",
      taggedDpMap: Map<string, number>,
      taggedDpKey: string
    ): ComponentSummary {
      if (livePayers.length > 0) {
        const paidOrReceived = Math.min(total, round2(livePayers.reduce((s, p) => s + p.amount, 0)));
        return {
          total,
          paidOrReceived,
          remaining: Math.max(0, round2(total - paidOrReceived)),
          payers: livePayers,
          isHistoricalFallback: false,
        };
      }

      if (!oldPartyAccountId) return emptyComponent(total);

      const taggedNet = taggedDpMap.get(`${taggedDpKey}:${oldPartyAccountId}`) || 0;
      const taggedAmount = round2(dpSign === "RECEIVE" ? Math.max(0, -taggedNet) : Math.max(0, taggedNet));
      const verifiedAdvance = verifiedAdvanceByAccountId.get(oldPartyAccountId) || 0;
      // Tagged (document-specific) activity wins when present; the
      // all-time verified advance is consulted ONLY when nothing
      // tagged was found - never both added together.
      const paidOrReceived = Math.min(total, round2(taggedAmount > 0.009 ? taggedAmount : verifiedAdvance));

      return {
        total,
        paidOrReceived,
        remaining: Math.max(0, round2(total - paidOrReceived)),
        payers: paidOrReceived > 0.009 ? [{ accountId: oldPartyAccountId, partyId: null, partyName: "", amount: paidOrReceived }] : [],
        isHistoricalFallback: true,
      };
    }

    for (const cb of challan.bilties) {
      const bilty = cb.bilty;
      if (bilty.isDeleted) continue;

      const toPay = round2(Number(bilty.toPay || 0));
      const collectionKey: RowGroupKey = `${challan.id}:COLLECTION:${bilty.id}`;
      const collectionPayers = payersFor(collectionKey);
      for (const p of collectionPayers) candidates.add(p.accountId);
      const oldCollectionAccountId = oldCollectionPartyByBiltyId.get(bilty.id) || null;

      const toPaySummary = buildComponentSummary(toPay, collectionPayers, oldCollectionAccountId, "RECEIVE", dailyPostingNetByBiltyAccount, bilty.id);
      for (const p of toPaySummary.payers) if (p.partyName === "") pendingNameAccountIds.add(p.accountId);

      if (toPaySummary.remaining > 0.009 && oldCollectionAccountId) {
        const account = await prisma.account.findUnique({
          where: { id: oldCollectionAccountId },
          select: { accountName: true, party: { select: { partyName: true } } },
        });
        const residualPartyName = account?.party?.partyName || account?.accountName || null;
        if (residualPartyName) {
          toPaySummary.residualPartyName = residualPartyName;
        }
      }

      const pv = paidVerificationByBiltyId.get(bilty.id);
      bilties.push({
        biltyId: bilty.id,
        biltyNo: bilty.biltyNo,
        rent: round2(Number(bilty.total || 0)),
        paidAmount: pv?.paidAmount ?? 0,
        paidVerified: pv?.verifiedReceivedAmount ?? 0,
        paidUnverified: pv?.unverifiedAmount ?? 0,
        paidResponsiblePartyName: pv?.responsiblePartyName ?? null,
        paidIsInconsistent: pv?.isInconsistent ?? false,
        toPay: toPaySummary,
      });
    }

    const carrierRentTotal = round2(Number(challan.carrierRent || 0));
    const carrierRentKey: RowGroupKey = `${challan.id}:CARRIER_RENT:`;
    const carrierRentPayers = payersFor(carrierRentKey);
    for (const p of carrierRentPayers) candidates.add(p.accountId);

    // The residual claimant's account - the SAME party
    // ensureOldAttributionWithinFloor() itself tracks (already
    // resolved above, unconditionally, for the partyNet candidate
    // set), reused here for the DISPLAY-only residualPartyName -
    // still gated on remaining > 0, unlike the resolution itself.
    const carrierRentOldPartyAccountId = oldCarrierRentPartyAccountId;

    const carrierRentSummary = buildComponentSummary(carrierRentTotal, carrierRentPayers, carrierRentOldPartyAccountId, "PAY", dailyPostingNetByChallanAccount, challan.id);
    for (const p of carrierRentSummary.payers) if (p.partyName === "") pendingNameAccountIds.add(p.accountId);

    if (carrierRentSummary.remaining > 0 && carrierRentOldPartyAccountId) {
      const account = await prisma.account.findUnique({
        where: { id: carrierRentOldPartyAccountId },
        select: { accountName: true, party: { select: { partyName: true } } },
      });
      const residualPartyName = account?.party?.partyName || account?.accountName || null;
      if (residualPartyName) {
        carrierRentSummary.residualPartyName = residualPartyName;
      }
    }

    result[challan.id] = { challanId: challan.id, bilties, carrierRent: carrierRentSummary, partyNet: [] };
  }

  // ------------------------------------------------------------
  // 5.5. Cross-component Daily Posting net, per Challan - unlike
  //    buildComponentSummary() above (which keeps BILTY-sourced and
  //    CHALLAN-sourced lines in two SEPARATE maps, never mixed, so
  //    Carrier Rent and To-Pay never leak into each other), partyNet
  //    below wants this Challan's party's TOTAL Daily Posting
  //    activity regardless of which component it was tagged to - so
  //    the two already-computed maps are merged here, once, into a
  //    THIRD, Challan-only view (a Bilty-sourced line's owner Challan
  //    is resolved via biltyIdToChallanId).
  // ------------------------------------------------------------
  const biltyIdToChallanId = new Map<string, string>();
  for (const c of challans) {
    for (const cb of c.bilties) {
      if (!cb.bilty.isDeleted) biltyIdToChallanId.set(cb.bilty.id, c.id);
    }
  }

  const dailyPostingNetByChallanAccountCombined = new Map<string, number>(dailyPostingNetByChallanAccount);
  for (const [key, value] of dailyPostingNetByBiltyAccount) {
    const [biltyId, accountId] = key.split(":");
    const owningChallanId = biltyIdToChallanId.get(biltyId);
    if (!owningChallanId) continue;
    const combinedKey = `${owningChallanId}:${accountId}`;
    dailyPostingNetByChallanAccountCombined.set(combinedKey, round2((dailyPostingNetByChallanAccountCombined.get(combinedKey) || 0) + value));
  }

  // ------------------------------------------------------------
  // 6. Cross-component PARTY NET, per Challan - the authoritative
  //    "this party's total net across every Collection + Carrier
  //    Rent JournalLine on this Challan" figure, computed the SAME
  //    way getPartyNetFromSettlement() does (same referenceType set,
  //    same referenceId scope), batched across every candidate
  //    account gathered above in ONE query per Challan - EXCLUDING
  //    any JournalEntry that belongs to a PAID SettlementPayment's
  //    own lifecycle (create/correction/reversal), since PAID is
  //    informational/context only per the approved business rule and
  //    must never be silently netted into a party's position. The
  //    settlement-side computation below is UNCHANGED from before
  //    Daily Posting was incorporated - only the final merge step
  //    (after this loop's own per-Challan work) adds in step 5.5's
  //    already-batched Daily Posting contribution.
  // ------------------------------------------------------------
  for (const challan of challans) {
    const candidates = candidateAccountIdsByChallan.get(challan.id) || new Set<string>();
    // A party may have Daily Posting activity against this Challan
    // with no settlement-side candidate lookup ever having found them
    // (defensive - in practice this account is virtually always
    // already a candidate) - union them in so they are never missed.
    for (const key of dailyPostingNetByChallanAccountCombined.keys()) {
      if (key.startsWith(`${challan.id}:`)) candidates.add(key.slice(challan.id.length + 1));
    }
    const candidateList = [...candidates];
    if (candidateList.length === 0) continue;

    const biltyIds = challan.bilties.filter((cb) => !cb.bilty.isDeleted).map((cb) => cb.bilty.id);
    const referenceIds = [challan.id, ...biltyIds];

    // PAID rows for this Challan's Bilties, and their own correction/
    // reversal entries (tagged sourceType:"SETTLEMENT_PAYMENT",
    // sourceId:<row id> - the same convention updateSettlementPaymentAmount()/
    // deleteSettlementPayment() already use for EVERY component, which
    // is what makes this a reliable, precise exclusion rather than a
    // description-text guess).
    const paidRows = biltyIds.length > 0
      ? await prisma.settlementPayment.findMany({
          where: { component: "PAID", biltyId: { in: biltyIds } },
          select: { id: true, journalEntryId: true },
        })
      : [];
    const excludedJournalEntryIds = new Set(paidRows.map((r) => r.journalEntryId));
    if (paidRows.length > 0) {
      const paidCorrectionLines = await prisma.journalLine.findMany({
        where: { sourceType: "SETTLEMENT_PAYMENT", sourceId: { in: paidRows.map((r) => r.id) } },
        select: { journalEntryId: true },
      });
      for (const l of paidCorrectionLines) excludedJournalEntryIds.add(l.journalEntryId);
    }

    const lines = await prisma.journalLine.findMany({
      where: {
        accountId: { in: candidateList },
        journalEntry: {
          isDeleted: false,
          referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES },
          referenceId: { in: referenceIds },
        },
      },
      select: { accountId: true, debit: true, credit: true, journalEntryId: true },
    });

    const netByAccountId = new Map<string, number>();
    for (const l of lines) {
      if (excludedJournalEntryIds.has(l.journalEntryId)) continue;
      const current = netByAccountId.get(l.accountId) || 0;
      netByAccountId.set(l.accountId, round2(current + Number(l.debit) - Number(l.credit)));
    }

    // Merge in step 5.5's already-batched Daily Posting contribution -
    // added once, here, never touching the settlement-side sum above.
    // finalPartyNet = existingSettlementPartyNet + challanAttributedDailyPostingPartyNet.
    for (const accountId of candidateList) {
      const dpContribution = dailyPostingNetByChallanAccountCombined.get(`${challan.id}:${accountId}`) || 0;
      if (dpContribution === 0) continue;
      netByAccountId.set(accountId, round2((netByAccountId.get(accountId) || 0) + dpContribution));
    }

    const nonZero = [...netByAccountId.entries()].filter(([, net]) => Math.abs(net) > 0.009);
    result[challan.id].partyNet = nonZero.map(([accountId, net]) => ({
      accountId,
      partyId: null,
      partyName: "",
      net,
      direction: net > 0 ? "RECEIVABLE" : "PAYABLE",
    }));
  }

  // ------------------------------------------------------------
  // 7. Party names for every partyNet entry AND every tier-2/tier-3
  //    payer entry (buildComponentSummary() above, flagged via
  //    pendingNameAccountIds) across every Challan, in ONE final
  //    query (accounts already covered by payerAccountById are looked
  //    up again here too - a small, bounded overlap, not worth a
  //    second map/merge for the sizes involved).
  // ------------------------------------------------------------
  const allPartyNetAccountIds = [
    ...new Set([
      ...Object.values(result).flatMap((r) => r.partyNet.map((p) => p.accountId)),
      ...pendingNameAccountIds,
    ]),
  ];
  if (allPartyNetAccountIds.length > 0) {
    const accounts = await prisma.account.findMany({
      where: { id: { in: allPartyNetAccountIds } },
      select: { id: true, accountName: true, party: { select: { id: true, partyName: true } } },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    for (const summary of Object.values(result)) {
      for (const entry of summary.partyNet) {
        const account = accountById.get(entry.accountId);
        entry.partyId = account?.party?.id || null;
        entry.partyName = account?.party?.partyName || account?.accountName || "Party";
      }
      for (const b of summary.bilties) {
        for (const payer of b.toPay.payers) {
          if (payer.partyName !== "") continue;
          const account = accountById.get(payer.accountId);
          payer.partyId = account?.party?.id || null;
          payer.partyName = account?.party?.partyName || account?.accountName || "Party";
        }
      }
      for (const payer of summary.carrierRent.payers) {
        if (payer.partyName !== "") continue;
        const account = accountById.get(payer.accountId);
        payer.partyId = account?.party?.id || null;
        payer.partyName = account?.party?.partyName || account?.accountName || "Party";
      }
    }
  }

  return result;
}

export async function computeChallanSettlementSummary(challanId: string): Promise<ChallanSettlementSummary | null> {
  const batch = await computeChallanSettlementSummaryBatch([challanId]);
  return batch[challanId] || null;
}
