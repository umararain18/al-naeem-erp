import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findSettledPartyAccountId } from "@/lib/settlement-correction";
import { getActiveSettlementPayers } from "@/lib/settlement-payments";
import { getAllocatedAmountForDocument } from "@/lib/payment-allocation";
import { getBillPaymentState } from "@/lib/bill-accounting";
import { getPhonchPaymentState } from "@/lib/phonch-accounting";
import { getPrivatePhonchPaymentState, getPrivatePhonchDeliveryRecoveryState } from "@/lib/private-phonch-accounting";

// ============================================================
// PARTY OUTSTANDING LEDGER (document-level, read-only)
//
// This is a NEW, additive reporting layer. It never creates, edits,
// or deletes a JournalEntry/JournalLine/SettlementPayment, and it
// never changes any existing file's behavior - it only READS from
// the SAME authoritative sources the rest of the app already trusts:
//
//  - CARRIER_RENT (Challan, always Payable): resolved here with the
//    SAME primitives lib/payment-allocation.ts's own
//    resolveChallanTarget() uses (getActiveSettlementPayers /
//    findSettledPartyAccountId), but NOT via
//    getRemainingAllocatableAmountForDocument() itself - that
//    function deliberately REFUSES (throws MULTI_PAYER_NOT_ALLOCATABLE)
//    any Challan with an active multi-payer split, because Payment
//    Allocation's single-target-per-document model genuinely cannot
//    represent "this payment covers part of a multi-party split."
//    This Outstanding Ledger has no such constraint - it shows each
//    party their OWN resolved share - so it resolves every active
//    payer's own share directly instead of delegating to that
//    stricter function. Confirmed live: Challan 4028's Carrier Rent
//    is multi-payer (Nasir And Sons, Rs. 48,000) and was silently
//    dropped entirely when this first reused
//    getRemainingAllocatableAmountForDocument() before this fix.
//
//  - COLLECTION (Bilty Rent, always Receivable): resolved here with
//    the SAME two primitives lib/payment-allocation.ts's own
//    resolveBiltyTarget() uses internally for this exact component
//    (getActiveSettlementPayers / findSettledPartyAccountId) - but
//    WITHOUT that function's blending of Collection with Commission
//    into one target. That blending is correct for its own purpose
//    (matching a single incoming payment against one document as a
//    whole) but wrong for this one: Collection and Commission are
//    different accounting directions (Receivable vs Payable) and
//    are frequently resolved to two DIFFERENT parties (e.g. the
//    Consignor pays rent, a separate Agent earns commission) - see
//    the module-level note below. Treating them as two independent
//    rows from the start means neither is ever silently dropped as
//    "ambiguous" just because the other belongs to someone else.
//
//  - COMMISSION (Bilty Agent Commission, always Payable): resolved
//    directly from Bilty.agentPartyId/agentCommission - this is
//    ALWAYS available immediately from booking (see
//    app/api/bilty/route.ts's buildBiltyCommissionDescription() /
//    Task C of this session), independent of Challan/Settlement
//    entirely, so it is never gated on settlement the way
//    Collection/Carrier Rent legitimately are.
//
// KNOWN, DELIBERATE SCOPE LIMITATION (never silently worked around):
// a Bilty's Collection is only resolvable to a specific Party once
// EITHER the new multi-payer engine has an explicit payer row for it
// OR its Challan has been through Final Settlement (the OLD
// mechanism's only source of a resolved party). Before that point,
// the money is real (it sits in Gross Bilty Receivable) but this
// system genuinely has not yet decided WHICH party is responsible -
// guessing (e.g. "assume the Consignor") would risk sending a wrong
// or premature statement to the wrong party, which is explicitly
// forbidden by this feature's own spec. Such a Bilty simply does not
// appear here yet, for any party, until Settlement resolves it -
// exactly mirroring how the existing Normal Party Ledger's own
// Gross-account architecture already treats this period.
//
//  - BILL (Client Bill, always Receivable): resolved directly from
//    Bill.clientPartyId's own account (never the shared walk-in
//    BILL-WALKIN-RECEIVABLE system account - a walk-in Bill has no
//    real Party at all, so it can never appear for anyone here) via
//    the SAME getBillPaymentState() (lib/bill-accounting.ts) every
//    other Bill consumer (list/detail/PDF/search) already uses.
//    Bill.total does not exist as a stored field - it is always
//    computed fresh from BillItem rows, exactly like every other
//    Bill consumer already does.
//
//  - SHOWROOM_PHONCH (Transporter component): direction-CORRECTED
//    to RECEIVABLE, not Payable. Verified directly against the real
//    posting code (app/api/phonch/route.ts): the Transporter's own
//    account is DEBITED at creation (a receivable FROM the
//    Transporter - delivery charges/other-expense/claim recovery),
//    and lib/phonch-accounting.ts's own getPhonchPaymentState()
//    return type is literally `"RECEIVABLE" | "CLEARED"`, never
//    "PAYABLE". Showroom Phonch has no Clearing Agent component at
//    all (confirmed against both the Prisma schema and the posting
//    code - only a single Transporter party is ever involved).
//
//  - PRIVATE PHONCH (four independent, never-netted components):
//    Transporter Carrier Payable and per-Clearing-Agent CA Payable
//    (both Payable), Transporter Delivery Recovery and per-Clearing-
//    Agent CA Delivery Recovery (both Receivable) - resolved via the
//    SAME getPrivatePhonchPaymentState()/getPrivatePhonchDeliveryRecoveryState()
//    (lib/private-phonch-accounting.ts) every other Private Phonch
//    consumer already uses, aggregated per vehicle exactly like
//    lib/document-party-resolution.ts's own getPrivatePhonchEligibleParties()
//    does internally - but NOT by calling that function directly,
//    since its own DEBIT-direction branch mixes an uncapped "eligible
//    for a future deposit" CA Payable-context amount together with a
//    genuine Delivery Recovery remaining-due figure for the same
//    account (correct for its own "what can this Daily Posting count
//    against" purpose, wrong for an outstanding-due statement) - this
//    engine computes each of the four components independently
//    instead, using only the genuine remaining-due state functions.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type OutstandingDirection = "RECEIVABLE" | "PAYABLE";
export type OutstandingComponent =
  | "COLLECTION"
  | "COMMISSION"
  | "CARRIER_RENT"
  | "BILL"
  | "SHOWROOM_PHONCH"
  | "PRIVATE_PHONCH_CARRIER_PAYABLE"
  | "PRIVATE_PHONCH_CA_PAYABLE"
  | "PRIVATE_PHONCH_TRANSPORTER_RECOVERY"
  | "PRIVATE_PHONCH_CA_RECOVERY";

// One real, actual Daily Posting JournalLine contributing to a row's
// settledAmount - never a reclassification/responsibility-transition
// line. See buildDailyPostingDrillDown() below.
export interface OutstandingDrillDownEntry {
  journalLineId: string;
  journalEntryId: string;
  date: string;
  debit: number;
  credit: number;
  description: string;
  accountId: string;
  accountName: string;
}

export interface OutstandingRow {
  component: OutstandingComponent;
  direction: OutstandingDirection;
  documentType: "BILTY" | "CHALLAN" | "BILL" | "PHONCH" | "PRIVATE_PHONCH";
  documentNo: string;
  documentDate: Date;
  description: string;
  originalAmount: number;
  settledAmount: number;
  remainingAmount: number;
  // The real Daily Posting entries that make up settledAmount, ONLY
  // when every rupee of settledAmount is independently verified to
  // come from an actual cash movement (never a Settlement/Transition
  // reclassification) - see buildDailyPostingDrillDown()'s own
  // reconciliation check. null means "do not offer a drill-down here"
  // (settledAmount is 0, is not purely cash-backed, or could not be
  // reconciled exactly) - never a partial or guessed list.
  settledDrillDown: OutstandingDrillDownEntry[] | null;
  biltyId?: string | null;
  biltyNo?: string | null;
  challanId?: string | null;
  challanNo?: string | null;
  billId?: string | null;
  billNo?: string | null;
  phonchId?: string | null;
  phonchNo?: string | null;
  privatePhonchId?: string | null;
  privatePhonchNo?: string | null;
}

