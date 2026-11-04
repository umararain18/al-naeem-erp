import { prisma } from "@/lib/prisma";
import { getBiltyPaidVerificationBatch } from "@/lib/bilty-paid-verification";
import {
  getSettledPartyAccountIdsForChallansBatch,
  SETTLEMENT_NET_REFERENCE_TYPES,
  type SettledPartyLookupRequest,
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
// PRECEDENCE (per Bilty/Challan, per component):
//   1. Live SettlementPayment rows for that component, if any exist -
//      these are the ONLY source of "paidOrReceived". A SettlementPayment
//      row is a real, explicit payment record (see lib/settlement-
//      payments.ts).
//   2. Otherwise: zero payment activity. The settlement's own
//      reclassification entry (the one that moves the component's
//      amount from the booking/expense account onto a party account at
//      Final Settlement time) is NEVER treated as a payment - it only
//      records who currently owes/is owed the amount, not that it was
//      actually paid.
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
  /** Always false now - kept for API shape compatibility. paidOrReceived
   * only ever comes from live SettlementPayment rows (see PRECEDENCE
   * above); there is no fallback source any more. */
  isHistoricalFallback: boolean;
  /** CARRIER_RENT only: the economic residual claimant (the party the
   * Carrier Rent floor logic - lib/settlement-payments.ts - still
   * attributes the unpaid remainder to, i.e. whoever finalize-
   * settlement established as the default party). Present only when
   * `remaining > 0` and that party could be safely resolved; never a
   * guess - left unset otherwise. See ensureOldAttributionWithinFloor()
   * for why this is always the SAME party the floor mechanism tracks. */
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
  // Additive - lib/challan-position.ts's own "Receivable ... (Bilty
  // paid, not received)" line needs the ACCOUNT id (getBiltyPaidVerification
  // already resolves it; previously dropped before reaching this
  // struct, since nothing here needed it until now).
  paidResponsiblePartyAccountId: string | null;
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
        where: { challanId: { in: challanIds }, isActive: true },
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
  // 4. Paid verification - ONE batched call across every Bilty on
  //    this page (see lib/bilty-paid-verification.ts's own doc
  //    comment on getBiltyPaidVerificationBatch - this used to be a
  //    per-Bilty Promise.all, each call issuing ~6 of its own
  //    queries; confirmed the dominant cost of GET /api/challan at
  //    production-like volume).
  // ------------------------------------------------------------
  const paidVerificationByBiltyId = await getBiltyPaidVerificationBatch(prisma, allBiltyIds);

  // ------------------------------------------------------------
  // 5a. The OLD single-payer mechanism's default party for EACH
  //    Bilty's Collection, and for each Challan's Carrier Rent -
  //    gathered as plain REQUESTS first (pure, no DB access), then
  //    resolved for every Challan in ONE query via
  //    getSettledPartyAccountIdsForChallansBatch() below - this used
  //    to call getSettledPartyAccountIdsBatch() once per SETTLED
  //    Challan in a loop (confirmed N+1 at volume). Requested
  //    UNCONDITIONALLY (not just when no live rows exist for that
  //    component), because a party's residual OLD-mechanism
  //    attribution (e.g. syncCollectionFloorForNewEngineRows()'s
  //    toPay-floor stand-in) can remain non-zero even once the new
  //    multi-payer engine already has its own rows for that same
  //    component - see PartyNetEntry's own doc comment above for why
  //    this must be considered for an authoritative party net, not
  //    just for the historical-fallback ComponentSummary path.
  // ------------------------------------------------------------
  type OldPartyLookupRequest = { key: string; component: "COLLECTION" | "CARRIER_RENT"; incomeOrExpenseAccountId: string; biltyId: string | null };
  const oldPartyLookupRequestsByChallan = new Map<string, OldPartyLookupRequest[]>();
  const challanRequestsForBatch = new Map<string, { settlementJournalEntryId: string; requests: SettledPartyLookupRequest[] }>();

  for (const challan of challans) {
    const oldPartyLookupRequests: OldPartyLookupRequest[] = [];
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
    oldPartyLookupRequestsByChallan.set(challan.id, oldPartyLookupRequests);
    if (oldPartyLookupRequests.length > 0) {
      challanRequestsForBatch.set(challan.id, {
        settlementJournalEntryId: challan.settlementJournalEntryId as string,
        requests: oldPartyLookupRequests.map((r) => ({ component: r.component, incomeOrExpenseAccountId: r.incomeOrExpenseAccountId, biltyId: r.biltyId })),
      });
    }
  }

  const oldPartyResultsByChallan =
    challanRequestsForBatch.size > 0 ? await getSettledPartyAccountIdsForChallansBatch(prisma, challanRequestsForBatch) : new Map<string, (string | null)[]>();

  // ------------------------------------------------------------
  // 5b. Assemble, falling back to the OLD single-payer mechanism only
  //    for a component with ZERO live rows on an already-settled
  //    Challan - never for an unsettled one (nothing to fall back
  //    to), never fabricated. Purely in-memory from here on - every
  //    DB call this loop used to make is now one of the already-
  //    batched lookups above/below.
  // ------------------------------------------------------------
  // Raw candidate account IDs per Challan, gathered while building
  // bilties/carrierRent below - resolved into actual net figures in
  // ONE pass per Challan afterward (step 6), then given names in one
  // final batched query across every Challan (step 7).
  const candidateAccountIdsByChallan = new Map<string, Set<string>>();
  // CARRIER_RENT's own OLD-mechanism residual party account id, per
  // Challan with remaining > 0 - names resolved once, in step 7,
  // alongside every other partyNet account name (never a per-Challan
  // account.findUnique()).
  const carrierRentOldPartyAccountIdByChallan = new Map<string, string>();

  for (const challan of challans) {
    const candidates = new Set<string>();
    candidateAccountIdsByChallan.set(challan.id, candidates);

    const bilties: BiltySettlementSummary[] = [];

    const oldPartyLookupRequests = oldPartyLookupRequestsByChallan.get(challan.id) || [];
    const oldPartyResults = oldPartyResultsByChallan.get(challan.id) || [];
    const oldCollectionPartyByBiltyId = new Map<string, string | null>();
    let oldCarrierRentPartyAccountId: string | null = null;
    oldPartyLookupRequests.forEach((r, i) => {
      if (r.component === "COLLECTION") oldCollectionPartyByBiltyId.set(r.key, oldPartyResults[i]);
      else oldCarrierRentPartyAccountId = oldPartyResults[i];
    });
    for (const id of oldPartyResults) {
      if (id) candidates.add(id);
    }

    for (const cb of challan.bilties) {
      const bilty = cb.bilty;
      if (bilty.isDeleted) continue;

      const toPay = round2(Number(bilty.toPay || 0));
      const collectionKey: RowGroupKey = `${challan.id}:COLLECTION:${bilty.id}`;
      const collectionPayers = payersFor(collectionKey);
      for (const p of collectionPayers) candidates.add(p.accountId);

      let toPaySummary: ComponentSummary;
      if (collectionPayers.length > 0) {
        const paidOrReceived = round2(collectionPayers.reduce((s, p) => s + p.amount, 0));
        toPaySummary = {
          total: toPay,
          paidOrReceived,
          remaining: Math.max(0, round2(toPay - paidOrReceived)),
          payers: collectionPayers,
          isHistoricalFallback: false,
        };
      } else {
        toPaySummary = emptyComponent(toPay);
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
        paidResponsiblePartyAccountId: pv?.responsiblePartyAccountId ?? null,
        paidIsInconsistent: pv?.isInconsistent ?? false,
        toPay: toPaySummary,
      });
    }

    const carrierRentTotal = round2(Number(challan.carrierRent || 0));
    const carrierRentKey: RowGroupKey = `${challan.id}:CARRIER_RENT:`;
    const carrierRentPayers = payersFor(carrierRentKey);
    for (const p of carrierRentPayers) candidates.add(p.accountId);

    let carrierRentSummary: ComponentSummary;
    // The residual claimant's account - the SAME party
    // ensureOldAttributionWithinFloor() itself tracks (already
    // resolved above, unconditionally, for the partyNet candidate
    // set), reused here for the DISPLAY-only residualPartyName -
    // still gated on remaining > 0, unlike the resolution itself.
    const carrierRentOldPartyAccountId = oldCarrierRentPartyAccountId;

    if (carrierRentPayers.length > 0) {
      const paidOrReceived = round2(carrierRentPayers.reduce((s, p) => s + p.amount, 0));
      carrierRentSummary = {
        total: carrierRentTotal,
        paidOrReceived,
        remaining: Math.max(0, round2(carrierRentTotal - paidOrReceived)),
        payers: carrierRentPayers,
        isHistoricalFallback: false,
      };
    } else {
      carrierRentSummary = emptyComponent(carrierRentTotal);
    }

    if (carrierRentSummary.remaining > 0 && carrierRentOldPartyAccountId) {
      // Name resolved later, in ONE batched query (step 7) across
      // every Challan's own residual account - never a per-Challan
      // account.findUnique() here.
      carrierRentOldPartyAccountIdByChallan.set(challan.id, carrierRentOldPartyAccountId);
    }

    result[challan.id] = { challanId: challan.id, bilties, carrierRent: carrierRentSummary, partyNet: [] };
  }

  // ------------------------------------------------------------
  // 5.5. Daily Posting activity attributable to each Challan - batched
  //    ONCE across every Challan/Bilty on this page (never per-
  //    Challan), mirroring computeChallanFinancialsBatch()'s own
  //    proven correlation pattern exactly: Daily Posting cannot be
  //    found via JournalEntry.referenceType/referenceId (its
  //    referenceId is the Cash/Bank account, not a Challan/Bilty) -
  //    only JournalLine.sourceType/sourceId ("CHALLAN"/challanId or
  //    "BILTY"/one of its Bilty ids) correlates it. Only the PARTY-
  //    side line of each matched entry is summed (never the Cash/Bank
  //    side) - same debit-minus-credit sign convention as the
  //    settlement-side net below, so the two can be added directly.
  //    A "DIRECT" Daily Posting entry, or one sourced to an unrelated
  //    Challan/Bilty, never matches this query at all.
  //
  //    PAID exclusion for Daily Posting CANNOT reuse the settlement-
  //    side JournalEntry-id exclusion below: a PAID verification
  //    receipt is posted as its OWN, separate DAILY_POSTING entry,
  //    tagged sourceType:"BILTY"/sourceId:<biltyId> - the EXACT SAME
  //    tag shape a legitimate Collection Daily Posting on that same
  //    Bilty also uses (see lib/bilty-paid-verification.ts's own
  //    header comment: "a JournalLine tagged sourceType 'BILTY',
  //    sourceId = this Bilty, crediting the resolved Paid-responsible
  //    Party's account"). The tag alone cannot distinguish them - only
  //    the ACCOUNT can. So the exclusion here is precise and direct:
  //    the authoritative SettlementPayment.payerAccountId for every
  //    component:"PAID" row, per Bilty (never inferred from a
  //    JournalEntry/description shape, which would risk excluding a
  //    legitimate Collection payer's own Daily Posting if that same
  //    Bilty also has ANY PAID lifecycle event, since both components
  //    share referenceType "SETTLEMENT_PAYMENT").
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

  const biltyIdToChallanId = new Map<string, string>();
  for (const c of challans) {
    for (const cb of c.bilties) {
      if (!cb.bilty.isDeleted) biltyIdToChallanId.set(cb.bilty.id, c.id);
    }
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

  // Keyed `${challanId}:${accountId}` - the Daily Posting contribution
  // to add to that party's settlement-derived net for that Challan.
  const dailyPostingNetByChallanAccount = new Map<string, number>();
  for (const l of dailyPostingLines) {
    if (l.account.category !== "PARTY") continue; // never the Cash/Bank side.
    if (!l.sourceId) continue;
    // PAID exclusion: only meaningful (and only ambiguous) for a
    // BILTY-sourced line - a CHALLAN-sourced Carrier Rent Daily
    // Posting can never collide with a Bilty-scoped PAID receipt.
    if (l.sourceType === "BILTY" && paidPayerAccountIdsByBiltyId.get(l.sourceId)?.has(l.accountId)) continue;
    const owningChallanId = l.sourceType === "CHALLAN" ? l.sourceId : biltyIdToChallanId.get(l.sourceId);
    if (!owningChallanId) continue;
    const key = `${owningChallanId}:${l.accountId}`;
    dailyPostingNetByChallanAccount.set(
      key,
      round2((dailyPostingNetByChallanAccount.get(key) || 0) + Number(l.debit) - Number(l.credit))
    );
  }

  // ------------------------------------------------------------
  // 6. Cross-component PARTY NET, per Challan - the authoritative
  //    "this party's total net across every Collection + Carrier
  //    Rent JournalLine on this Challan" figure, computed the SAME
  //    way getPartyNetFromSettlement() does (same referenceType set,
  //    same referenceId scope) - EXCLUDING any JournalEntry that
  //    belongs to a PAID SettlementPayment's own lifecycle (create/
  //    correction/reversal), since PAID is informational/context only
  //    per the approved business rule and must never be silently
  //    netted into a party's position. Every query below is now
  //    batched ONCE across every Challan on this page (previously one
  //    PAID-rows query, one correction-lines query, and one lines
  //    query PER Challan - confirmed N+1 at volume) - only the final
  //    per-Challan merge/filter step stays a loop, and it is now pure
  //    in-memory work, no DB access.
  // ------------------------------------------------------------

  // A party may have Daily Posting activity against a Challan with no
  // settlement-side candidate lookup ever having found them
  // (defensive - in practice this account is virtually always already
  // a candidate) - union them in so they are never missed, same as
  // before, just done as its own pass ahead of the global queries
  // below instead of inside the per-Challan loop.
  for (const challan of challans) {
    const candidates = candidateAccountIdsByChallan.get(challan.id) || new Set<string>();
    for (const key of dailyPostingNetByChallanAccount.keys()) {
      if (key.startsWith(`${challan.id}:`)) candidates.add(key.slice(challan.id.length + 1));
    }
    candidateAccountIdsByChallan.set(challan.id, candidates);
  }

  // PAID rows (and their own correction/reversal entries) for every
  // Bilty on this page at once, grouped back to each Bilty's owning
  // Challan via biltyIdToChallanId (built above, in step 5.5) - same
  // exclusion-set shape as before, just assembled from one global
  // fetch instead of one query pair per Challan.
  const allPaidRowsForNetExclusion =
    allBiltyIds.length > 0
      ? await prisma.settlementPayment.findMany({
          where: { component: "PAID", biltyId: { in: allBiltyIds } },
          select: { id: true, journalEntryId: true, biltyId: true },
        })
      : [];
  const excludedJournalEntryIdsByChallan = new Map<string, Set<string>>();
  const paidRowIdToChallanId = new Map<string, string>();
  for (const row of allPaidRowsForNetExclusion) {
    if (!row.biltyId) continue;
    const owningChallanId = biltyIdToChallanId.get(row.biltyId);
    if (!owningChallanId) continue;
    paidRowIdToChallanId.set(row.id, owningChallanId);
    const set = excludedJournalEntryIdsByChallan.get(owningChallanId) || new Set<string>();
    set.add(row.journalEntryId);
    excludedJournalEntryIdsByChallan.set(owningChallanId, set);
  }
  const allPaidRowIds = allPaidRowsForNetExclusion.map((r) => r.id);
  const allPaidCorrectionLines =
    allPaidRowIds.length > 0
      ? await prisma.journalLine.findMany({
          where: { sourceType: "SETTLEMENT_PAYMENT", sourceId: { in: allPaidRowIds } },
          select: { journalEntryId: true, sourceId: true },
        })
      : [];
  for (const l of allPaidCorrectionLines) {
    const owningChallanId = l.sourceId ? paidRowIdToChallanId.get(l.sourceId) : undefined;
    if (!owningChallanId) continue;
    const set = excludedJournalEntryIdsByChallan.get(owningChallanId) || new Set<string>();
    set.add(l.journalEntryId);
    excludedJournalEntryIdsByChallan.set(owningChallanId, set);
  }

  // The settlement-side PARTY NET lines themselves, across every
  // Challan's own candidate accounts at once - `referenceId` is
  // either a Challan id directly or one of its Bilty ids (both
  // resolved back to the owning Challan via the same Sets/map used
  // throughout this function), and `accountId` is re-checked against
  // THIS Challan's own candidate set below (never another Challan's -
  // the global fetch below only narrows which ROWS are even possible
  // candidates anywhere on this page).
  const challanIdSet = new Set(challanIds);
  const allCandidateAccountIds = [...new Set([...candidateAccountIdsByChallan.values()].flatMap((s) => [...s]))];
  const allReferenceIds = [...challanIds, ...allBiltyIds];
  const allPartyNetLines =
    allCandidateAccountIds.length > 0 && allReferenceIds.length > 0
      ? await prisma.journalLine.findMany({
          where: {
            accountId: { in: allCandidateAccountIds },
            journalEntry: {
              isDeleted: false,
              referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES },
              referenceId: { in: allReferenceIds },
            },
          },
          select: { accountId: true, debit: true, credit: true, journalEntryId: true, journalEntry: { select: { referenceId: true } } },
        })
      : [];
  const partyNetLinesByChallan = new Map<string, { accountId: string; debit: number; credit: number; journalEntryId: string }[]>();
  for (const l of allPartyNetLines) {
    const refId = l.journalEntry.referenceId;
    if (!refId) continue;
    const owningChallanId = challanIdSet.has(refId) ? refId : biltyIdToChallanId.get(refId);
    if (!owningChallanId) continue;
    const list = partyNetLinesByChallan.get(owningChallanId) || [];
    list.push({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), journalEntryId: l.journalEntryId });
    partyNetLinesByChallan.set(owningChallanId, list);
  }

  for (const challan of challans) {
    const candidates = candidateAccountIdsByChallan.get(challan.id) || new Set<string>();
    const candidateList = [...candidates];
    if (candidateList.length === 0) continue;

    const excludedJournalEntryIds = excludedJournalEntryIdsByChallan.get(challan.id) || new Set<string>();
    const lines = (partyNetLinesByChallan.get(challan.id) || []).filter((l) => candidates.has(l.accountId));

    const netByAccountId = new Map<string, number>();
    for (const l of lines) {
      if (excludedJournalEntryIds.has(l.journalEntryId)) continue;
      const current = netByAccountId.get(l.accountId) || 0;
      netByAccountId.set(l.accountId, round2(current + l.debit - l.credit));
    }

    // Merge in step 5.5's already-batched Daily Posting contribution -
    // added once, here, never touching the settlement-side sum above.
    // finalPartyNet = existingSettlementPartyNet + challanAttributedDailyPostingPartyNet.
    for (const accountId of candidateList) {
      const dpContribution = dailyPostingNetByChallanAccount.get(`${challan.id}:${accountId}`) || 0;
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
  // 7. Party names for every partyNet entry across every Challan, AND
  //    every Carrier Rent residualPartyName (previously one
  //    account.findUnique() per Challan - step 5b above now only
  //    records the account id, resolved here instead), in ONE final
  //    query (accounts already covered by payerAccountById are looked
  //    up again here too - a small, bounded overlap, not worth a
  //    second map/merge for the sizes involved).
  // ------------------------------------------------------------
  const allPartyNetAccountIds = [
    ...new Set([...Object.values(result).flatMap((r) => r.partyNet.map((p) => p.accountId)), ...carrierRentOldPartyAccountIdByChallan.values()]),
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
    }
    for (const [challanId, accountId] of carrierRentOldPartyAccountIdByChallan) {
      const account = accountById.get(accountId);
      const residualPartyName = account?.party?.partyName || account?.accountName || null;
      if (residualPartyName) {
        result[challanId].carrierRent.residualPartyName = residualPartyName;
      }
    }
  }

  return result;
}

export async function computeChallanSettlementSummary(challanId: string): Promise<ChallanSettlementSummary | null> {
  const batch = await computeChallanSettlementSummaryBatch([challanId]);
  return batch[challanId] || null;
}
