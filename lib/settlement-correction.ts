import type { Prisma, PrismaClient } from "@prisma/client";
import {
  getGrossBiltyReceivableAccountId,
  getGrossCarrierRentPayableAccountId,
  getGrossCommissionPayableAccountId,
} from "@/lib/gross-accounts";

// ============================================================
// ACCOUNTING-SAFE EDIT CORRECTIONS
//
// Booking Income (Bilty creation), Carrier Rent expense (Challan
// creation), and Commission expense (Bilty creation, when present)
// are all recognized exactly once, immediately, against a gross/
// suspense clearing account (lib/gross-accounts.ts) until
// Settlement reclassifies each into a real party.
//
// Editing rent/carrierRent/commission after the fact must NOT
// silently overwrite that history. Instead we post a balanced
// correction JournalEntry for the delta only, and:
//
//  - BEFORE Settlement: the correction targets the same gross
//    account the original entry used. Settlement, whenever it
//    later runs, reads the Bilty/Challan's CURRENT amount and
//    reclassifies the full (corrected) balance out of the gross
//    account - so it always nets to zero.
//
//  - AFTER Settlement: the gross account for that specific
//    component has already been fully reclassified into a real
//    party account. The correction must therefore target that
//    SAME party directly (found by reading the settlement
//    JournalEntry's own lines - never trust anything except the
//    ledger). If no party was ever established for this component
//    (e.g. commission was zero at settlement time), the caller
//    must supply one explicitly (see MissingResponsiblePartyError
//    below). Challan.outstandingReceivable/outstandingPayable is
//    then recalculated to include the correction - correctly
//    flipping a party from receivable to payable (or back) when
//    the correction is large enough to cross zero - while any
//    Daily-Posting-sourced `received`/`paid` (read separately by
//    lib/challan-financials.ts) is left completely untouched.
//
// No historical JournalEntry is ever mutated or deleted.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type SettlementComponent = "COLLECTION" | "CARRIER_RENT" | "COMMISSION";

// Thrown when a component is being corrected on an already-settled
// Challan but no party was ever established for it at settlement
// time (e.g. commission was 0 then, and is only now being
// introduced) and the caller did not supply one. The caller (an
// API route) should catch this and ask the user to select a
// responsible party, then retry with `explicitPartyAccountId` set.
export class MissingResponsiblePartyError extends Error {
  component: SettlementComponent;
  biltyNo: string;

  constructor(component: SettlementComponent, biltyNo: string, challanNo: string) {
    const subject = component === "CARRIER_RENT" ? `Challan ${challanNo}` : `Bilty ${biltyNo}`;
    super(
      `No responsible party is established for ${component} on ${subject}. A responsible party must be selected.`
    );
    this.name = "MissingResponsiblePartyError";
    this.component = component;
    this.biltyNo = biltyNo;
  }
}

interface CorrectionLine {
  accountId: string;
  debit: number;
  credit: number;
}

function buildDeltaLines(
  delta: number,
  increaseAccountId: string,
  decreaseAccountId: string
): CorrectionLine[] {
  // "increaseAccountId" is the side that was DEBITED when the
  // original amount went up (Gross Bilty Receivable for
  // collection; the Expense account for carrier rent/commission).
  const amount = Math.abs(delta);
  if (delta > 0) {
    return [
      { accountId: increaseAccountId, debit: amount, credit: 0 },
      { accountId: decreaseAccountId, debit: 0, credit: amount },
    ];
  }
  return [
    { accountId: decreaseAccountId, debit: amount, credit: 0 },
    { accountId: increaseAccountId, debit: 0, credit: amount },
  ];
}

const GROSS_ACCOUNT_CODES: Record<SettlementComponent, string> = {
  COLLECTION: "GROSS-BILTY-RECEIVABLE",
  CARRIER_RENT: "GROSS-CARRIER-RENT-PAYABLE",
  COMMISSION: "GROSS-COMMISSION-PAYABLE",
};