// ============================================================
// DAILY POSTING DRILL-DOWN (read-only)
//
// Builds the real, individual JournalLine rows behind a settledAmount
// figure, reusing the EXACT SAME account-set/sourceType/sourceId
// filter shape each resolver above already uses to compute that same
// aggregate sum - never a separately-invented matching rule. The
// caller MUST pass the identical account set and sourceType/sourceId
// the aggregate was computed from, and MUST discard the result
// (pass null onward) unless the entries' own sum reconciles exactly
// with settledAmount - this reconciliation is the actual safety net
// against ever showing a partial or misleading drill-down, not any
// per-component judgement call.
// ============================================================
async function fetchDailyPostingLines(
  tx: Tx,
  sourceType: string,
  sourceId: string,
  accountIds: string[]
): Promise<{ id: string; journalEntryId: string; entryDate: Date; debit: number; credit: number; description: string | null; accountId: string; accountName: string }[]> {
  if (accountIds.length === 0) return [];
  const lines = await tx.journalLine.findMany({
    where: {
      sourceType,
      sourceId,
      accountId: { in: accountIds },
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
    },
    select: {
      id: true,
      journalEntryId: true,
      debit: true,
      credit: true,
      description: true,
      accountId: true,
      account: { select: { accountName: true } },
      journalEntry: { select: { entryDate: true, description: true } },
    },
  });
  return lines.map((l) => ({
    id: l.id,
    journalEntryId: l.journalEntryId,
    entryDate: l.journalEntry.entryDate,
    debit: Number(l.debit),
    credit: Number(l.credit),
    description: l.description || l.journalEntry.description,
    accountId: l.accountId,
    accountName: l.account.accountName,
  }));
}

// PaymentAllocation-backed lines (the OLD mechanism's manual
// allocation path) - a real cash Daily Posting line too, just
// reached via PaymentAllocation.journalLineId rather than a direct
// sourceType/sourceId tag on the line itself.
async function fetchAllocationBackedLines(
  tx: Tx,
  targetSourceType: "BILTY" | "CHALLAN",
  targetSourceId: string
): Promise<{ id: string; journalEntryId: string; entryDate: Date; debit: number; credit: number; description: string | null; accountId: string; accountName: string }[]> {
  const allocations = await tx.paymentAllocation.findMany({
    where: { targetSourceType, targetSourceId },
    select: { journalLineId: true },
  });
  if (allocations.length === 0) return [];
  const lines = await tx.journalLine.findMany({
    where: { id: { in: allocations.map((a) => a.journalLineId) } },
    select: {
      id: true,
      journalEntryId: true,
      debit: true,
      credit: true,
      description: true,
      accountId: true,
      account: { select: { accountName: true } },
      journalEntry: { select: { entryDate: true, description: true } },
    },
  });
  return lines.map((l) => ({
    id: l.id,
    journalEntryId: l.journalEntryId,
    entryDate: l.journalEntry.entryDate,
    debit: Number(l.debit),
    credit: Number(l.credit),
    description: l.description || l.journalEntry.description,
    accountId: l.accountId,
    accountName: l.account.accountName,
  }));
}

/**
 * Returns a drill-down entry list ONLY when the sum of the found
 * lines (credit-side for a RECEIVABLE row, debit-side for a PAYABLE
 * row - the same polarity each resolver above already uses) matches
 * `expectedSettledAmount` within rounding tolerance. Otherwise
 * returns null - never a partial/misleading list. `includeAllocation`
 * additionally merges in PaymentAllocation-backed lines (the old
 * mechanism's manual-allocation path), for the one caller
 * (Collection/Carrier Rent old-mechanism fallback) whose settledAmount
 * can include that source too.
 */
async function buildDailyPostingDrillDown(
  tx: Tx,
  params: {
    sourceType: "BILTY" | "CHALLAN" | "BILL" | "PHONCH" | "PRIVATE_PHONCH";
    sourceId: string;
    accountIds: string[];
    direction: OutstandingDirection;
    expectedSettledAmount: number;
    includeAllocation?: boolean;
  }
): Promise<OutstandingDrillDownEntry[] | null> {
  if (params.expectedSettledAmount <= 0.009) return null;

  const directLines = await fetchDailyPostingLines(tx, params.sourceType, params.sourceId, params.accountIds);
  const allocationLines =
    params.includeAllocation && (params.sourceType === "BILTY" || params.sourceType === "CHALLAN")
      ? await fetchAllocationBackedLines(tx, params.sourceType, params.sourceId)
      : [];

  const byLineId = new Map<string, (typeof directLines)[number]>();
  for (const l of [...directLines, ...allocationLines]) byLineId.set(l.id, l);
  const merged = [...byLineId.values()];
  if (merged.length === 0) return null;

  const sum = round2(
    merged.reduce((s, l) => s + (params.direction === "RECEIVABLE" ? l.credit : l.debit), 0)
  );
  if (Math.abs(sum - params.expectedSettledAmount) > 0.01) return null;

  return merged
    .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime())
    .map((l) => ({
      journalLineId: l.id,
      journalEntryId: l.journalEntryId,
      date: l.entryDate.toISOString(),
      debit: l.debit,
      credit: l.credit,
      description: l.description || "—",
      accountId: l.accountId,
      accountName: l.accountName,
    }));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const BOOKING_INCOME_CACHE: { id: string | null } = { id: null };
async function getBookingIncomeAccountId(tx: Tx): Promise<string | null> {
  if (BOOKING_INCOME_CACHE.id) return BOOKING_INCOME_CACHE.id;
  const account = await tx.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } });
  BOOKING_INCOME_CACHE.id = account?.id || null;
  return BOOKING_INCOME_CACHE.id;
}

function vehicleLabel(bilty: { vehicleModel: string | null; vehicleType: string | null } | null | undefined): string | null {
  if (!bilty) return null;
  return bilty.vehicleModel || bilty.vehicleType || null;
}

// ============================================================
// CANDIDATE DISCOVERY
//
// Mirrors lib/payment-allocation.ts's own getPartyDocumentStates()
// candidate-gathering query exactly (same referenceType set, same
// account scope) - proven safe there, reused here unmodified in
// spirit - PLUS the new multi-payer engine's own SettlementPayment
// rows for this party (a party can be the resolved payer there
// without ever having their OWN account directly credited/debited
// by a SETTLEMENT/SETTLEMENT_CORRECTION line - e.g. a still-pending
// multi-payer allocation), so no candidate is missed either way.
// This only FINDS candidates - each one is still independently
// re-resolved and verified below before being accepted.
// ============================================================
async function findCandidateBiltyIds(tx: Tx, partyAccountId: string): Promise<Set<string>> {
  const ids = new Set<string>();

  const settlementLines = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      sourceType: "BILTY",
      journalEntry: { referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] }, isDeleted: false },
    },
    select: { sourceId: true },
  });
  for (const l of settlementLines) if (l.sourceId) ids.add(l.sourceId);

  const payerRows = await tx.settlementPayment.findMany({
    where: { payerAccountId: partyAccountId, component: "COLLECTION", biltyId: { not: null } },
    select: { biltyId: true },
  });
  for (const r of payerRows) if (r.biltyId) ids.add(r.biltyId);

  return ids;
}

async function findCandidateChallanIds(tx: Tx, partyAccountId: string): Promise<Set<string>> {
  const ids = new Set<string>();

  // Every SETTLEMENT/SETTLEMENT_CORRECTION line's own JournalEntry.
  // referenceId is always the Challan id, regardless of the LINE's
  // own sourceType - the OLD single-payer mechanism tags its Carrier
  // Rent reclassification sourceType:"BILTY" too (proportional
  // per-Bilty allocation - see the identical trap already found and
  // fixed for Party Ledger deduplication in lib/ledger-description.ts's
  // extractHousekeepingNoise()), so sourceType can never be used to
  // pre-filter candidates here. Over-inclusive is fine: each candidate
  // is independently re-resolved and verified via
  // getRemainingAllocatableAmountForDocument() below, which rejects
  // anything that isn't genuinely this party's own Carrier Rent.
  const settlementLines = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      journalEntry: { referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] }, isDeleted: false },
    },
    select: { journalEntry: { select: { referenceId: true } } },
  });
  for (const l of settlementLines) {
    if (l.journalEntry.referenceId) ids.add(l.journalEntry.referenceId);
  }

  const payerRows = await tx.settlementPayment.findMany({
    where: { payerAccountId: partyAccountId, component: "CARRIER_RENT", challanId: { not: null } },
    select: { challanId: true },
  });
  for (const r of payerRows) if (r.challanId) ids.add(r.challanId);

  return ids;
}

// ============================================================
// COLLECTION (Bilty Rent) - see module header for why this is a
// separate, non-blended resolution from lib/payment-allocation.ts's
// own resolveBiltyTarget().
// ============================================================
interface CollectionResolution {
  partyAccountId: string;
  totalDue: number;
  settledAmount: number;
  remaining: number;
  documentNo: string;
  documentDate: Date;
  // The exact account set settledAmount was summed across (payer +
  // any unioned historical accounts) - reused verbatim by the drill-
  // down builder below, never re-derived separately.
  accountIds: string[];
  // True when the OLD-mechanism fallback path was used (settledAmount
  // may include a PaymentAllocation-backed amount, not only direct
  // DAILY_POSTING lines) - tells the drill-down builder whether to
  // also check PaymentAllocation.
  isOldMechanism: boolean;
}

// A RECEIVABLE party's account is CREDITED when ANC actually receives
// cash from them (see app/api/daily-posting/route.ts's DEBIT/CREDIT
// contract: a RECEIPT debits the Main Cash/Bank account, so the
// counter Party line is credited) - confirmed live in this session's
// own Task C verification (a real receipt turned a party's "Paid"
// line into "Received", crediting their account). Only a CREDIT here
// genuinely reduces what they still owe - a DEBIT tagged to the same
// Bilty is a different kind of activity (e.g. a correction/reversal)
// and must never be treated as if it were a receipt.
//
// Always summed across a SET of accounts (never a single one) - used
// to let a real receipt posted to a PREVIOUSLY-responsible party
// still count once responsibility has since moved to a DIFFERENT,
// currently-resolved party (see historicalCollectionPayerAccountIds()
// below for why this is needed and never ambiguous in practice).
async function receivedViaDailyPostingForBiltyAcrossAccounts(tx: Tx, biltyId: string, accountIds: Set<string>): Promise<number> {
  if (accountIds.size === 0) return 0;
  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: { in: [...accountIds] } },
    },
    select: { credit: true },
  });
  return round2(taggedLines.reduce((s, l) => s + Number(l.credit), 0));
}

// Every PARTY account that has EVER been the new multi-payer engine's
// own Collection payer for THIS Bilty, via the CREATE-time
// SETTLEMENT_PAYMENT line - sourceType:"BILTY"/sourceId:<this Bilty>/
// JournalEntry.referenceId:<the owning Challan> (reliably Bilty-
// specific AND Collection-specific - a Paid-component event's own
// referenceId is the Bilty's OWN id instead, never the Challan's; see
// the identical distinction just fixed in
// lib/bilty-paid-verification.ts). A real Daily Posting receipt stays
// on whichever account it was actually posted to forever (correctly -
// it must never move), even once that account is no longer the
// CURRENTLY resolved payer (e.g. because their own SettlementPayment
// row was later deleted) - this is unioned with the currently-
// resolved account below, mirroring getBiltyPaidVerification()'s own
// established "survive a responsibility change" pattern for Paid.
//
// CONFIRMED LIVE: Bilty 108's Collection responsibility moved from
// Nasir And Sons (new engine, since deleted) back to Mardan Cargo
// Lahore (old mechanism's original default); the real 50,000 receipt
// stayed on Nasir And Sons' account and, without this, never counted
// toward Mardan Cargo Lahore's now-current row - Mardan showed
// Original 50,000 / Settled 0 / Remaining 50,000 even though the full
// amount had genuinely already been received.
async function historicalCollectionPayerAccountIds(tx: Tx, biltyId: string, challanId: string): Promise<Set<string>> {
  const lines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      account: { category: "PARTY" },
      journalEntry: { isDeleted: false, referenceType: "SETTLEMENT_PAYMENT", referenceId: challanId },
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  return new Set(lines.map((l) => l.accountId));
}

async function resolveBiltyCollectionPayers(tx: Tx, biltyId: string): Promise<CollectionResolution[]> {
  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: {
      id: true,
      biltyNo: true,
      date: true,
      toPay: true,
      isDeleted: true,
      challanBilties: {
        where: { challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: { challan: { select: { id: true, isSettled: true, settlementJournalEntryId: true } } },
      },
    },
  });
  if (!bilty || bilty.isDeleted) return [];

  // The Collection component is always the Bilty's To-Pay portion
  // (total - advance), NEVER Bilty.total - the Paid/advance amount is
  // a separate, independent component (see lib/settlement-accounting.ts's
  // own getCollectionAmount()/LOCKED-rule comment: "never the Paid
  // amount"). Confirmed against real settlement data: Bilty 108's own
  // "Settlement Payment - Bilty 108 To-Pay" JournalLine is exactly
  // toPay (50,000), not total (57,000).
  const total = round2(Number(bilty.toPay));
  if (total <= 0) return [];

  const activeChallan = bilty.challanBilties[0]?.challan;
  if (!activeChallan) return [];

  const payers = await getActiveSettlementPayers(tx, "COLLECTION", { challanId: activeChallan.id, biltyId });
  const results: CollectionResolution[] = [];

  if (payers.length > 0) {
    // New multi-payer engine - each payer's own declared share (there
    // may be several, e.g. Bilty 56's To-Pay split between two
    // parties, 20,000/30,000 of a 50,000 total - confirmed live),
    // netted against Daily Posting activity tagged to THEIR account
    // specifically. Manual PaymentAllocation is never possible here
    // (resolveBiltyTarget's own guard refuses to create one once any
    // active Collection SettlementPayment row exists for this Bilty),
    // so allocatedViaTable is never queried for these rows.
    //
    // A coexisting OLD-mechanism "floor" residual (see
    // lib/settlement-payments.ts's syncCollectionFloorForNewEngineRows())
    // is DELIBERATELY never added here, even when non-zero for the
    // SAME party - confirmed live on real data (Bilty 103: old
    // mechanism originally attributed the Bilty's FULL total (50,000 =
    // toPay 30,000 + advance 20,000) before the multi-payer engine
    // existed; the transition released exactly toPay back to Gross,
    // leaving a residual that is EXACTLY Bilty.advance, with the
    // transition's own line description literally stating "Paid amount
    // 20,000 remains with the original party"). That residual is
    // leftover Paid-component bookkeeping from the old single-payer
    // era, not outstanding Collection - counting it would violate this
    // codebase's own locked rule that Paid is never a Collection
    // amount (see lib/settlement-accounting.ts's getCollectionAmount()
    // comment, and lib/bilty-paid-verification.ts's module header).
    // Historical payer accounts (see historicalCollectionPayerAccountIds()
    // above) are unioned into THIS payer's own settled calculation only
    // when there is exactly ONE current payer - attributing a real
    // historical receipt to one of SEVERAL simultaneous current payers
    // would be a guess (which of them it "really" belongs to now), so
    // a genuine multi-payer split (2+ active rows) is deliberately left
    // exactly as before: each payer nets only against their own account.
    const historicalAccounts =
      payers.length === 1 ? await historicalCollectionPayerAccountIds(tx, biltyId, activeChallan.id) : new Set<string>();
    for (const payer of payers) {
      const accountSet = new Set([payer.payerAccountId, ...historicalAccounts]);
      const receivedViaDailyPosting = await receivedViaDailyPostingForBiltyAcrossAccounts(tx, biltyId, accountSet);
      const settledAmount = round2(receivedViaDailyPosting);
      const remaining = Math.max(0, round2(payer.totalAmount - settledAmount));
      results.push({
        partyAccountId: payer.payerAccountId,
        totalDue: payer.totalAmount,
        settledAmount,
        remaining,
        documentNo: bilty.biltyNo,
        documentDate: bilty.date,
        accountIds: [...accountSet],
        isOldMechanism: false,
      });
    }
    return results;
  }

  // OLD single-payer mechanism fallback (zero new-engine payers) -
  // only ever one payer, and only once genuinely settled (never
  // fabricated before then). Uses Bilty.toPay directly as the amount
  // (never the old mechanism's own SETTLEMENT line amount, which - as
  // documented above - can be inflated by a bundled Paid/advance
  // portion for a pre-multi-payer-engine Bilty) - toPay is always the
  // correct, current, authoritative Collection amount regardless of
  // what the historical SETTLEMENT line itself happened to post.
  if (!activeChallan.isSettled || !activeChallan.settlementJournalEntryId) return results;

  const bookingIncomeAccountId = await getBookingIncomeAccountId(tx);
  if (!bookingIncomeAccountId) return results;

  const partyAccountId = await findSettledPartyAccountId(
    tx,
    activeChallan.id,
    activeChallan.settlementJournalEntryId,
    "COLLECTION",
    bookingIncomeAccountId,
    biltyId
  );
  if (!partyAccountId) return results;

  // Always exactly one resolved party in this fallback branch by
  // construction, so unioning in every historically-tagged new-engine
  // payer account is never ambiguous - this is what makes a real
  // receipt, posted while a NOW-DELETED SettlementPayment row was
  // active, still count once responsibility has fallen back to this
  // old-mechanism default party (confirmed live: Bilty 108/Mardan
  // Cargo Lahore - see historicalCollectionPayerAccountIds()'s own
  // doc comment above for the full trace).
  const historicalAccounts = await historicalCollectionPayerAccountIds(tx, biltyId, activeChallan.id);
  const accountSet = new Set([partyAccountId, ...historicalAccounts]);
  const receivedViaDailyPosting = await receivedViaDailyPostingForBiltyAcrossAccounts(tx, biltyId, accountSet);
  const allocatedViaTable = await getAllocatedAmountForDocument(tx, "BILTY", biltyId);
  const settledAmount = round2(receivedViaDailyPosting + allocatedViaTable);
  const remaining = Math.max(0, round2(total - settledAmount));

  results.push({
    partyAccountId,
    totalDue: total,
    settledAmount,
    remaining,
    documentNo: bilty.biltyNo,
    documentDate: bilty.date,
    accountIds: [...accountSet],
    isOldMechanism: true,
  });

  return results;
}