// A pure applySettlementReassignment() entry has no gross/income/
// expense line at all (both its lines are PARTY accounts), so it
// can never be matched via GROSS_ACCOUNT_CODES/incomeOrExpenseAccountId
// the way an original settlement or an amount-delta correction is.
// Every description this module writes for a component - the
// original settlement's ("... reclassified to ..."), an amount
// correction's, and a reassignment's - already contains this exact
// keyword, so matching on it (only for all-PARTY groups, a shape no
// other entry type produces) reliably recognizes a reassignment
// group without needing a new schema field.
const COMPONENT_KEYWORDS: Record<SettlementComponent, string> = {
  COLLECTION: "Collection",
  CARRIER_RENT: "Carrier Rent",
  COMMISSION: "Commission",
};

async function getGrossAccountId(tx: Tx, component: SettlementComponent): Promise<string> {
  if (component === "COLLECTION") return getGrossBiltyReceivableAccountId(tx);
  if (component === "CARRIER_RENT") return getGrossCarrierRentPayableAccountId(tx);
  return getGrossCommissionPayableAccountId(tx);
}

// Shape of the lines fetched for party resolution - shared between
// the single-lookup and batched entry points below so the matching
// engine (resolvePartyFromLines) only has to be written once.
type SettledLine = {
  id: string;
  accountId: string;
  journalEntryId: string;
  description: string | null;
  sourceId: string | null;
  createdAt: Date;
  account: { accountCode: string | null; category: string };
};

const SETTLED_LINE_SELECT = {
  id: true,
  accountId: true,
  journalEntryId: true,
  description: true,
  sourceId: true,
  createdAt: true,
  account: { select: { accountCode: true, category: true } },
} as const;

// Finds the real party account this component has already been
// routed to for this Challan, from an already-fetched set of lines -
// never re-querying. Two patterns establish this, both of which must
// be recognized:
//
//  1. The ORIGINAL settlement entry pairs the party with the gross
//     clearing account for this component (Dr/Cr the gross
//     account code), since that is the reclassification event.
//  2. A PRIOR correction (once a party was already known) pairs
//     the party directly with the Income/Expense account instead -
//     it no longer touches the gross account at all, since that
//     was already fully consumed.
//
// `lines` must already be every line from the original settlement
// entry AND every SETTLEMENT_CORRECTION entry for this Challan
// (across every component/Bilty) - the same set findSettledPartyAccountId()
// queries for a single lookup, and what getSettledPartyAccountIdsBatch()
// fetches once for every lookup on the same Challan. Grouped by
// (JournalEntry, description) - each such group is exactly one
// component's reclassification pair.
function resolvePartyFromLines(
  lines: SettledLine[],
  component: SettlementComponent,
  incomeOrExpenseAccountId: string,
  biltyId: string | null
): string | null {
  const grossCode = GROSS_ACCOUNT_CODES[component];
  const keyword = COMPONENT_KEYWORDS[component];
  const relevant = biltyId ? lines.filter((l) => l.sourceId === biltyId) : lines;

  const grouped = new Map<string, SettledLine[]>();
  for (const line of relevant) {
    const key = `${line.journalEntryId}:${line.description || ""}`;
    const existing = grouped.get(key) || [];
    existing.push(line);
    grouped.set(key, existing);
  }

  // A reassignment group's BOTH lines are PARTY accounts (see
  // applySettlementReassignment) - matched by description keyword
  // instead, since there is no gross/income/expense line to key off.
  function isThisComponent(group: SettledLine[]): boolean {
    if (group.some((l) => l.account.accountCode === grossCode || l.accountId === incomeOrExpenseAccountId)) {
      return true;
    }
    return (
      group.every((l) => l.account.category === "PARTY") &&
      group.some((l) => (l.description || "").includes(keyword))
    );
  }

  // The RESPONSIBLE PARTY can change over time (a reassignment moves
  // it) - unlike an amount-delta correction, which always targets
  // whichever party is already found, so every matching group there
  // shares the same party. Picking the group with the latest
  // createdAt therefore returns the CURRENT party in both cases: the
  // single-party case (delta corrections) and the changed-party case
  // (reassignments), without needing to special-case either.
  let latest: { group: SettledLine[]; createdAt: Date } | null = null;
  for (const group of grouped.values()) {
    if (!isThisComponent(group)) continue;
    const groupCreatedAt = group.reduce(
      (max, l) => (l.createdAt > max ? l.createdAt : max),
      group[0].createdAt
    );
    if (!latest || groupCreatedAt > latest.createdAt) {
      latest = { group, createdAt: groupCreatedAt };
    }
  }

  if (!latest) return null;

  // A reassignment group has TWO party lines (the OLD party's
  // reversal, created first, and the NEW party's application,
  // created second - see applySettlementReassignment); every other
  // group has exactly one. Taking the LAST party line (by the
  // deterministic createdAt+id order above) therefore always yields
  // the currently-responsible party either way.
  const partyLines = latest.group.filter((l) => l.account.category === "PARTY");
  if (partyLines.length === 0) return null;
  return partyLines[partyLines.length - 1].accountId;
}