// A PAYABLE party's account is DEBITED when ANC actually pays them
// cash (the mirror image of receivedViaDailyPostingForBiltyAcrossAccounts()
// above - a PAYMENT credits the Main Cash/Bank account, so the
// counter Party line is debited). Only a DEBIT here genuinely reduces
// what ANC still owes them - a CREDIT tagged to the same document is
// a different kind of activity (e.g. a receipt unrelated to settling
// this specific payable) and must never be treated as if it reduced
// it.
//
// Always summed across a SET of accounts (never a single one) - see
// historicalCarrierRentPayerAccountIds() below for why this is
// needed.
async function paidViaDailyPostingForChallanAcrossAccounts(tx: Tx, challanId: string, accountIds: Set<string>): Promise<number> {
  if (accountIds.size === 0) return 0;
  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "CHALLAN",
      sourceId: challanId,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: { in: [...accountIds] } },
    },
    select: { debit: true },
  });
  return round2(taggedLines.reduce((s, l) => s + Number(l.debit), 0));
}

// Every PARTY account that has EVER been the new multi-payer engine's
// own Carrier Rent payer for THIS Challan, via its CREATE-time
// SETTLEMENT_PAYMENT line (sourceType:"CHALLAN"/sourceId:<this
// Challan> - already unambiguous, since Collection's own create-time
// tag always uses sourceType:"BILTY" instead, never "CHALLAN"). A
// real Daily Posting payment stays on whichever account it was
// actually posted to forever, even once that account is no longer
// the CURRENTLY resolved payer - mirrors
// historicalCollectionPayerAccountIds() above exactly, for the same
// "survive a responsibility change" reason (see that function's own
// doc comment for the confirmed live Bilty 108 example this pattern
// is modelled on).
async function historicalCarrierRentPayerAccountIds(tx: Tx, challanId: string): Promise<Set<string>> {
  const lines = await tx.journalLine.findMany({
    where: {
      sourceType: "CHALLAN",
      sourceId: challanId,
      account: { category: "PARTY" },
      journalEntry: { isDeleted: false, referenceType: "SETTLEMENT_PAYMENT" },
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  return new Set(lines.map((l) => l.accountId));
}

// ============================================================
// CARRIER RENT (Challan) - see module header for why this resolves
// every active payer directly rather than delegating to
// lib/payment-allocation.ts's getRemainingAllocatableAmountForDocument().
// ============================================================
interface CarrierRentResolution {
  partyAccountId: string;
  totalDue: number;
  settledAmount: number;
  remaining: number;
  // The exact account set settledAmount's real cash portion was
  // summed across - reused verbatim by the drill-down builder below.
  accountIds: string[];
  // True when settledAmount includes ANY non-cash
  // CARRIER_RENT_MULTI_PAYER_TRANSITION "released" amount - such a
  // row's settledAmount is NOT purely backed by real Daily Posting
  // entries, so drill-down must never be offered for it.
  hasReclassification: boolean;
  isOldMechanism: boolean;
}

async function resolveChallanCarrierRentPayers(tx: Tx, challanId: string): Promise<CarrierRentResolution[]> {
  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    select: { id: true, isDeleted: true, isSettled: true, settlementJournalEntryId: true, carrierRent: true },
  });
  if (!challan || challan.isDeleted) return [];

  const carrierRentTotal = round2(Number(challan.carrierRent));
  if (carrierRentTotal <= 0) return [];

  const activePayers = await getActiveSettlementPayers(tx, "CARRIER_RENT", { challanId });
  const results: CarrierRentResolution[] = [];
  const accountedFor = new Set<string>();

  if (activePayers.length > 0) {
    // New multi-payer engine - each payer's own declared share,
    // netted against Daily Posting activity tagged to THEIR account
    // specifically. Manual PaymentAllocation is never possible here
    // (resolveChallanTarget's own MULTI_PAYER_NOT_ALLOCATABLE guard
    // refuses to create one against a multi-payer Challan), so
    // allocatedViaTable is never queried for these rows.
    //
    // Historical payer accounts are unioned in only when there is
    // exactly ONE current payer - see the identical reasoning on
    // resolveBiltyCollectionPayers() above (attributing a historical
    // payment to one of SEVERAL simultaneous current payers would be
    // a guess, so a genuine multi-payer split is left exactly as
    // before).
    const historicalAccounts =
      activePayers.length === 1 ? await historicalCarrierRentPayerAccountIds(tx, challanId) : new Set<string>();
    for (const payer of activePayers) {
      const accountSet = new Set([payer.payerAccountId, ...historicalAccounts]);
      const settledAmount = round2(await paidViaDailyPostingForChallanAcrossAccounts(tx, challanId, accountSet));
      const remaining = Math.max(0, round2(payer.totalAmount - settledAmount));
      results.push({
        partyAccountId: payer.payerAccountId,
        totalDue: payer.totalAmount,
        settledAmount,
        remaining,
        accountIds: [...accountSet],
        hasReclassification: false,
        isOldMechanism: false,
      });
      accountedFor.add(payer.payerAccountId);
    }
  }

  // OLD-mechanism party for every OTHER party still un-synced -
  // checked UNCONDITIONALLY, even when a DIFFERENT party already has
  // an active new-engine row for this same Challan. Confirmed live,
  // real data: Challan 4019's Carrier Rent (60,000) was originally
  // attributed in full to the Transporter (JMC, old mechanism); the
  // new multi-payer engine then took over only a 25,000 slice for a
  // DIFFERENT party (Danish Cargo Tarnol), releasing exactly 25,000
  // of JMC's attribution back to Gross. JMC's own real Party Ledger
  // shows this as two SEPARATE lines: "...Paid Rs. 60,000" (the
  // original SETTLEMENT establishment) and "...Received Rs. 25,000"
  // (the CARRIER_RENT_MULTI_PAYER_TRANSITION release) - two different
  // JournalEntries, two different economic events, never one blended
  // "net" figure.
  //
  // originalAmount and settledAmount are computed as TWO SEPARATE
  // sums, from TWO SEPARATE queries, and neither is ever derived from
  // the other:
  //  - originalAmount: SETTLEMENT/SETTLEMENT_CORRECTION lines only -
  //    the TRUE original business obligation this party was ever
  //    attributed, exactly as JMC's own JournalLine posted it
  //    (60,000) - this NEVER changes because of a later release.
  //  - settledAmount: CARRIER_RENT_MULTI_PAYER_TRANSITION lines
  //    (amount released/reassigned away from this party) PLUS any
  //    real Daily Posting payment - kept as its own independent
  //    figure, then remainingAmount = max(0, originalAmount -
  //    settledAmount), never the reverse.
  //
  // An EARLIER version of this fix computed only the NET of both
  // query sets combined (60,000 - 25,000 = 35,000) and used that net
  // AS originalAmount, silently collapsing "original" and "remaining"
  // into the same number (originalAmount: 35000, settledAmount: 0) -
  // numerically equal to the correct remaining, but conceptually wrong
  // and exactly the bug this now fixes.
  //
  // UNLIKE Collection's own identical-shaped residual (see
  // resolveBiltyCollectionPayers() above, deliberately NOT re-added),
  // Carrier Rent has no "Paid/advance" concept bundled into it at the
  // Challan level (Paid is a Bilty-only concept), and this Challan's
  // own CARRIER_RENT_MULTI_PAYER_TRANSITION lines carry no "(Paid
  // amount remains with the original party)" annotation the way
  // Collection's equivalent lines do (confirmed by reading both
  // live) - there is no evidence this residual is ever anything
  // other than genuine, currently-unresolved Carrier Rent, so it is
  // included, not excluded.
  const originalLines = await tx.journalLine.findMany({
    where: {
      account: { category: "PARTY" },
      journalEntry: { referenceId: challanId, referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] }, isDeleted: false },
    },
    select: { accountId: true, debit: true, credit: true, description: true },
  });
  const releasedLines = await tx.journalLine.findMany({
    where: {
      account: { category: "PARTY" },
      journalEntry: { referenceId: challanId, referenceType: "CARRIER_RENT_MULTI_PAYER_TRANSITION", isDeleted: false },
    },
    select: { accountId: true, debit: true, credit: true, description: true },
  });

  // Distinguishes from a Collection reclassification sharing the same
  // referenceId (both use JournalEntry.referenceId = this Challan) -
  // the same "Carrier Rent" substring check already used for
  // candidate discovery (findCandidateChallanIds()) and for Party
  // Ledger deduplication (lib/ledger-description.ts's
  // extractHousekeepingNoise()) - never guessed.
  const originalByAccount = new Map<string, number>();
  for (const l of originalLines) {
    if (!(l.description || "").includes("Carrier Rent")) continue;
    // A CREDIT establishes a Payable - normalize to a positive
    // "originally attributed" magnitude.
    originalByAccount.set(l.accountId, round2((originalByAccount.get(l.accountId) || 0) + Number(l.credit) - Number(l.debit)));
  }
  const releasedByAccount = new Map<string, number>();
  for (const l of releasedLines) {
    if (!(l.description || "").includes("Carrier Rent")) continue;
    // A DEBIT releases/reduces a Payable - normalize to a positive
    // "released away" magnitude.
    releasedByAccount.set(l.accountId, round2((releasedByAccount.get(l.accountId) || 0) + Number(l.debit) - Number(l.credit)));
  }

  // Historical accounts are unioned in only when this loop resolves to
  // exactly ONE old-mechanism party overall AND the new engine has no
  // active payers of its own - the same single-resolved-party safety
  // condition as above, so a historical payment is never guessed onto
  // one of several simultaneously-attributed accounts.
  const singleOldParty = activePayers.length === 0 && originalByAccount.size === 1 ? [...originalByAccount.keys()][0] : null;
  const historicalAccountsForOldMechanism = singleOldParty ? await historicalCarrierRentPayerAccountIds(tx, challanId) : new Set<string>();

  for (const [oldPartyAccountId, originalNet] of originalByAccount.entries()) {
    if (accountedFor.has(oldPartyAccountId)) continue;
    const originalAmount = round2(originalNet);
    if (originalAmount <= 0.009) continue;

    const released = round2(releasedByAccount.get(oldPartyAccountId) || 0);
    const accountSet =
      oldPartyAccountId === singleOldParty ? new Set([oldPartyAccountId, ...historicalAccountsForOldMechanism]) : new Set([oldPartyAccountId]);
    const paidAmount = await paidViaDailyPostingForChallanAcrossAccounts(tx, challanId, accountSet);
    const allocatedViaTable = activePayers.length === 0 ? await getAllocatedAmountForDocument(tx, "CHALLAN", challanId) : 0;
    const settledAmount = round2(released + paidAmount + allocatedViaTable);
    const remaining = Math.max(0, round2(originalAmount - settledAmount));
    if (remaining <= 0.009) continue;

    results.push({
      partyAccountId: oldPartyAccountId,
      totalDue: originalAmount,
      settledAmount,
      remaining,
      accountIds: [...accountSet],
      hasReclassification: released > 0.009,
      isOldMechanism: true,
    });
  }

  return results;
}