async function fetchSettledLines(
  tx: Tx,
  challanId: string,
  settlementJournalEntryId: string
): Promise<SettledLine[]> {
  return tx.journalLine.findMany({
    where: {
      journalEntry: {
        isDeleted: false,
        OR: [
          { id: settlementJournalEntryId },
          { referenceType: "SETTLEMENT_CORRECTION", referenceId: challanId },
        ],
      },
    },
    select: SETTLED_LINE_SELECT,
    // id (cuid) as a tiebreaker makes ordering fully deterministic
    // for two lines created in the same millisecond - relied on
    // by resolvePartyFromLines() to tell a reassignment's OLD party
    // line (created first) from its NEW party line (created second).
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function findSettledPartyAccountId(
  tx: Tx,
  challanId: string,
  settlementJournalEntryId: string,
  component: SettlementComponent,
  incomeOrExpenseAccountId: string,
  biltyId: string | null
): Promise<string | null> {
  const lines = await fetchSettledLines(tx, challanId, settlementJournalEntryId);
  return resolvePartyFromLines(lines, component, incomeOrExpenseAccountId, biltyId);
}

export interface SettledPartyLookupRequest {
  component: SettlementComponent;
  incomeOrExpenseAccountId: string;
  biltyId: string | null;
}

/**
 * Resolves several (component, Bilty) party lookups for the SAME
 * Challan in one query instead of one query per lookup -
 * findSettledPartyAccountId() re-fetches the identical line set on
 * every call when used in a loop (e.g. once per Bilty per
 * component), which is wasted work for a Challan with many Bilties.
 * Returns results in the same order as `requests`; each entry is
 * exactly what findSettledPartyAccountId() would have returned for
 * that same request - this only changes how many times the database
 * is queried, never the resolution rules or their result.
 */
export async function getSettledPartyAccountIdsBatch(
  tx: Tx,
  challanId: string,
  settlementJournalEntryId: string,
  requests: SettledPartyLookupRequest[]
): Promise<(string | null)[]> {
  if (requests.length === 0) return [];
  const lines = await fetchSettledLines(tx, challanId, settlementJournalEntryId);
  return requests.map((r) => resolvePartyFromLines(lines, r.component, r.incomeOrExpenseAccountId, r.biltyId));
}

// Every referenceType that can ever carry a PARTY-account
// reclassification line for a Challan's settlement position - the
// OLD single-payer mechanism's own two ("SETTLEMENT",
// "SETTLEMENT_CORRECTION") plus the additive multi-payer engine's
// (lib/settlement-payments.ts: SETTLEMENT_PAYMENT and its own
// correction/reversal/transition entries). This is the ONE
// authoritative list both mechanisms' outstanding-balance
// calculations read from - extending it here (rather than
// duplicating a second copy) is what makes
// Challan.outstandingReceivable/outstandingPayable stay correct
// regardless of which mechanism writes next.
export const SETTLEMENT_NET_REFERENCE_TYPES = [
  "SETTLEMENT",
  "SETTLEMENT_CORRECTION",
  "SETTLEMENT_PAYMENT",
  "SETTLEMENT_PAYMENT_CORRECTION",
  "SETTLEMENT_PAYMENT_REVERSAL",
  "COLLECTION_MULTI_PAYER_TRANSITION",
  "CARRIER_RENT_MULTI_PAYER_TRANSITION",
];

// Net (debit - credit) for a party account across the Challan's
// settlement + all prior corrections, OLD single-payer mechanism AND
// the additive multi-payer engine combined (see
// SETTLEMENT_NET_REFERENCE_TYPES above). Positive = that party owes
// ANC (receivable-contributing); negative = ANC owes that party
// (payable-contributing).
//
// Collection-component entries (both the original settlement's and
// the multi-payer engine's) are tagged referenceId = the BILTY id,
// not the Challan id (matching the existing BILTY_BOOKING/
// BILTY_BOOKING_CORRECTION convention) - so every Bilty currently on
// this Challan is included in the lookup too. For a Challan with no
// SettlementPayment activity this is a pure no-op addition: the
// query returns exactly what it always returned, since no rows exist
// under the new referenceTypes.
export async function getPartyNetFromSettlement(
  tx: Tx,
  challanId: string,
  partyAccountId: string
): Promise<number> {
  const biltyLinks = await tx.challanBilty.findMany({ where: { challanId }, select: { biltyId: true } });
  const referenceIds = [challanId, ...biltyLinks.map((l) => l.biltyId)];

  const lines = await tx.journalLine.findMany({
    where: {
      accountId: partyAccountId,
      journalEntry: {
        isDeleted: false,
        referenceType: { in: SETTLEMENT_NET_REFERENCE_TYPES },
        referenceId: { in: referenceIds },
      },
    },
    select: { debit: true, credit: true },
  });

  return lines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0);
}

interface ApplyCorrectionParams {
  tx: Tx;
  component: SettlementComponent;
  delta: number; // newAmount - oldAmount
  challanId: string;
  challanNo: string;
  biltyId: string;
  biltyNo: string;
  /** Booking Income account (COLLECTION) or the relevant Expense account (CARRIER_RENT / COMMISSION). */
  incomeOrExpenseAccountId: string;
  isSettled: boolean;
  settlementJournalEntryId: string | null;
  createdById: string;
  description: string;
  /**
   * Required ONLY when correcting an already-settled Challan and no
   * party was ever established for this component (e.g. commission
   * introduced after settlement, where it was 0 at settlement time).
   * Must already be validated as a real, active PARTY account by
   * the caller. If omitted in that situation,
   * MissingResponsiblePartyError is thrown.
   */
  explicitPartyAccountId?: string | null;
}

/**
 * Posts a balanced correction for a single Bilty-rent / Carrier-rent
 * / Commission delta, routed correctly depending on whether the
 * Challan has already been settled, and (if settled) recalculates
 * Challan.outstandingReceivable/outstandingPayable to include it -
 * without touching anything Daily-Posting-sourced. Correctly moves
 * a party across the receivable/payable boundary when the
 * correction is large enough to cross zero.
 */
export async function applySettlementCorrection(params: ApplyCorrectionParams): Promise<void> {
  const {
    tx,
    component,
    delta,
    challanId,
    challanNo,
    biltyId,
    biltyNo,
    incomeOrExpenseAccountId,
    isSettled,
    settlementJournalEntryId,
    createdById,
    description,
    explicitPartyAccountId,
  } = params;

  if (delta === 0) return;

  const sourceType = component === "CARRIER_RENT" ? "CHALLAN" : "BILTY";
  const sourceId = component === "CARRIER_RENT" ? challanId : biltyId;
  const sourceNumber = component === "CARRIER_RENT" ? challanNo : biltyNo;

  if (!isSettled || !settlementJournalEntryId) {
    // Not yet settled: correct against the same gross account the
    // original booking/dispatch entry used. Settlement, whenever it
    // eventually runs, reads the Bilty/Challan's current amount and
    // will reclassify the full corrected balance - always netting
    // the gross account back to zero.
    const grossAccountId = await getGrossAccountId(tx, component);

    const lines =
      component === "COLLECTION"
        ? buildDeltaLines(delta, grossAccountId, incomeOrExpenseAccountId)
        : buildDeltaLines(delta, incomeOrExpenseAccountId, grossAccountId);

    await tx.journalEntry.create({
      data: {
        entryDate: new Date(),
        referenceType:
          component === "CARRIER_RENT" ? "CHALLAN_DISPATCH_CORRECTION" : "BILTY_BOOKING_CORRECTION",
        referenceId: sourceId,
        description,
        createdById,
        lines: {
          create: lines.map((l) => ({
            ...l,
            description,
            sourceType,
            sourceId,
            sourceNumber,
          })),
        },
      },
    });
    return;
  }

  // Already settled: the gross account for this component has
  // already been fully reclassified into a real party. Correct
  // directly against that same party.
  const foundPartyAccountId = await findSettledPartyAccountId(
    tx,
    challanId,
    settlementJournalEntryId,
    component,
    incomeOrExpenseAccountId,
    component === "CARRIER_RENT" ? null : biltyId
  );

  const partyAccountId = foundPartyAccountId || explicitPartyAccountId || null;

  if (!partyAccountId) {
    throw new MissingResponsiblePartyError(component, biltyNo, challanNo);
  }

  // The party's net position BEFORE this correction is posted -
  // needed to correctly move the Challan's aggregate
  // outstandingReceivable/outstandingPayable, including flipping
  // this party from one bucket to the other if the correction is
  // large enough to cross zero.
  const existingNet = await getPartyNetFromSettlement(tx, challanId, partyAccountId);

  const lines =
    component === "COLLECTION"
      ? buildDeltaLines(delta, partyAccountId, incomeOrExpenseAccountId)
      : buildDeltaLines(delta, incomeOrExpenseAccountId, partyAccountId);

  await tx.journalEntry.create({
    data: {
      entryDate: new Date(),
      referenceType: "SETTLEMENT_CORRECTION",
      referenceId: challanId,
      description,
      createdById,
      lines: {
        create: lines.map((l) => ({
          ...l,
          description,
          sourceType,
          sourceId,
          sourceNumber,
        })),
      },
    },
  });

  // Recalculate the Challan's aggregate outstanding receivable/
  // payable to include this correction. COLLECTION corrections
  // debit the party (push toward receivable); CARRIER_RENT/
  // COMMISSION corrections credit the party (push toward payable).
  const pushesTowardReceivable = component === "COLLECTION";
  const partyEffect = pushesTowardReceivable ? delta : -delta;
  const newNet = existingNet + partyEffect;

  const challan = await tx.challan.findUniqueOrThrow({
    where: { id: challanId },
    select: { outstandingReceivable: true, outstandingPayable: true },
  });

  let outstandingReceivable = Number(challan.outstandingReceivable);
  let outstandingPayable = Number(challan.outstandingPayable);

  // Remove this party's OLD contribution from whichever bucket it
  // was previously in...
  if (existingNet > 0) {
    outstandingReceivable -= existingNet;
  } else if (existingNet < 0) {
    outstandingPayable -= -existingNet;
  }

  // ...then add its NEW contribution to whichever bucket the
  // corrected net actually belongs in. This is what allows a party
  // to flip from receivable to payable (or back) instead of being
  // clamped to zero on both sides.
  if (newNet > 0) {
    outstandingReceivable += newNet;
  } else if (newNet < 0) {
    outstandingPayable += -newNet;
  }

  // Defensive clamp only - correct bookkeeping should never drive
  // these negative, but floating point on repeated corrections
  // should never be allowed to surface as a negative outstanding.
  outstandingReceivable = Math.max(0, outstandingReceivable);
  outstandingPayable = Math.max(0, outstandingPayable);

  await tx.challan.update({
    where: { id: challanId },
    data: {
      outstandingReceivable: Number(outstandingReceivable.toFixed(2)),
      outstandingPayable: Number(outstandingPayable.toFixed(2)),
    },
  });
}

// ============================================================
// SUPER-ADMIN SETTLEMENT REASSIGNMENT (edit an existing
// Final Settlement's responsibility - not an amount edit)
//
// applySettlementCorrection() above only handles a CHANGE IN
// AMOUNT for a component that stays with the same responsible
// party. Editing a finalized Settlement is a different
// operation: the amount is unchanged, but the RESPONSIBLE PARTY
// for a component is being reassigned (e.g. Collection was
// routed to the Clearing Agent but should have gone to the
// Transporter).
//
// This posts a single balanced SETTLEMENT_CORRECTION entry that
// moves the component's current ledger-net straight from the old
// party to the new one. It never touches the gross/income/expense
// accounts (already fully reclassified by the original Settlement),
// so Income/Expense can never be double-counted. It DOES re-bucket
// outstandingReceivable/outstandingPayable (mirroring
// applySettlementCorrection()'s own remove-old/add-new pattern),
// because those are aggregated per party's BLENDED net across every
// component - moving one component out of a party that carries
// other components (or into one that already does) can shift which
// bucket each party's blended net now belongs to, even though nets
// are only ever moved, never invented. This is a pure extension of
// the existing reclassify-only architecture, not a new accounting
// system.
// ============================================================

// Current ledger-net (debit - credit) of `partyAccountId`'s OWN
// line(s) across every group (original settlement + every
// correction/reassignment) that match this component for this
// Bilty/Challan - i.e. the up-to-date amount presently attributed
// to that specific party. `partyAccountId` should be whichever
// party findSettledPartyAccountId() just returned (the CURRENT
// party) - summing only that account's own lines, rather than
// every PARTY-category line in a matching group, is required
// because a reassignment group contains TWO party lines (the old
// party's reversal and the new party's application); summing both
// would net to zero and hide the very thing being measured.
export async function getComponentNetAmount(
  tx: Tx,
  challanId: string,
  settlementJournalEntryId: string,
  component: SettlementComponent,
  incomeOrExpenseAccountId: string,
  biltyId: string | null,
  partyAccountId: string
): Promise<number> {
  const lines = await tx.journalLine.findMany({
    where: {
      journalEntry: {
        isDeleted: false,
        OR: [
          { id: settlementJournalEntryId },
          { referenceType: "SETTLEMENT_CORRECTION", referenceId: challanId },
        ],
      },
    },
    select: {
      accountId: true,
      journalEntryId: true,
      description: true,
      sourceId: true,
      debit: true,
      credit: true,
      createdAt: true,
      account: { select: { accountCode: true, category: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const grossCode = GROSS_ACCOUNT_CODES[component];
  const keyword = COMPONENT_KEYWORDS[component];
  const relevant = biltyId ? lines.filter((l) => l.sourceId === biltyId) : lines;

  const grouped = new Map<string, typeof lines>();
  for (const line of relevant) {
    const key = `${line.journalEntryId}:${line.description || ""}`;
    const existing = grouped.get(key) || [];
    existing.push(line);
    grouped.set(key, existing);
  }

  function isThisComponent(group: typeof lines): boolean {
    if (group.some((l) => l.account.accountCode === grossCode || l.accountId === incomeOrExpenseAccountId)) {
      return true;
    }
    return (
      group.every((l) => l.account.category === "PARTY") &&
      group.some((l) => (l.description || "").includes(keyword))
    );
  }

  let net = 0;
  for (const group of grouped.values()) {
    if (!isThisComponent(group)) continue;
    for (const line of group) {
      if (line.accountId === partyAccountId) {
        net += Number(line.debit) - Number(line.credit);
      }
    }
  }

  return net;
}

interface ApplyReassignmentParams {
  tx: Tx;
  component: SettlementComponent;
  challanId: string;
  challanNo: string;
  /** null for CARRIER_RENT (challan-level, not per-bilty). */
  biltyId: string | null;
  biltyNo: string | null;
  incomeOrExpenseAccountId: string;
  settlementJournalEntryId: string;
  newPartyAccountId: string;
  createdById: string;
  description: string;
}

export interface SettlementReassignmentResult {
  reassigned: boolean;
  amount: number;
  oldPartyAccountId: string | null;
}

/**
 * Reassigns a single already-settled component (Collection /
 * Carrier Rent / Commission) from whichever party is currently
 * responsible to `newPartyAccountId`, without changing the amount.
 * No-ops (returns reassigned:false) when nothing is established yet
 * for this component (net is zero - there is nothing to move) or
 * the new party is already the current one.
 */
export async function applySettlementReassignment(
  params: ApplyReassignmentParams
): Promise<SettlementReassignmentResult> {
  const {
    tx,
    component,
    challanId,
    challanNo,
    biltyId,
    biltyNo,
    incomeOrExpenseAccountId,
    settlementJournalEntryId,
    newPartyAccountId,
    createdById,
    description,
  } = params;

  const oldPartyAccountId = await findSettledPartyAccountId(
    tx,
    challanId,
    settlementJournalEntryId,
    component,
    incomeOrExpenseAccountId,
    biltyId
  );

  if (!oldPartyAccountId || oldPartyAccountId === newPartyAccountId) {
    return { reassigned: false, amount: 0, oldPartyAccountId };
  }

  const net = await getComponentNetAmount(
    tx,
    challanId,
    settlementJournalEntryId,
    component,
    incomeOrExpenseAccountId,
    biltyId,
    oldPartyAccountId
  );

  const amount = Math.abs(net);
  if (amount < 0.01) {
    return { reassigned: false, amount: 0, oldPartyAccountId };
  }

  // Each party's TOTAL net across every component of this Challan's
  // settlement (not just this one component) - needed BEFORE the
  // move, because outstandingReceivable/outstandingPayable are
  // aggregated per BLENDED party net, not per component. Moving one
  // component out of a party that carries other components too (or
  // into a party that already carries some) can change which bucket
  // each party's blended net now falls into, even though the
  // Challan-wide sum of every party's net is unchanged.
  const oldPartyNetBefore = await getPartyNetFromSettlement(tx, challanId, oldPartyAccountId);
  const newPartyNetBefore = await getPartyNetFromSettlement(tx, challanId, newPartyAccountId);

  const sourceType = component === "CARRIER_RENT" ? "CHALLAN" : "BILTY";
  const sourceId = component === "CARRIER_RENT" ? challanId : (biltyId as string);
  const sourceNumber = component === "CARRIER_RENT" ? challanNo : (biltyNo as string);

  // net > 0: the old party carries a debit balance from this
  // component (receivable-side, e.g. Collection) - reverse with a
  // credit, apply the same debit to the new party. net < 0: the old
  // party carries a credit balance (payable-side, e.g. Carrier
  // Rent/Commission) - reverse with a debit, apply the same credit
  // to the new party. Either way the two lines are equal and
  // opposite - a pure party-to-party reclassification that never
  // touches a gross/income/expense account, so it can never
  // double-count Income/Expense.
  const lines: CorrectionLine[] =
    net > 0
      ? [
          { accountId: oldPartyAccountId, debit: 0, credit: amount },
          { accountId: newPartyAccountId, debit: amount, credit: 0 },
        ]
      : [
          { accountId: oldPartyAccountId, debit: amount, credit: 0 },
          { accountId: newPartyAccountId, debit: 0, credit: amount },
        ];

  await tx.journalEntry.create({
    data: {
      entryDate: new Date(),
      referenceType: "SETTLEMENT_CORRECTION",
      referenceId: challanId,
      description,
      createdById,
      lines: {
        create: lines.map((l) => ({
          ...l,
          description,
          sourceType,
          sourceId,
          sourceNumber,
        })),
      },
    },
  });

  // Re-bucket both parties' blended net into
  // outstandingReceivable/outstandingPayable, the same
  // remove-old-contribution / add-new-contribution pattern
  // applySettlementCorrection() already uses - applied once for the
  // party losing this component's net, once for the party gaining
  // it. When both parties keep the SAME other components they had
  // before, this nets out to no aggregate change; when a
  // reassignment splits or merges components across different
  // parties, the aggregate correctly reflects the new attribution.
  const oldPartyNetAfter = oldPartyNetBefore - net;
  const newPartyNetAfter = newPartyNetBefore + net;

  const challanRow = await tx.challan.findUniqueOrThrow({
    where: { id: challanId },
    select: { outstandingReceivable: true, outstandingPayable: true },
  });

  let outstandingReceivable = Number(challanRow.outstandingReceivable);
  let outstandingPayable = Number(challanRow.outstandingPayable);

  if (oldPartyNetBefore > 0) outstandingReceivable -= oldPartyNetBefore;
  else if (oldPartyNetBefore < 0) outstandingPayable -= -oldPartyNetBefore;
  if (oldPartyNetAfter > 0) outstandingReceivable += oldPartyNetAfter;
  else if (oldPartyNetAfter < 0) outstandingPayable += -oldPartyNetAfter;

  if (newPartyNetBefore > 0) outstandingReceivable -= newPartyNetBefore;
  else if (newPartyNetBefore < 0) outstandingPayable -= -newPartyNetBefore;
  if (newPartyNetAfter > 0) outstandingReceivable += newPartyNetAfter;
  else if (newPartyNetAfter < 0) outstandingPayable += -newPartyNetAfter;

  // Defensive clamp only, mirroring applySettlementCorrection().
  outstandingReceivable = Math.max(0, outstandingReceivable);
  outstandingPayable = Math.max(0, outstandingPayable);

  await tx.challan.update({
    where: { id: challanId },
    data: {
      outstandingReceivable: Number(outstandingReceivable.toFixed(2)),
      outstandingPayable: Number(outstandingPayable.toFixed(2)),
    },
  });

  return { reassigned: true, amount, oldPartyAccountId };
}