// ============================================================
// COMMISSION (Bilty Agent Commission)
//
// TWO coexisting posting mechanisms, both real, both still present in
// live data - never assume only the newer one:
//
//  1. NEW (this session's own Task C fix, app/api/bilty/route.ts):
//     posted DIRECTLY to the agent's own PARTY-category account at
//     Bilty creation (BILTY_BOOKING) - always immediately resolvable,
//     no Settlement needed. Bilty.agentPartyId IS the responsible
//     party here.
//
//  2. OLD (historical, lib/settlement-accounting.ts): the BILTY_BOOKING
//     line instead credits a GROSS suspense account ("Gross Booking
//     Agent Commission Payable (Unallocated)"), and the REAL
//     responsible party is only decided LATER, at Settlement, via an
//     explicit, independently-chosen `commissionPartyAccountId` - see
//     lib/settlement-accounting.ts's own CommissionResponsibility/
//     `bilty.commissionPartyAccountId` input. THIS CAN DIFFER FROM
//     Bilty.agentPartyId - confirmed live on real Bilty 108/Zaheer
//     Malook data (its own BILTY_BOOKING commission line credits the
//     Gross suspense account, not Zaheer Malook's account directly;
//     Zaheer Malook is only established via a later SETTLEMENT line).
//     An earlier version of this resolver trusted Bilty.agentPartyId
//     unconditionally for every Bilty - WRONG for this class of
//     historical Bilty, fixed here by re-deriving the responsible
//     party from the ledger, exactly like Collection/Carrier Rent
//     already do, using the SAME findSettledPartyAccountId() primitive
//     with component "COMMISSION" (already a supported
//     SettlementComponent - lib/payment-allocation.ts's own
//     resolveBiltyTarget() already passes this exact component value).
// ============================================================

const OTHER_EXPENSE_CACHE: { id: string | null } = { id: null };
async function getOtherExpenseAccountId(tx: Tx): Promise<string | null> {
  if (OTHER_EXPENSE_CACHE.id) return OTHER_EXPENSE_CACHE.id;
  const account = await tx.account.findFirst({ where: { category: "OTHER_EXPENSE", isActive: true }, select: { id: true } });
  OTHER_EXPENSE_CACHE.id = account?.id || null;
  return OTHER_EXPENSE_CACHE.id;
}

interface CommissionResolution {
  partyAccountId: string;
  totalDue: number;
  settledAmount: number;
  remaining: number;
  biltyId: string;
  biltyNo: string;
  documentDate: Date;
  rawDescription: string | null;
}

async function resolveBiltyCommission(tx: Tx, biltyId: string): Promise<CommissionResolution | null> {
  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: {
      id: true,
      biltyNo: true,
      date: true,
      agentCommission: true,
      isDeleted: true,
      challanBilties: {
        where: { challan: { isDeleted: false, status: { not: "CANCELLED" } } },
        select: { challan: { select: { id: true, isSettled: true, settlementJournalEntryId: true } } },
      },
    },
  });
  if (!bilty || bilty.isDeleted) return null;

  const agentCommission = round2(Number(bilty.agentCommission));
  if (agentCommission <= 0) return null;

  // BILTY_BOOKING/BILTY_BOOKING_CORRECTION lines tagged to this Bilty,
  // on any PARTY-category account - whichever one was actually
  // credited IS the resolved party, regardless of Bilty.agentPartyId
  // (mechanism 1 above). Net credit-minus-debit per account, in case
  // of a correction.
  const bookingLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      journalEntry: { referenceType: { in: ["BILTY_BOOKING", "BILTY_BOOKING_CORRECTION"] }, isDeleted: false },
      account: { category: "PARTY" },
    },
    select: { accountId: true, debit: true, credit: true, description: true },
  });
  const netByAccount = new Map<string, number>();
  const descriptionByAccount = new Map<string, string>();
  for (const line of bookingLines) {
    netByAccount.set(line.accountId, round2((netByAccount.get(line.accountId) || 0) + Number(line.credit) - Number(line.debit)));
    if (line.description) descriptionByAccount.set(line.accountId, line.description);
  }
  const directPartyAccountId = [...netByAccount.entries()].find(([, net]) => net > 0.009)?.[0] || null;

  let partyAccountId: string | null = null;
  let totalDue = agentCommission;
  let rawDescription: string | null = null;

  if (directPartyAccountId) {
    // Mechanism 1 (new) - the actually-credited amount is authoritative,
    // not just Bilty.agentCommission (in case of an edit/correction).
    partyAccountId = directPartyAccountId;
    totalDue = round2(netByAccount.get(directPartyAccountId) || agentCommission);
    rawDescription = descriptionByAccount.get(directPartyAccountId) || null;
  } else {
    // Mechanism 2 (old) - only resolvable once genuinely settled;
    // the responsible party is whatever Settlement actually chose,
    // never guessed, never assumed to be Bilty.agentPartyId.
    const activeChallan = bilty.challanBilties[0]?.challan;
    if (!activeChallan || !activeChallan.isSettled || !activeChallan.settlementJournalEntryId) return null;
    const otherExpenseAccountId = await getOtherExpenseAccountId(tx);
    if (!otherExpenseAccountId) return null;
    partyAccountId = await findSettledPartyAccountId(
      tx,
      activeChallan.id,
      activeChallan.settlementJournalEntryId,
      "COMMISSION",
      otherExpenseAccountId,
      biltyId
    );
    if (!partyAccountId) return null;
    totalDue = agentCommission;
  }

  // The agent's account is CREDITED (a Payable) - only a real payment
  // TO them (a DEBIT to their account - see
  // app/api/daily-posting/route.ts's DEBIT/CREDIT contract) genuinely
  // reduces it. A CREDIT tagged to the same Bilty is a different kind
  // of activity and must never be treated as if it paid down the
  // commission.
  const taggedLines = await tx.journalLine.findMany({
    where: {
      sourceType: "BILTY",
      sourceId: biltyId,
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
      account: { category: "PARTY", id: partyAccountId },
    },
    select: { debit: true },
  });
  const settledAmount = round2(taggedLines.reduce((s, l) => s + Number(l.debit), 0));
  const remaining = Math.max(0, round2(totalDue - settledAmount));

  return {
    partyAccountId,
    totalDue,
    settledAmount,
    remaining,
    biltyId,
    biltyNo: bilty.biltyNo,
    documentDate: bilty.date,
    rawDescription,
  };
}

async function findCommissionCandidateBiltyIds(tx: Tx, partyAccountId: string, settlementCandidateIds: Set<string>): Promise<Set<string>> {
  const ids = new Set(settlementCandidateIds);
  // Also include Bilties directly naming this party as Agent (covers
  // mechanism 1's bookkeeping even before any Settlement line exists -
  // resolveBiltyCommission() above independently re-verifies the real
  // responsible party either way, so an over-inclusive candidate here
  // is harmless).
  const directBilties = await tx.bilty.findMany({
    where: { isDeleted: false, agentCommission: { gt: 0 }, agentParty: { account: { id: partyAccountId } } },
    select: { id: true },
  });
  for (const b of directBilties) ids.add(b.id);
  return ids;
}

// ============================================================
// BILL (Client Bill, always Receivable) - direct field resolution
// (Bill.clientPartyId), no Settlement dependency. Never the shared
// walk-in system account (see module header).
// ============================================================
interface BillResolution {
  billId: string;
  billNo: string;
  date: Date;
  totalAmount: number;
  settledAmount: number;
  remaining: number;
  vehicleName: string | null;
  chassisNumber: string | null;
}

async function findBillResolutions(tx: Tx, partyAccountId: string): Promise<BillResolution[]> {
  const bills = await tx.bill.findMany({
    where: { isDeleted: false, clientParty: { account: { id: partyAccountId } } },
    select: {
      id: true,
      billNo: true,
      date: true,
      items: { select: { vehicleName: true, chassisNumber: true, rent: true, delivery: true, otherExpense: true } },
    },
  });
  if (bills.length === 0) return [];

  const results: BillResolution[] = [];
  for (const bill of bills) {
    const totalAmount = round2(
      bill.items.reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0)
    );
    if (totalAmount <= 0) continue;

    const state = await getBillPaymentState(tx, bill.id, partyAccountId, totalAmount);
    if (state.remainingDue <= 0.009) continue;

    const soleItem = bill.items.length === 1 ? bill.items[0] : null;
    results.push({
      billId: bill.id,
      billNo: bill.billNo,
      date: bill.date,
      totalAmount,
      settledAmount: state.receivedAmount,
      remaining: state.remainingDue,
      vehicleName: soleItem?.vehicleName || null,
      chassisNumber: soleItem?.chassisNumber || null,
    });
  }
  return results;
}

// ============================================================
// SHOWROOM PHONCH (Transporter component, RECEIVABLE - see module
// header for the direction correction and full reasoning). No
// Clearing Agent component exists for this document type at all.
// ============================================================
interface ShowroomPhonchResolution {
  phonchId: string;
  phonchNo: string;
  date: Date;
  totalAmount: number;
  settledAmount: number;
  remaining: number;
  vehicleName: string | null;
  chassisNumber: string | null;
}

async function findShowroomPhonchResolutions(tx: Tx, partyAccountId: string): Promise<ShowroomPhonchResolution[]> {
  const phonches = await tx.phonch.findMany({
    where: { isDeleted: false, transporterParty: { account: { id: partyAccountId } } },
    select: {
      id: true,
      phonchNo: true,
      date: true,
      vehicles: { select: { vehicleName: true, chassisNumber: true, deliveryCharges: true, otherExpenseAmount: true, claimAmount: true } },
    },
  });
  if (phonches.length === 0) return [];

  const results: ShowroomPhonchResolution[] = [];
  for (const phonch of phonches) {
    const totalAmount = round2(
      phonch.vehicles.reduce((s, v) => s + Number(v.deliveryCharges) + Number(v.otherExpenseAmount) + Number(v.claimAmount), 0)
    );
    if (totalAmount <= 0) continue;

    const state = await getPhonchPaymentState(tx, phonch.id, partyAccountId, totalAmount);
    if (state.remainingDue <= 0.009) continue;

    const soleVehicle = phonch.vehicles.length === 1 ? phonch.vehicles[0] : null;
    results.push({
      phonchId: phonch.id,
      phonchNo: phonch.phonchNo,
      date: phonch.date,
      totalAmount,
      settledAmount: state.receivedAmount,
      remaining: state.remainingDue,
      vehicleName: soleVehicle?.vehicleName || null,
      chassisNumber: soleVehicle?.chassisNumber || null,
    });
  }
  return results;
}

// ============================================================
// PRIVATE PHONCH - four independent, never-netted components. See
// module header for why this aggregates per vehicle itself (mirroring
// lib/document-party-resolution.ts's own getPrivatePhonchEligibleParties())
// instead of calling that function directly.
// ============================================================
interface PrivatePhonchResolution {
  component: "PRIVATE_PHONCH_CARRIER_PAYABLE" | "PRIVATE_PHONCH_CA_PAYABLE" | "PRIVATE_PHONCH_TRANSPORTER_RECOVERY" | "PRIVATE_PHONCH_CA_RECOVERY";
  direction: OutstandingDirection;
  phonchId: string;
  phonchNo: string;
  date: Date;
  totalAmount: number;
  settledAmount: number;
  remaining: number;
  vehicleName: string | null;
  chassisNumber: string | null;
}

async function findCandidatePrivatePhonchIds(tx: Tx, partyAccountId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const asTransporter = await tx.privatePhonch.findMany({
    where: { isDeleted: false, transporterParty: { account: { id: partyAccountId } } },
    select: { id: true },
  });
  for (const p of asTransporter) ids.add(p.id);

  const asClearingAgent = await tx.privatePhonch.findMany({
    where: { isDeleted: false, vehicles: { some: { clearingAgentParty: { account: { id: partyAccountId } } } } },
    select: { id: true },
  });
  for (const p of asClearingAgent) ids.add(p.id);

  return ids;
}

async function resolvePrivatePhonchForParty(tx: Tx, phonchId: string, partyAccountId: string): Promise<PrivatePhonchResolution[]> {
  const phonch = await tx.privatePhonch.findUnique({
    where: { id: phonchId },
    select: {
      id: true,
      phonchNo: true,
      date: true,
      transporterParty: { select: { account: { select: { id: true } } } },
      vehicles: {
        select: {
          vehicleName: true,
          chassisNumber: true,
          totalRent: true,
          deliveryCharges: true,
          carrierPayable: true,
          deliveryRecoveryParty: true,
          clearingAgentParty: { select: { account: { select: { id: true } } } },
        },
      },
    },
  });
  if (!phonch) return [];

  const results: PrivatePhonchResolution[] = [];
  const isRecoveryVehicle = (v: { totalRent: unknown; deliveryRecoveryParty: string | null }) => Number(v.totalRent) <= 0.009;

  // --- Transporter Carrier Payable (PAYABLE) - sum of ALL vehicles'
  // own carrierPayable field (already 0 for a pure zero-rent recovery
  // vehicle, by construction - see the module header's zero-rent rule).
  if (phonch.transporterParty.account?.id === partyAccountId) {
    const totalCarrierPayable = round2(phonch.vehicles.reduce((s, v) => s + Number(v.carrierPayable), 0));
    if (totalCarrierPayable > 0.009) {
      const state = await getPrivatePhonchPaymentState(tx, phonchId, partyAccountId, totalCarrierPayable, undefined, true);
      if (state.remainingDue > 0.009) {
        const sole = phonch.vehicles.length === 1 ? phonch.vehicles[0] : null;
        results.push({
          component: "PRIVATE_PHONCH_CARRIER_PAYABLE",
          direction: "PAYABLE",
          phonchId,
          phonchNo: phonch.phonchNo,
          date: phonch.date,
          totalAmount: totalCarrierPayable,
          settledAmount: state.paidAmount,
          remaining: state.remainingDue,
          vehicleName: sole?.vehicleName || null,
          chassisNumber: sole?.chassisNumber || null,
        });
      }
    }

    // --- Transporter Delivery Recovery (RECEIVABLE) - zero-rent
    // vehicles NOT attributed to a Clearing Agent.
    const recoveryVehicles = phonch.vehicles.filter((v) => isRecoveryVehicle(v) && v.deliveryRecoveryParty !== "CLEARING_AGENT");
    const totalRecovery = round2(recoveryVehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0));
    if (totalRecovery > 0.009) {
      const state = await getPrivatePhonchDeliveryRecoveryState(tx, phonchId, partyAccountId, totalRecovery);
      if (state.remainingDue > 0.009) {
        const sole = recoveryVehicles.length === 1 ? recoveryVehicles[0] : null;
        results.push({
          component: "PRIVATE_PHONCH_TRANSPORTER_RECOVERY",
          direction: "RECEIVABLE",
          phonchId,
          phonchNo: phonch.phonchNo,
          date: phonch.date,
          totalAmount: totalRecovery,
          settledAmount: state.recoveredAmount,
          remaining: state.remainingDue,
          vehicleName: sole?.vehicleName || null,
          chassisNumber: sole?.chassisNumber || null,
        });
      }
    }
  }

  // --- Clearing Agent Payable + Recovery - only for vehicles naming
  // THIS party as the Clearing Agent.
  const caVehicles = phonch.vehicles.filter((v) => v.clearingAgentParty?.account?.id === partyAccountId);
  if (caVehicles.length > 0) {
    const caPayableVehicles = caVehicles.filter((v) => !(isRecoveryVehicle(v) && v.deliveryRecoveryParty === "CLEARING_AGENT"));
    const totalCaPayable = round2(
      caPayableVehicles.reduce((s, v) => {
        const netRent = Number(v.totalRent) - Number(v.deliveryCharges);
        return s + Math.max(0, round2(netRent - Number(v.carrierPayable)));
      }, 0)
    );
    if (totalCaPayable > 0.009) {
      const state = await getPrivatePhonchPaymentState(tx, phonchId, partyAccountId, totalCaPayable);
      if (state.remainingDue > 0.009) {
        const sole = caPayableVehicles.length === 1 ? caPayableVehicles[0] : null;
        results.push({
          component: "PRIVATE_PHONCH_CA_PAYABLE",
          direction: "PAYABLE",
          phonchId,
          phonchNo: phonch.phonchNo,
          date: phonch.date,
          totalAmount: totalCaPayable,
          settledAmount: state.paidAmount,
          remaining: state.remainingDue,
          vehicleName: sole?.vehicleName || null,
          chassisNumber: sole?.chassisNumber || null,
        });
      }
    }

    const caRecoveryVehicles = caVehicles.filter((v) => isRecoveryVehicle(v) && v.deliveryRecoveryParty === "CLEARING_AGENT");
    const totalCaRecovery = round2(caRecoveryVehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0));
    if (totalCaRecovery > 0.009) {
      const state = await getPrivatePhonchDeliveryRecoveryState(tx, phonchId, partyAccountId, totalCaRecovery);
      if (state.remainingDue > 0.009) {
        const sole = caRecoveryVehicles.length === 1 ? caRecoveryVehicles[0] : null;
        results.push({
          component: "PRIVATE_PHONCH_CA_RECOVERY",
          direction: "RECEIVABLE",
          phonchId,
          phonchNo: phonch.phonchNo,
          date: phonch.date,
          totalAmount: totalCaRecovery,
          settledAmount: state.recoveredAmount,
          remaining: state.remainingDue,
          vehicleName: sole?.vehicleName || null,
          chassisNumber: sole?.chassisNumber || null,
        });
      }
    }
  }

  return results;
}

// ============================================================
// PUBLIC ENTRY POINT
// ============================================================

function biltyRentDescription(biltyNo: string, vehicle: string | null, chassisNumber: string | null): string {
  const parts = [`Bilty No ${biltyNo}`];
  if (vehicle) parts.push(vehicle);
  if (chassisNumber) parts.push(`Chassis No ${chassisNumber}`);
  parts.push("Bilty Rent");
  return parts.join(", ");
}

function commissionDescription(biltyNo: string, vehicle: string | null, chassisNumber: string | null): string {
  const parts = [`Bilty No ${biltyNo}`];
  if (vehicle) parts.push(vehicle);
  if (chassisNumber) parts.push(`Chassis No ${chassisNumber}`);
  parts.push("Agent Commission");
  return parts.join(", ");
}

function carrierRentDescription(
  challanNo: string,
  vehicle: string | null,
  chassisNumber: string | null,
  carrierNumber: string | null
): string {
  const parts = [`Challan No ${challanNo}`];
  if (vehicle) parts.push(vehicle);
  if (chassisNumber) parts.push(`Chassis No ${chassisNumber}`);
  if (carrierNumber) parts.push(`Carrier No ${carrierNumber}`);
  parts.push("Carrier Rent");
  return parts.join(", ");
}

function billDescription(billNo: string, vehicle: string | null, chassisNumber: string | null): string {
  const parts = [`Bill No ${billNo}`];
  if (vehicle) parts.push(vehicle);
  if (chassisNumber) parts.push(`Chassis No ${chassisNumber}`);
  parts.push("Client Billing");
  return parts.join(", ");
}

function showroomPhonchDescription(phonchNo: string, vehicle: string | null, chassisNumber: string | null): string {
  const parts = [`Showroom Phonch No ${phonchNo}`];
  if (vehicle) parts.push(vehicle);
  if (chassisNumber) parts.push(`Chassis No ${chassisNumber}`);
  parts.push("Delivery Recovery");
  return parts.join(", ");
}

function privatePhonchDescription(
  phonchNo: string,
  vehicle: string | null,
  chassisNumber: string | null,
  suffix: "Carrier Rent Payable" | "Clearing Agent Payable" | "Delivery Recovery"
): string {
  const parts = [`Private Phonch No ${phonchNo}`];
  if (vehicle) parts.push(vehicle);
  if (chassisNumber) parts.push(`Chassis No ${chassisNumber}`);
  parts.push(suffix);
  return parts.join(", ");
}

export async function getPartyOutstandingDocuments(tx: Tx, partyAccountId: string): Promise<OutstandingRow[]> {
  const rows: OutstandingRow[] = [];

  // ---------------- COLLECTION (Receivable) ----------------
  const biltyCandidateIds = await findCandidateBiltyIds(tx, partyAccountId);
  const biltyContexts = biltyCandidateIds.size
    ? await tx.bilty.findMany({
        where: { id: { in: [...biltyCandidateIds] } },
        select: { id: true, vehicleType: true, vehicleModel: true, chassisNumber: true },
      })
    : [];
  const biltyCtxById = new Map(biltyContexts.map((b) => [b.id, b]));

  for (const biltyId of biltyCandidateIds) {
    const resolutions = await resolveBiltyCollectionPayers(tx, biltyId);
    const resolved = resolutions.find((r) => r.partyAccountId === partyAccountId);
    if (!resolved) continue;
    if (resolved.remaining <= 0.009) continue;

    const ctx = biltyCtxById.get(biltyId) || null;
    const settledDrillDown = await buildDailyPostingDrillDown(tx, {
      sourceType: "BILTY",
      sourceId: biltyId,
      accountIds: resolved.accountIds,
      direction: "RECEIVABLE",
      expectedSettledAmount: resolved.settledAmount,
      includeAllocation: resolved.isOldMechanism,
    });
    rows.push({
      component: "COLLECTION",
      direction: "RECEIVABLE",
      documentType: "BILTY",
      documentNo: resolved.documentNo,
      documentDate: resolved.documentDate,
      description: biltyRentDescription(resolved.documentNo, vehicleLabel(ctx), ctx?.chassisNumber || null),
      originalAmount: resolved.totalDue,
      settledAmount: resolved.settledAmount,
      remainingAmount: resolved.remaining,
      settledDrillDown,
      biltyId,
      biltyNo: resolved.documentNo,
      challanId: null,
      challanNo: null,
    });
  }

  // ---------------- COMMISSION (Payable) ----------------
  // Candidate set: the SAME settlement-derived biltyCandidateIds
  // gathered for Collection above (a Commission reclassification line
  // uses the identical sourceType:"BILTY" SETTLEMENT/SETTLEMENT_CORRECTION
  // tag shape - confirmed live on Bilty 108), PLUS every Bilty
  // directly naming this party as Agent (covers the new, direct-at-
  // booking mechanism even before any Settlement exists). Over-
  // inclusive is fine - resolveBiltyCommission() independently
  // re-verifies the real responsible party for every candidate.
  const commissionCandidateIds = await findCommissionCandidateBiltyIds(tx, partyAccountId, biltyCandidateIds);
  const commissionCtxRows = commissionCandidateIds.size
    ? await tx.bilty.findMany({
        where: { id: { in: [...commissionCandidateIds] } },
        select: { id: true, vehicleType: true, vehicleModel: true, chassisNumber: true },
      })
    : [];
  const commissionCtxById = new Map(commissionCtxRows.map((b) => [b.id, b]));

  for (const biltyId of commissionCandidateIds) {
    const resolved = await resolveBiltyCommission(tx, biltyId);
    if (!resolved) continue;
    if (resolved.partyAccountId !== partyAccountId) continue;
    if (resolved.remaining <= 0.009) continue;

    const ctx = commissionCtxById.get(biltyId) || null;
    const settledDrillDown = await buildDailyPostingDrillDown(tx, {
      sourceType: "BILTY",
      sourceId: biltyId,
      accountIds: [resolved.partyAccountId],
      direction: "PAYABLE",
      expectedSettledAmount: resolved.settledAmount,
    });
    rows.push({
      component: "COMMISSION",
      direction: "PAYABLE",
      documentType: "BILTY",
      documentNo: resolved.biltyNo,
      documentDate: resolved.documentDate,
      // Prefer the raw, pre-composed description already stored on the
      // line itself (e.g. "Bilty No 108, j7, Chassis No 7854, bilty
      // expense. 2,000.") - falls back to the generic builder only if
      // that line can't be found (e.g. an old-mechanism Bilty, whose
      // own line credits a Gross suspense account, not this party).
      description: resolved.rawDescription || commissionDescription(resolved.biltyNo, vehicleLabel(ctx), ctx?.chassisNumber || null),
      originalAmount: resolved.totalDue,
      settledAmount: resolved.settledAmount,
      remainingAmount: resolved.remaining,
      settledDrillDown,
      biltyId: resolved.biltyId,
      biltyNo: resolved.biltyNo,
      challanId: null,
      challanNo: null,
    });
  }

  // ---------------- CARRIER RENT (Payable) ----------------
  const challanCandidateIds = await findCandidateChallanIds(tx, partyAccountId);
  const challanContexts = challanCandidateIds.size
    ? await tx.challan.findMany({
        where: { id: { in: [...challanCandidateIds] } },
        select: {
          id: true,
          challanNo: true,
          loadingDate: true,
          carrierNumber: true,
          bilties: {
            where: { bilty: { isDeleted: false } },
            select: { bilty: { select: { id: true, vehicleType: true, vehicleModel: true, chassisNumber: true } } },
          },
        },
      })
    : [];
  const challanCtxById = new Map(challanContexts.map((c) => [c.id, c]));

  for (const challanId of challanCandidateIds) {
    const ctx = challanCtxById.get(challanId) || null;
    if (!ctx) continue;

    const resolutions = await resolveChallanCarrierRentPayers(tx, challanId);
    const mine = resolutions.find((r) => r.partyAccountId === partyAccountId);
    if (!mine || mine.remaining <= 0.009) continue;

    const bilties = ctx.bilties.map((cb) => cb.bilty).filter((b): b is NonNullable<typeof b> => !!b);
    const soleBilty = bilties.length === 1 ? bilties[0] : null;

    // A row with ANY reclassification ("released") component in its
    // settledAmount is never offered a drill-down at all - that
    // portion is a responsibility change, not a real cash movement,
    // and there is no safe way to show "part of this is real, part
    // isn't" without risking exactly the confusion this feature must
    // avoid (see OutstandingDrillDownEntry's own doc comment).
    const settledDrillDown = mine.hasReclassification
      ? null
      : await buildDailyPostingDrillDown(tx, {
          sourceType: "CHALLAN",
          sourceId: challanId,
          accountIds: mine.accountIds,
          direction: "PAYABLE",
          expectedSettledAmount: mine.settledAmount,
          includeAllocation: mine.isOldMechanism,
        });

    rows.push({
      component: "CARRIER_RENT",
      direction: "PAYABLE",
      documentType: "CHALLAN",
      documentNo: ctx.challanNo,
      documentDate: ctx.loadingDate,
      description: carrierRentDescription(ctx.challanNo, vehicleLabel(soleBilty), soleBilty?.chassisNumber || null, ctx.carrierNumber),
      originalAmount: mine.totalDue,
      settledAmount: mine.settledAmount,
      remainingAmount: mine.remaining,
      settledDrillDown,
      biltyId: null,
      biltyNo: null,
      challanId,
      challanNo: ctx.challanNo,
    });
  }

  // ---------------- BILL (Receivable) ----------------
  const billResolutions = await findBillResolutions(tx, partyAccountId);
  for (const b of billResolutions) {
    const settledDrillDown = await buildDailyPostingDrillDown(tx, {
      sourceType: "BILL",
      sourceId: b.billId,
      accountIds: [partyAccountId],
      direction: "RECEIVABLE",
      expectedSettledAmount: b.settledAmount,
    });
    rows.push({
      component: "BILL",
      direction: "RECEIVABLE",
      documentType: "BILL",
      documentNo: b.billNo,
      documentDate: b.date,
      description: billDescription(b.billNo, b.vehicleName, b.chassisNumber),
      originalAmount: b.totalAmount,
      settledAmount: b.settledAmount,
      remainingAmount: b.remaining,
      settledDrillDown,
      billId: b.billId,
      billNo: b.billNo,
    });
  }

  // ---------------- SHOWROOM PHONCH (Receivable - see module header
  // for the direction correction) ----------------
  const phonchResolutions = await findShowroomPhonchResolutions(tx, partyAccountId);
  for (const p of phonchResolutions) {
    const settledDrillDown = await buildDailyPostingDrillDown(tx, {
      sourceType: "PHONCH",
      sourceId: p.phonchId,
      accountIds: [partyAccountId],
      direction: "RECEIVABLE",
      expectedSettledAmount: p.settledAmount,
    });
    rows.push({
      component: "SHOWROOM_PHONCH",
      direction: "RECEIVABLE",
      documentType: "PHONCH",
      documentNo: p.phonchNo,
      documentDate: p.date,
      description: showroomPhonchDescription(p.phonchNo, p.vehicleName, p.chassisNumber),
      originalAmount: p.totalAmount,
      settledAmount: p.settledAmount,
      remainingAmount: p.remaining,
      settledDrillDown,
      phonchId: p.phonchId,
      phonchNo: p.phonchNo,
    });
  }

  // ---------------- PRIVATE PHONCH (four independent components) ----------------
  const privatePhonchCandidateIds = await findCandidatePrivatePhonchIds(tx, partyAccountId);
  const privatePhonchSuffixByComponent: Record<PrivatePhonchResolution["component"], "Carrier Rent Payable" | "Clearing Agent Payable" | "Delivery Recovery"> = {
    PRIVATE_PHONCH_CARRIER_PAYABLE: "Carrier Rent Payable",
    PRIVATE_PHONCH_CA_PAYABLE: "Clearing Agent Payable",
    PRIVATE_PHONCH_TRANSPORTER_RECOVERY: "Delivery Recovery",
    PRIVATE_PHONCH_CA_RECOVERY: "Delivery Recovery",
  };
  for (const phonchId of privatePhonchCandidateIds) {
    const resolutions = await resolvePrivatePhonchForParty(tx, phonchId, partyAccountId);
    for (const r of resolutions) {
      const settledDrillDown = await buildDailyPostingDrillDown(tx, {
        sourceType: "PRIVATE_PHONCH",
        sourceId: r.phonchId,
        accountIds: [partyAccountId],
        direction: r.direction,
        expectedSettledAmount: r.settledAmount,
      });
      rows.push({
        component: r.component,
        direction: r.direction,
        documentType: "PRIVATE_PHONCH",
        documentNo: r.phonchNo,
        documentDate: r.date,
        description: privatePhonchDescription(r.phonchNo, r.vehicleName, r.chassisNumber, privatePhonchSuffixByComponent[r.component]),
        originalAmount: r.totalAmount,
        settledAmount: r.settledAmount,
        remainingAmount: r.remaining,
        settledDrillDown,
        privatePhonchId: r.phonchId,
        privatePhonchNo: r.phonchNo,
      });
    }
  }

  rows.sort((a, b) => a.documentDate.getTime() - b.documentDate.getTime());
  return rows;
}

export async function getPartyOutstandingSummary(rows: OutstandingRow[]): Promise<{
  totalReceivable: number;
  totalPayable: number;
  netBalance: number;
}> {
  const totalReceivable = round2(rows.filter((r) => r.direction === "RECEIVABLE").reduce((s, r) => s + r.remainingAmount, 0));
  const totalPayable = round2(rows.filter((r) => r.direction === "PAYABLE").reduce((s, r) => s + r.remainingAmount, 0));
  return { totalReceivable, totalPayable, netBalance: round2(totalReceivable - totalPayable) };
}

// Outstanding's Search/Type/Direction/Date filter predicate lives in
// lib/outstanding-filters.ts - a standalone, Prisma-free module so it
// can also be imported directly by the client-side screen
// (OutstandingView.tsx) without pulling Prisma into the browser
// bundle. Re-exported here so server-side callers (e.g. the PDF
// export route) can import everything Outstanding-related from this
// one module if they prefer.
export { filterOutstandingRows, documentDateKey, type OutstandingFilterOptions } from "@/lib/outstanding-filters";

export { prisma };
