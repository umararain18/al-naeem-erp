import { prisma } from "@/lib/prisma";

// ============================================================
// PARTY LEDGER - USER-FACING DISPLAY TRANSFORMATION
//
// STRICTLY READ-ONLY, STRICTLY DISPLAY-ONLY. This module never
// creates, mutates, or deletes a JournalEntry/JournalLine/
// SettlementPayment. It only re-labels and re-groups rows that
// app/api/parties/[id]/ledger/route.ts has already fetched from
// the existing, protected accounting tables, for the single
// purpose of rendering plain business language on the Party
// Ledger's default view. The authoritative opening/closing
// balance, Trial Balance, P&L, Receivable/Payable, and every
// other report continue to be computed exactly as before, from
// the same raw JournalLine rows, completely independent of
// anything in this file.
//
// GROUPING KEY: SettlementPayment.id (see prisma/schema.prisma's
// own comment on that model). A row's create-time JournalEntry is
// found via SettlementPayment.journalEntryId (unique, always
// precise). Its correction/reversal JournalEntries are found via
// JournalLine.sourceType === "SETTLEMENT_PAYMENT" &&
// JournalLine.sourceId === that row's id (also always precise -
// see lib/settlement-payments.ts's updateSettlementPaymentAmount/
// deleteSettlementPayment). Once a row is deleted, its own
// create-time JournalEntry can no longer be re-associated with
// 100% certainty in the rare case where the SAME payer account
// created more than one SettlementPayment for the exact same
// Bilty/Challan+component (the create-time line only carries the
// document's id, not the row's id) - see the KNOWN LIMITATION note
// on groupSettlementPaymentLines() below. This is a display
// fallback only: it never loses data (the raw lines still render,
// just as two separate readable rows instead of one merged row)
// and never misattributes an amount.
// ============================================================

export interface RawLedgerLine {
  id: string;
  journalEntryId: string;
  entryDate: Date;
  createdAt: Date;
  referenceType: string | null;
  referenceId: string | null;
  entryDescription: string | null;
  lineDescription: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNumber: string | null;
  debit: number;
  credit: number;
}

export interface DisplayHistoryItem {
  date: string;
  referenceType: string | null;
  description: string;
  debit: number;
  credit: number;
}

// Reliable document-type classification, derived from the SAME
// sourceType/referenceType/sourceId relationships every branch below
// already resolves a Bilty/Challan/Phonch/PrivatePhonch context from -
// never inferred from description text. This is the ONE centralized
// classification for the whole ledger (screen, PDF, Excel, General
// Ledger all read it from here) - no separate type-detection logic
// exists anywhere else.
export type LedgerEntryType = "BILTY" | "CHALLAN" | "PRIVATE_PHONCH" | "SHOWROOM_PHONCH" | "BILL" | "OTHER";

const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = ["BILTY", "CHALLAN", "PRIVATE_PHONCH", "SHOWROOM_PHONCH", "BILL", "OTHER"];

/** Shared query-param parser for every ledger route (screen/PDF/Excel/General Ledger) - "All"/missing/unrecognized all mean no filter (null), never a thrown error, so a stale/bad `type` param degrades safely to the existing unfiltered view. */
export function parseLedgerEntryType(value: string | null | undefined): LedgerEntryType | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return (LEDGER_ENTRY_TYPES as readonly string[]).includes(upper) ? (upper as LedgerEntryType) : null;
}

export interface DisplayLedgerRow {
  id: string;
  date: string;
  reference: string;
  referenceHref: string | null;
  description: string;
  debit: number;
  credit: number;
  isGrouped: boolean;
  isRemoved: boolean;
  history: DisplayHistoryItem[];
  documentType: LedgerEntryType;
  // Internal-only ordering keys (never rendered, and deliberately
  // dropped before this row is copied into FinalLedgerRow) - see
  // compareChronological() above. Kept as real Date/id values here,
  // not a precomputed number, so the SAME comparator can also govern
  // the running-balance accumulation order in getAccountLedgerData().
  sortEntryDate: Date;
  sortCreatedAt: Date;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Local calendar-day key (year*10000+month*100+day, in the server's
// own local time - the same implicit convention already used
// everywhere else in this codebase, e.g. Daily Posting's entryDate
// itself). Used ONLY to compare two rows' entryDate at day
// granularity - never their exact instant - because Daily Posting's
// entryDate carries no real time-of-day (it is always stored as
// local midnight; see app/api/daily-posting/route.ts), so comparing
// full timestamps would make a same-day Daily Posting receipt sort
// as if it happened before anything else booked that same day, even
// when it was actually posted hours later.
function localDayKey(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// Single chronological comparator shared by every ordering decision
// in this file (both the running-balance accumulation order AND the
// newest-first display order use this SAME definition - see the
// "order" option's doc comment on AccountLedgerOptions below). Two
// rows are compared by calendar day first (their real, business-
// meaningful transaction date), then - ONLY as a same-day tiebreak -
// by actual posting time (createdAt, which always has full instant
// precision, unlike entryDate), then by id for full determinism.
function compareChronological(
  a: { sortEntryDate: Date; sortCreatedAt: Date; id: string },
  b: { sortEntryDate: Date; sortCreatedAt: Date; id: string }
): number {
  const dayDiff = localDayKey(a.sortEntryDate) - localDayKey(b.sortEntryDate);
  if (dayDiff !== 0) return dayDiff;
  const createdDiff = a.sortCreatedAt.getTime() - b.sortCreatedAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function formatRs(value: number): string {
  return `Rs. ${Math.round(Math.abs(value)).toLocaleString()}`;
}

// referenceTypes that represent an actual Cash/Bank <-> Party
// movement (Daily Posting). Every OTHER referenceType is a
// recognition/reclassification event (booking, settlement,
// settlement payment). The two families use OPPOSITE debit/credit
// polarity for "Received"/"Paid" wording - see the module doc
// comment on directionWord() below for why.
const CASH_MOVEMENT_REFERENCE_TYPES = new Set(["DAILY_POSTING"]);

// Housekeeping referenceTypes belonging to the OLD single-payer
// default-attribution mechanism and its multi-payer "floor"
// transition companion. When a document's Collection/Carrier Rent
// is fully handed over to the new multi-payer engine, these two
// legs net to EXACTLY zero on the affected account - pure internal
// plumbing with no remaining balance, safe to omit from the normal
// view. Never omitted unless the net is provably zero.
const HOUSEKEEPING_REFERENCE_TYPES = new Set([
  "SETTLEMENT",
  "SETTLEMENT_CORRECTION",
  "COLLECTION_MULTI_PAYER_TRANSITION",
  "CARRIER_RENT_MULTI_PAYER_TRANSITION",
]);

const SIMPLE_REFERENCE_LABELS: Record<string, string> = {
  BILTY_BOOKING: "Bilty Booking",
  BILTY_BOOKING_CORRECTION: "Bilty Correction",
  CHALLAN_DISPATCH: "Challan Dispatch",
  CHALLAN_DISPATCH_CORRECTION: "Challan Correction",
  OPENING_BALANCE: "Opening Balance",
  PAID_RESPONSIBILITY_REASSIGNMENT: "Paid Responsibility",
  // Live multi-payer Final Settlement mechanism (lib/settlement-payments.ts)
  // and the old single-payer mechanism (lib/settlement-accounting.ts /
  // lib/settlement-correction.ts) - previously fell through to the raw
  // referenceType string below when the combined net wasn't provably
  // zero (see extractHousekeepingNoise() above), which is a real,
  // everyday occurrence for any party involved in a Final Settlement.
  SETTLEMENT: "Settlement",
  SETTLEMENT_CORRECTION: "Settlement Correction",
  SETTLEMENT_PAYMENT: "Settlement Payment",
  SETTLEMENT_PAYMENT_CORRECTION: "Settlement Payment Correction",
  SETTLEMENT_PAYMENT_REVERSAL: "Settlement Payment Reversal",
  COLLECTION_MULTI_PAYER_TRANSITION: "Collection Transition",
  CARRIER_RENT_MULTI_PAYER_TRANSITION: "Carrier Rent Transition",
  PAYROLL_SALARY: "Salary",
  PAYROLL_PAYMENT: "Salary Payment",
};

/** Business-readable label for a raw JournalEntry.referenceType -
 * never the raw enum value itself. Used both for the main Source/
 * Reference column's fallback (line 638-ish below) and for each
 * row's own Revision History "Type" column (toHistoryItem()),
 * so a technical value like "SETTLEMENT_PAYMENT_CORRECTION" is never
 * shown to a normal user in either place. */
function friendlyReferenceTypeLabel(referenceType: string | null): string {
  if (!referenceType) return "Direct Entry";
  return SIMPLE_REFERENCE_LABELS[referenceType] || referenceType;
}

/**
 * "Received"/"Paid" wording, oriented the same way the existing
 * RECEIVABLE/PAYABLE balanceType on this exact page already is:
 * a recognition-family debit ("this party now owes us more") reads
 * as "Received" (an amount we are to receive from them); a credit
 * reads as "Paid". A Daily Posting line represents the OPPOSITE -
 * an actual cash movement - so its polarity is inverted: when the
 * Cash/Bank account was debited (money physically came in), the
 * counter Party line is a CREDIT, and that is the real receipt -
 * "Received". See app/api/daily-posting/route.ts's buildLinePair()
 * for the exact debit/credit pairing this depends on.
 */
function directionWord(referenceType: string | null, debit: number, credit: number): "Received" | "Paid" {
  const isCashMovement = referenceType ? CASH_MOVEMENT_REFERENCE_TYPES.has(referenceType) : false;
  if (isCashMovement) {
    return credit > debit ? "Received" : "Paid";
  }
  return debit >= credit ? "Received" : "Paid";
}

interface BiltyCtx {
  id: string;
  biltyNo: string;
  vehicleType: string | null;
  vehicleModel: string | null;
  chassisNumber: string | null;
}

interface ChallanCtx {
  id: string;
  challanNo: string;
  carrierNumber: string | null;
  transporterName: string | null;
  soleBiltyId: string | null;
  soleBiltyNo: string | null;
  // EVERY Bilty linked to this Challan (not just "sole") - used only
  // for vehicle display, so a multi-vehicle Challan can show all of
  // its vehicles instead of collapsing to a single one. Bilty No
  // display still uses soleBiltyNo above, unchanged.
  bilties: BiltyCtx[];
}

function vehicleLabel(bilty: BiltyCtx | undefined | null): string | null {
  if (!bilty) return null;
  return bilty.vehicleModel || bilty.vehicleType || null;
}

/** Vehicle label for every Bilty in the list, comma-separated - never collapsed to just the first. */
function vehicleLabels(bilties: BiltyCtx[]): string | null {
  const labels = bilties.map(vehicleLabel).filter((v): v is string => !!v);
  return labels.length > 0 ? labels.join(", ") : null;
}

/** Appends every non-null PrivatePhonchVehicle.vehicleName linked to this Private Phonch to an already-composed description, live on every read - so it applies to historical entries too, without touching the stored text or lib/private-phonch-accounting.ts. */
function appendPhonchVehicleNames(description: string, phonchId: string, vehicleNamesById: Map<string, string[]>): string {
  const names = vehicleNamesById.get(phonchId);
  if (!names || names.length === 0) return description;
  return `${description}, ${names.join(", ")}`;
}

/** Screen-only Source/Reference label - "Bilty No 66", never "Bilty #66". */
function biltyReference(biltyNo: string): string {
  return `Bilty No ${biltyNo}`;
}

/** Screen-only Source/Reference label - "Challan No 4013", never "Challan #4013". */
function challanReference(challanNo: string): string {
  return `Challan No ${challanNo}`;
}

/**
 * Comma-separated business description - the SAME text is used both
 * on screen (next to the Source column) and as the ENTIRE row in
 * PDF/Excel exports (which carry no Source column at all), so it
 * must be fully self-contained. Only includes a field when the
 * underlying data actually exists - never invented.
 */
function biltyDescription(bilty: BiltyCtx, amount: number, direction: "Received" | "Paid"): string {
  const parts: string[] = [biltyReference(bilty.biltyNo)];
  const veh = vehicleLabel(bilty);
  if (veh) parts.push(veh);
  if (bilty.chassisNumber) parts.push(`Chassis No ${bilty.chassisNumber}`);
  return `${parts.join(", ")}, ${direction} ${formatRs(amount)}`;
}

/**
 * Carrier No (the Challan's own carrierNumber field, e.g. a truck/
 * container registration like "TMA-786") and Transporter (the
 * Transporter Party's name) are DELIBERATELY separate concepts and
 * are never combined into one field - see the approved v2 spec.
 */
function challanDescription(
  challan: ChallanCtx,
  // The SPECIFIC Bilty this line concerns, when known (e.g. a
  // per-Bilty proportional Carrier Rent slice), takes priority over
  // the Challan's own "sole Bilty" (only meaningful when the Challan
  // has exactly one Bilty and no specific one was identified). Bilty
  // No display behavior here is UNCHANGED.
  relevantBilty: BiltyCtx | undefined | null,
  amount: number,
  direction: "Received" | "Paid"
): string {
  const parts: string[] = [challanReference(challan.challanNo)];
  const biltyNoText = relevantBilty?.biltyNo || challan.soleBiltyNo;
  if (biltyNoText) parts.push(biltyReference(biltyNoText));
  if (challan.carrierNumber) parts.push(`Carrier No ${challan.carrierNumber}`);
  if (challan.transporterName) parts.push(`Transporter ${challan.transporterName}`);
  // Vehicle display: when a SPECIFIC Bilty is known for this line,
  // show just that one vehicle (the amount concerns that Bilty
  // alone). Otherwise show every vehicle linked to the Challan -
  // never collapsed to a single "sole" vehicle - so a multi-vehicle
  // Challan's generic/Challan-level lines still show all of them.
  const veh = relevantBilty ? vehicleLabel(relevantBilty) : vehicleLabels(challan.bilties);
  if (veh) parts.push(veh);
  return `${parts.join(", ")}, ${direction} ${formatRs(amount)}`;
}

interface SettlementPaymentLite {
  id: string;
  journalEntryId: string;
  component: string;
  biltyId: string | null;
  challanId: string | null;
  amount: number;
}

interface Bucket {
  lines: RawLedgerLine[];
  payment?: SettlementPaymentLite;
  removedPaymentId?: string;
}

/**
 * KNOWN LIMITATION (documented, not silently swallowed): if the
 * SAME payer account creates MORE THAN ONE SettlementPayment for
 * the exact same Bilty/Challan+component, and one of them is later
 * deleted, this function cannot always tell which of the (possibly
 * several) matching create-time lines belonged to the deleted row
 * versus a still-active one - the create-time line only carries the
 * document's id (sourceType/sourceId), never the row's own id. This
 * never causes a wrong amount or lost data: the affected lines
 * simply render individually via describeStandaloneLine() instead
 * of collapsing into one row. This is a narrow, rare edge case
 * (repeated same-payer settlement payments on the same document);
 * the single/first-payment-per-document case (the overwhelming
 * majority of real usage) groups perfectly.
 */
function groupSettlementPaymentLines(
  lines: RawLedgerLine[],
  settlementPayments: SettlementPaymentLite[]
): { buckets: Map<string, Bucket>; standalone: RawLedgerLine[] } {
  const byJournalEntryId = new Map(settlementPayments.map((p) => [p.journalEntryId, p]));
  const byId = new Map(settlementPayments.map((p) => [p.id, p]));

  const buckets = new Map<string, Bucket>();
  const standalone: RawLedgerLine[] = [];

  function addTo(key: string, line: RawLedgerLine, extra: Partial<Bucket>) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { lines: [], ...extra };
      buckets.set(key, bucket);
    }
    bucket.lines.push(line);
  }

  for (const line of lines) {
    if (line.sourceType === "SETTLEMENT_PAYMENT" && line.sourceId) {
      const existing = byId.get(line.sourceId);
      addTo(`sp:${line.sourceId}`, line, existing ? { payment: existing } : { removedPaymentId: line.sourceId });
      continue;
    }

    const matched = byJournalEntryId.get(line.journalEntryId);
    if (matched && line.referenceType === "SETTLEMENT_PAYMENT") {
      addTo(`sp:${matched.id}`, line, { payment: matched });
      continue;
    }

    standalone.push(line);
  }

  return { buckets, standalone };
}

/**
 * Fully-superseded internal plumbing: the old single-payer default
 * attribution for a document immediately followed by the new
 * multi-payer engine's own "release back to Gross" transition,
 * netting to exactly zero on this account. Only ever collapsed when
 * the combined net is provably zero - a non-zero remainder (e.g. a
 * Paid amount still legitimately held by the original party) is
 * NEVER hidden, and instead renders individually.
 */
function extractHousekeepingNoise(lines: RawLedgerLine[]): { remaining: RawLedgerLine[]; suppressed: RawLedgerLine[] } {
  const remaining: RawLedgerLine[] = [];
  const suppressed: RawLedgerLine[] = [];
  const hkBuckets = new Map<string, RawLedgerLine[]>();

  for (const line of lines) {
    if (HOUSEKEEPING_REFERENCE_TYPES.has(line.referenceType || "") && line.sourceType && line.sourceId) {
      // The OLD single-payer mechanism's own Carrier Rent reclassification
      // is tagged sourceType:"BILTY"/sourceId:<biltyId> (it allocates
      // Carrier Rent PROPORTIONALLY per Bilty - see the identical note
      // elsewhere in this file), while the NEW multi-payer engine's own
      // "release back to Gross" transition that is meant to cancel it out
      // is tagged sourceType:"CHALLAN"/sourceId:<challanId> (it operates
      // at Challan granularity). Bucketing by sourceType:sourceId alone
      // therefore puts the two cancelling lines in DIFFERENT buckets -
      // each with a nonzero net on its own - so neither ever gets
      // suppressed, and both render as if they were separate real
      // transactions (this is the confirmed root cause of a Carrier-Rent
      // Challan appearing to double up in Party Ledger). Fixed by keying
      // the old mechanism's Carrier Rent line on the SAME Challan id its
      // own JournalEntry.referenceId already carries (not its
      // sourceId), so it lands in the identical bucket as the
      // transition line for the same Challan. Detected via the line's
      // own already-persisted description text - the same precedent
      // already used elsewhere in this file for this exact
      // per-Bilty-tagged-but-Challan-driven distinction - never guessed,
      // never amount/date matching.
      const isOldMechanismCarrierRentLine =
        line.sourceType === "BILTY" &&
        (line.referenceType === "SETTLEMENT" || line.referenceType === "SETTLEMENT_CORRECTION") &&
        line.referenceId &&
        (line.lineDescription || line.entryDescription || "").includes("Carrier Rent");
      const key = isOldMechanismCarrierRentLine
        ? `hk:CHALLAN:${line.referenceId}`
        : `hk:${line.sourceType}:${line.sourceId}`;
      const arr = hkBuckets.get(key) || [];
      arr.push(line);
      hkBuckets.set(key, arr);
    } else {
      remaining.push(line);
    }
  }

  for (const arr of hkBuckets.values()) {
    const net = round2(arr.reduce((s, l) => s + l.debit - l.credit, 0));
    const hasTransition = arr.some(
      (l) => l.referenceType === "COLLECTION_MULTI_PAYER_TRANSITION" || l.referenceType === "CARRIER_RENT_MULTI_PAYER_TRANSITION"
    );
    if (Math.abs(net) < 0.01 && hasTransition && arr.length > 1) {
      suppressed.push(...arr);
    } else {
      remaining.push(...arr);
    }
  }

  return { remaining, suppressed };
}

function toHistoryItem(line: RawLedgerLine): DisplayHistoryItem {
  return {
    date: line.entryDate.toISOString(),
    referenceType: friendlyReferenceTypeLabel(line.referenceType),
    description: line.lineDescription || line.entryDescription || "—",
    debit: line.debit,
    credit: line.credit,
  };
}

export async function buildUserFacingLedgerRows(accountId: string, lines: RawLedgerLine[]): Promise<DisplayLedgerRow[]> {
  if (lines.length === 0) return [];

  const settlementPaymentsRaw = await prisma.settlementPayment.findMany({
    where: { payerAccountId: accountId },
    select: { id: true, journalEntryId: true, component: true, biltyId: true, challanId: true, amount: true },
  });
  const settlementPayments: SettlementPaymentLite[] = settlementPaymentsRaw.map((p) => ({
    id: p.id,
    journalEntryId: p.journalEntryId,
    component: p.component,
    biltyId: p.biltyId,
    challanId: p.challanId,
    amount: Number(p.amount),
  }));

  const { buckets, standalone } = groupSettlementPaymentLines(lines, settlementPayments);
  const { remaining, suppressed } = extractHousekeepingNoise(standalone);
  void suppressed; // fully-zero-net internal plumbing - intentionally not rendered, never deleted from the database

  // ----------------------------------------------------------
  // Collect every Bilty/Challan id this account's rows could need
  // for a business description, batched into two queries.
  // ----------------------------------------------------------
  const biltyIds = new Set<string>();
  const challanIds = new Set<string>();
  // Every Private Phonch id a PRIVATE_PHONCH-sourced/referenced line
  // could need a live PrivatePhonchVehicle lookup for - display-only,
  // used solely to append vehicle names to the already pre-composed
  // description below.
  const privatePhonchIds = new Set<string>();

  for (const bucket of buckets.values()) {
    if (bucket.payment?.biltyId) biltyIds.add(bucket.payment.biltyId);
    if (bucket.payment?.challanId) challanIds.add(bucket.payment.challanId);
  }
  for (const line of remaining) {
    if (line.sourceType === "BILTY" && line.sourceId) biltyIds.add(line.sourceId);
    if (line.sourceType === "CHALLAN" && line.sourceId) challanIds.add(line.sourceId);
    if (line.sourceType === "PRIVATE_PHONCH" && line.sourceId) privatePhonchIds.add(line.sourceId);
    if (line.referenceType === "PRIVATE_PHONCH" && line.referenceId) privatePhonchIds.add(line.referenceId);
    if ((line.referenceType === "BILTY_BOOKING" || line.referenceType === "BILTY_BOOKING_CORRECTION") && line.referenceId) {
      biltyIds.add(line.referenceId);
    }
    if (
      (line.referenceType === "CHALLAN_DISPATCH" ||
        line.referenceType === "CHALLAN_DISPATCH_CORRECTION" ||
        line.referenceType === "SETTLEMENT" ||
        line.referenceType === "SETTLEMENT_CORRECTION") &&
      line.referenceId
    ) {
      // Included even when sourceType is "BILTY" - the OLD single-
      // payer mechanism allocates Carrier Rent PROPORTIONALLY per
      // Bilty (see lib/settlement-accounting.ts), so a Carrier Rent
      // SETTLEMENT line is tagged sourceType:"BILTY" at the LINE
      // level even though it is a Challan-driven transaction that
      // needs the Challan's Carrier No/Transporter fetched too.
      challanIds.add(line.referenceId);
    }
  }

  // Daily Posting lines with no direct document tag - try
  // PaymentAllocation (the existing, additive "which document does
  // this payment apply to" lookup) before giving up.
  const untaggedDailyPostingLineIds = remaining
    .filter((l) => l.referenceType === "DAILY_POSTING" && !(l.sourceType === "BILTY" || l.sourceType === "CHALLAN"))
    .map((l) => l.id);

  const allocationByLineId = new Map<string, { targetSourceType: string; targetSourceId: string }>();
  if (untaggedDailyPostingLineIds.length > 0) {
    const allocations = await prisma.paymentAllocation.findMany({
      where: { journalLineId: { in: untaggedDailyPostingLineIds } },
      select: { journalLineId: true, targetSourceType: true, targetSourceId: true },
    });
    for (const a of allocations) {
      if (!allocationByLineId.has(a.journalLineId)) {
        allocationByLineId.set(a.journalLineId, { targetSourceType: a.targetSourceType, targetSourceId: a.targetSourceId });
      }
      if (a.targetSourceType === "BILTY") biltyIds.add(a.targetSourceId);
      if (a.targetSourceType === "CHALLAN") challanIds.add(a.targetSourceId);
    }
  }

  const [biltyRows, challanRows, phonchVehicleRows] = await Promise.all([
    biltyIds.size > 0
      ? prisma.bilty.findMany({
          where: { id: { in: [...biltyIds] } },
          select: { id: true, biltyNo: true, vehicleType: true, vehicleModel: true, chassisNumber: true },
        })
      : Promise.resolve([]),
    challanIds.size > 0
      ? prisma.challan.findMany({
          where: { id: { in: [...challanIds] } },
          select: {
            id: true,
            challanNo: true,
            carrierNumber: true,
            transporterParty: { select: { partyName: true } },
            bilties: {
              where: { bilty: { isDeleted: false } },
              select: { bilty: { select: { id: true, biltyNo: true, vehicleType: true, vehicleModel: true, chassisNumber: true } } },
            },
          },
        })
      : Promise.resolve([]),
    privatePhonchIds.size > 0
      ? prisma.privatePhonchVehicle.findMany({
          where: { phonchId: { in: [...privatePhonchIds] } },
          select: { phonchId: true, vehicleName: true },
        })
      : Promise.resolve([]),
  ]);

  const biltyById = new Map<string, BiltyCtx>(biltyRows.map((b) => [b.id, b]));
  const challanCtxById = new Map<string, ChallanCtx>();
  const challanSoleBiltyById = new Map<string, BiltyCtx | null>();
  for (const c of challanRows) {
    const bilties = c.bilties.map((cb) => cb.bilty).filter((b): b is NonNullable<typeof b> => !!b);
    const sole = bilties.length === 1 ? bilties[0] : null;
    if (sole) biltyById.set(sole.id, sole);
    challanCtxById.set(c.id, {
      id: c.id,
      challanNo: c.challanNo,
      carrierNumber: c.carrierNumber || null,
      transporterName: c.transporterParty?.partyName || null,
      soleBiltyId: sole?.id || null,
      soleBiltyNo: sole?.biltyNo || null,
      bilties,
    });
    challanSoleBiltyById.set(c.id, sole || null);
  }

  // Private Phonch vehicle names, live-loaded and grouped by phonchId -
  // display-only, used purely to append vehicle names to the already
  // pre-composed PRIVATE_PHONCH description below. Never invented:
  // only actual, non-null PrivatePhonchVehicle.vehicleName values.
  const phonchVehicleNamesById = new Map<string, string[]>();
  for (const v of phonchVehicleRows) {
    if (!v.vehicleName) continue;
    const arr = phonchVehicleNamesById.get(v.phonchId) || [];
    arr.push(v.vehicleName);
    phonchVehicleNamesById.set(v.phonchId, arr);
  }

  const rows: DisplayLedgerRow[] = [];

  // ----------------------------------------------------------
  // Grouped SettlementPayment rows (active + removed)
  // ----------------------------------------------------------
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket.lines].sort(
      (a, b) => a.entryDate.getTime() - b.entryDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime()
    );
    const net = round2(sorted.reduce((s, l) => s + l.debit - l.credit, 0));
    const debit = net > 0 ? Math.abs(net) : 0;
    const credit = net < 0 ? Math.abs(net) : 0;
    const history = sorted.map(toHistoryItem);
    const earliest = sorted[0];
    const latest = sorted[sorted.length - 1];

    if (bucket.payment) {
      const p = bucket.payment;
      let description: string;
      let reference: string;
      let referenceHref: string | null;
      let documentType: LedgerEntryType;

      if (p.component === "CARRIER_RENT" && p.challanId) {
        const challan = challanCtxById.get(p.challanId);
        reference = challan ? challanReference(challan.challanNo) : "Challan";
        referenceHref = `/challan/${p.challanId}`;
        description = challan
          ? challanDescription(challan, null, Math.abs(net), net >= 0 ? "Received" : "Paid")
          : `Carrier Rent, ${net >= 0 ? "Received" : "Paid"} ${formatRs(net)}`;
        documentType = "CHALLAN";
      } else if (p.biltyId) {
        const bilty = biltyById.get(p.biltyId);
        reference = bilty ? biltyReference(bilty.biltyNo) : "Bilty";
        referenceHref = `/bilty/${p.biltyId}`;
        // component "PAID" is the Bilty's own declared/document-level
        // Paid state (Bilty.advance) being established against the
        // resolved responsible party at booking time (see
        // app/api/bilty/route.ts's createSettlementPayment({component:
        // "PAID", ...}) call) - it is NEVER a verified cash receipt,
        // regardless of debit/credit sign (a later correction/reversal
        // of that same Paid establishment is still describing the Paid
        // state, not a cash "Received"). An actual cash receipt is
        // always a SEPARATE, plain DAILY_POSTING-tagged line, handled
        // by directionWord() in the standalone-lines loop below, which
        // this branch never touches. Every other Bilty-related
        // component (e.g. COLLECTION) keeps its existing sign-based
        // wording unchanged.
        const direction = p.component === "PAID" ? "Paid" : net >= 0 ? "Received" : "Paid";
        description = bilty
          ? biltyDescription(bilty, Math.abs(net), direction)
          : `Bilty, ${direction} ${formatRs(net)}`;
        documentType = "BILTY";
      } else {
        reference = "Settlement Payment";
        referenceHref = `/accounting-transactions/${earliest.journalEntryId}`;
        description = `${net >= 0 ? "Received" : "Paid"} ${formatRs(net)}`;
        documentType = "OTHER";
      }

      rows.push({
        id: `group:${key}`,
        date: earliest.entryDate.toISOString(),
        reference,
        referenceHref,
        description,
        debit,
        credit,
        isGrouped: history.length > 1,
        isRemoved: false,
        history,
        documentType,
        sortEntryDate: earliest.entryDate,
        sortCreatedAt: earliest.createdAt,
      });
    } else {
      // Removed (deleted) SettlementPayment - nets to ~0. Shown so
      // the audit trail is never silently lost, but never as an
      // active balance. sourceNumber (Bilty No or Challan No) is
      // always available on these lines; whether it's a Bilty or a
      // Challan is read from the entry's own already-persisted
      // description text (never guessed/invented) where that word
      // appears - a generic label is used when it doesn't.
      const sourceNumber = sorted.find((l) => l.sourceNumber)?.sourceNumber || null;
      const combinedText = sorted.map((l) => l.entryDescription || "").join(" ").toLowerCase();
      const documentLabel = sourceNumber
        ? combinedText.includes("bilty")
          ? biltyReference(sourceNumber)
          : combinedText.includes("challan")
            ? challanReference(sourceNumber)
            : sourceNumber
        : null;
      const removedDocumentType: LedgerEntryType = combinedText.includes("bilty")
        ? "BILTY"
        : combinedText.includes("challan")
          ? "CHALLAN"
          : "OTHER";
      rows.push({
        id: `group:${key}`,
        date: latest.entryDate.toISOString(),
        reference: documentLabel || "Settlement Payment",
        referenceHref: `/accounting-transactions/${latest.journalEntryId}`,
        description: documentLabel ? `${documentLabel}, Settlement payment removed` : "Settlement payment removed",
        debit,
        credit,
        isGrouped: true,
        isRemoved: true,
        history,
        documentType: removedDocumentType,
        sortEntryDate: latest.entryDate,
        sortCreatedAt: latest.createdAt,
      });
    }
  }

  // ----------------------------------------------------------
  // Standalone lines (everything not part of a SettlementPayment
  // group and not suppressed zero-net housekeeping noise)
  // ----------------------------------------------------------
  for (const line of remaining) {
    const debit = line.debit;
    const credit = line.credit;
    const amount = Math.abs(debit - credit) || Math.max(debit, credit);
    const direction = directionWord(line.referenceType, debit, credit);

    let reference: string;
    let referenceHref: string | null;
    let description: string;
    let documentType: LedgerEntryType;

    if (
      (line.referenceType === "SETTLEMENT" || line.referenceType === "SETTLEMENT_CORRECTION") &&
      line.sourceType === "BILTY" &&
      line.referenceId &&
      challanCtxById.has(line.referenceId) &&
      (line.lineDescription || line.entryDescription || "").includes("Carrier Rent")
    ) {
      // The OLD single-payer mechanism allocates Carrier Rent
      // PROPORTIONALLY per Bilty (see lib/settlement-accounting.ts) -
      // this line is tagged sourceType:"BILTY" at the line level, but
      // it is a Challan-driven transaction (Carrier No/Transporter
      // belong to the Challan, not the Bilty) and must be described
      // as such, not as a plain Bilty-only transaction. Detected via
      // the line's own already-persisted description text, never
      // guessed.
      const challan = challanCtxById.get(line.referenceId)!;
      const specificBilty = line.sourceId ? biltyById.get(line.sourceId) : null;
      reference = challanReference(challan.challanNo);
      referenceHref = `/challan/${line.referenceId}`;
      description = challanDescription(challan, specificBilty, amount, direction);
      documentType = "CHALLAN";
    } else if (line.sourceType === "BILTY" && line.sourceId && biltyById.has(line.sourceId)) {
      const bilty = biltyById.get(line.sourceId)!;
      reference = biltyReference(bilty.biltyNo);
      referenceHref = `/bilty/${line.sourceId}`;
      // Bilty Commission/Referral lines (see app/api/bilty/route.ts's
      // buildBiltyCommissionDescription()) are fully pre-composed once
      // at creation and stored directly as the line's own description -
      // exactly like Phonch's own "PHONCH" branch below does - so they
      // are passed through as-is rather than recomputed via
      // biltyDescription()'s generic Paid/Received wording, which does
      // not apply to an expense recognition. Detected via the line's
      // own already-persisted text, never guessed.
      const rawDescription = line.lineDescription || line.entryDescription || "";
      description = rawDescription.includes("bilty expense.")
        ? rawDescription
        : biltyDescription(bilty, amount, direction);
      documentType = "BILTY";
    } else if (line.sourceType === "CHALLAN" && line.sourceId && challanCtxById.has(line.sourceId)) {
      const challan = challanCtxById.get(line.sourceId)!;
      reference = challanReference(challan.challanNo);
      referenceHref = `/challan/${line.sourceId}`;
      description = challanDescription(challan, null, amount, direction);
      documentType = "CHALLAN";
    } else if (
      (line.referenceType === "BILTY_BOOKING" || line.referenceType === "BILTY_BOOKING_CORRECTION") &&
      line.referenceId &&
      biltyById.has(line.referenceId)
    ) {
      const bilty = biltyById.get(line.referenceId)!;
      reference = biltyReference(bilty.biltyNo);
      referenceHref = `/bilty/${line.referenceId}`;
      description = biltyDescription(bilty, amount, direction);
      documentType = "BILTY";
    } else if (
      (line.referenceType === "CHALLAN_DISPATCH" ||
        line.referenceType === "CHALLAN_DISPATCH_CORRECTION" ||
        line.referenceType === "SETTLEMENT" ||
        line.referenceType === "SETTLEMENT_CORRECTION") &&
      line.referenceId &&
      challanCtxById.has(line.referenceId)
    ) {
      const challan = challanCtxById.get(line.referenceId)!;
      reference = challanReference(challan.challanNo);
      referenceHref = `/challan/${line.referenceId}`;
      description = challanDescription(challan, null, amount, direction);
      documentType = "CHALLAN";
    } else if (line.referenceType === "DAILY_POSTING") {
      const alloc = allocationByLineId.get(line.id);
      if (alloc?.targetSourceType === "BILTY" && biltyById.has(alloc.targetSourceId)) {
        const bilty = biltyById.get(alloc.targetSourceId)!;
        reference = biltyReference(bilty.biltyNo);
        referenceHref = `/bilty/${alloc.targetSourceId}`;
        description = biltyDescription(bilty, amount, direction);
        documentType = "BILTY";
      } else if (alloc?.targetSourceType === "CHALLAN" && challanCtxById.has(alloc.targetSourceId)) {
        const challan = challanCtxById.get(alloc.targetSourceId)!;
        reference = challanReference(challan.challanNo);
        referenceHref = `/challan/${alloc.targetSourceId}`;
        description = challanDescription(challan, null, amount, direction);
        documentType = "CHALLAN";
      } else if (line.sourceType === "PRIVATE_PHONCH" && line.sourceId) {
        // Daily Posting receipts/payments against Private Phonch never
        // go through PaymentAllocation (AllocationTargetType is only
        // "BILTY"|"CHALLAN" - see prisma/schema.prisma) - only the
        // line's own sourceType/sourceId (set directly by
        // app/api/daily-posting/route.ts's buildLinePair()) identifies
        // the document. No live lookup/context map exists for this
        // (unlike Bilty/Challan), so the reference/href is built
        // directly from the line's own already-persisted fields,
        // exactly mirroring the PHONCH/BILL branches below.
        reference = "Private Phonch";
        referenceHref = `/private-phonch/${line.sourceId}`;
        description = appendPhonchVehicleNames(
          line.lineDescription || line.entryDescription || "—",
          line.sourceId,
          phonchVehicleNamesById
        );
        documentType = "PRIVATE_PHONCH";
      } else if (line.sourceType === "PHONCH" && line.sourceId) {
        reference = "Phonch";
        referenceHref = `/phonch/${line.sourceId}`;
        description = line.lineDescription || line.entryDescription || "—";
        documentType = "SHOWROOM_PHONCH";
      } else if (line.sourceType === "BILL" && line.sourceId) {
        reference = "Bill";
        referenceHref = `/bill/${line.sourceId}`;
        description = line.lineDescription || line.entryDescription || "—";
        documentType = "BILL";
      } else {
        reference = "Direct Entry";
        referenceHref = `/accounting-transactions/${line.journalEntryId}`;
        description = line.lineDescription || line.entryDescription || "—";
        documentType = "OTHER";
      }
    } else if (line.referenceType === "OPENING_BALANCE") {
      reference = "Opening Balance";
      referenceHref = null;
      description = line.lineDescription || line.entryDescription || "Opening Balance";
      documentType = "OTHER";
    } else if (line.referenceType === "PRIVATE_PHONCH" && line.referenceId) {
      // Private Phonch's own creation/settlement posting - the
      // description is fully pre-composed at creation time
      // (lib/private-phonch-accounting.ts) and stored directly as this
      // line's/entry's own description, exactly like Showroom Phonch's
      // own pattern just below. Previously had NO branch at all here,
      // so these lines fell through to the generic Direct-Entry
      // fallback with the wrong reference/link.
      reference = "Private Phonch";
      referenceHref = `/private-phonch/${line.referenceId}`;
      description = appendPhonchVehicleNames(
        line.lineDescription || line.entryDescription || "—",
        line.referenceId,
        phonchVehicleNamesById
      );
      documentType = "PRIVATE_PHONCH";
    } else if (line.referenceType === "PHONCH" && line.referenceId) {
      // Showroom Phonch / Delivery - the description is fully
      // pre-composed at creation time (lib/phonch-accounting.ts's
      // buildPhonchLedgerDescription()) and stored directly as this
      // line's/entry's own description, exactly like Manual Journal's
      // narration - no live Bilty/Challan lookup is needed here since
      // a Phonch's Bilty No./Challan No. are plain manual reference
      // text, not real relations (see the Phonch schema doc comment).
      reference = "Phonch";
      referenceHref = `/phonch/${line.referenceId}`;
      description = line.lineDescription || line.entryDescription || "—";
      documentType = "SHOWROOM_PHONCH";
    } else if (line.referenceType === "BILL" && line.referenceId) {
      // Bill Book - client-side receivable, fully independent of
      // Private/Showroom Phonch's own carrier-side accounting (see
      // model Bill's own doc comment in prisma/schema.prisma). The
      // description is fully pre-composed at creation time
      // (lib/bill-accounting.ts's buildBillLedgerDescription()) and
      // stored directly as this line's/entry's own description,
      // exactly like Phonch's own pattern just above - no live
      // lookup needed here.
      reference = "Bill";
      referenceHref = `/bill/${line.referenceId}`;
      description = line.lineDescription || line.entryDescription || "—";
      documentType = "BILL";
    } else if (line.referenceType === "MANUAL_JOURNAL") {
      // Manual Journal Entry (Step 15) - never document-linked (v1),
      // so this is always a Direct-Entry-style row. referenceId holds
      // the human-friendly, sequential Manual Journal Number (e.g.
      // "MJ-00001"), NOT a document id - see
      // app/api/journal-entries/route.ts for how it is assigned.
      reference = line.referenceId ? `Manual Journal ${line.referenceId}` : "Manual Journal Entry";
      referenceHref = `/accounting-transactions/${line.journalEntryId}`;
      description = line.lineDescription || line.entryDescription || "—";
      documentType = "OTHER";
    } else if (line.referenceType && SIMPLE_REFERENCE_LABELS[line.referenceType]) {
      reference = SIMPLE_REFERENCE_LABELS[line.referenceType];
      referenceHref = `/accounting-transactions/${line.journalEntryId}`;
      description = line.lineDescription || line.entryDescription || reference;
      documentType = "OTHER";
    } else {
      reference = line.referenceType || "Direct Entry";
      referenceHref = `/accounting-transactions/${line.journalEntryId}`;
      description = line.lineDescription || line.entryDescription || "—";
      documentType = "OTHER";
    }

    rows.push({
      id: line.id,
      date: line.entryDate.toISOString(),
      reference,
      referenceHref,
      description,
      debit,
      credit,
      isGrouped: false,
      isRemoved: false,
      history: [toHistoryItem(line)],
      documentType,
      sortEntryDate: line.entryDate,
      sortCreatedAt: line.createdAt,
    });
  }

  // Chronological (oldest -> newest), using compareChronological()
  // (calendar day, then actual posting time as a same-day tiebreak,
  // then id) as the SINGLE ordering definition for this whole ledger -
  // the same definition getAccountLedgerData() below then also uses,
  // unmodified, to accumulate the running balance. This is what fixes
  // a same-day Daily Posting receipt (entryDate flattened to local
  // midnight, so it always LOOKS earliest-of-the-day) sorting ahead of
  // a same-day Bilty/Challan transaction that was actually posted
  // first: entryDate alone can't tell them apart correctly, but
  // createdAt can. Never reorders or changes any stored JournalLine;
  // this only decides the row sequence returned to the caller.
  rows.sort(compareChronological);
  return rows;
}

// ============================================================
// SHARED DATA FETCH (screen JSON + PDF + Excel export all use this
// SAME function) - a single, read-only source of truth for "what is
// this party's ledger", so the three surfaces can never drift from
// each other. Never writes anything; opening the ledger page,
// downloading the PDF, or downloading the Excel/CSV export all run
// the exact same read-only queries.
// ============================================================

export type PartyLedgerErrorCode = "PARTY_NOT_FOUND" | "NO_ACCOUNT";

export class PartyLedgerLookupError extends Error {
  code: PartyLedgerErrorCode;
  constructor(code: PartyLedgerErrorCode, message: string) {
    super(message);
    this.name = "PartyLedgerLookupError";
    this.code = code;
  }
}

export interface FinalLedgerRow {
  id: string;
  date: string;
  reference: string;
  referenceHref: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
  isGrouped: boolean;
  isRemoved: boolean;
  history: DisplayHistoryItem[];
  documentType: LedgerEntryType;
}

export interface AccountLedgerOptions {
  from?: string | null;
  to?: string | null;
  /**
   * Display order for the returned `ledger` array ONLY.
   *
   * "asc" (chronological, oldest -> newest) - the client-facing
   * Party Summary / Account Statement (PDF/Excel export): a formal
   * statement always reads Opening Balance -> oldest -> newest ->
   * Totals -> Closing Balance.
   *
   * "desc" (newest -> oldest) - the normal browser ledger screen,
   * matching every other normal ERP list/ledger screen.
   *
   * The running balance is ALWAYS computed chronologically first,
   * regardless of this option - each row's own `balance` field is
   * the true balance as of that transaction, and is completely
   * unaffected by which order the finished array is handed back
   * in. This option only decides the ORDER of the finished rows,
   * exactly like the task's own "calculate forward, only reverse
   * for display" instruction.
   */
  order?: "asc" | "desc";
  /**
   * Restrict the returned ledger to a single document type - reusing
   * each row's own already-classified `documentType` (see
   * LedgerEntryType above), never a second/different classification
   * pass. `null`/omitted = "All" (existing, fully unfiltered
   * behavior - byte-for-byte unchanged).
   *
   * When set, Opening/Running/Closing balance and Period Debit/Credit
   * are recomputed from ONLY this type's own rows (still calculated
   * chronologically first, exactly like the unfiltered path, and only
   * reversed for display afterward per `order` - see
   * buildTypeFilteredLedger() below). This is a deliberately
   * DIFFERENT, self-contained balance - it answers "what does this
   * document type alone owe/is owed", not a slice of the account's
   * real overall balance - and must never be confused with or mixed
   * into the real (unfiltered) account balance shown elsewhere.
   */
  documentType?: LedgerEntryType | null;
}

export interface AccountLedgerData {
  account: { id: string; accountName: string };
  filters: { from: string | null; to: string | null; documentType: LedgerEntryType | null };
  summary: {
    openingBalance: number;
    periodDebit: number;
    periodCredit: number;
    closingBalance: number;
    balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
  };
  ledger: FinalLedgerRow[];
}

export interface PartyLedgerData extends AccountLedgerData {
  party: { id: string; partyName: string; partyTypes: string[] };
}

function classifyBalance(value: number): "RECEIVABLE" | "PAYABLE" | "SETTLED" {
  if (value > 0.009) return "RECEIVABLE";
  if (value < -0.009) return "PAYABLE";
  return "SETTLED";
}

// ============================================================
// ACCOUNT-GENERIC CORE (used by General Ledger for ANY account -
// system/Gross accounts, Cash/Bank, Party, or any user-created
// account - and reused BELOW by getPartyLedgerData() so the Party
// Ledger screen/PDF/Excel trio keeps running through the exact same
// code it always has, byte-for-byte, just via this shared function
// instead of a private copy of it). buildUserFacingLedgerRows() was
// already account-agnostic - only the surrounding opening-balance/
// running-balance/party-lookup logic was previously duplicated
// per-caller; this is the single extraction of that logic, not a
// new calculation.
// ============================================================

export async function getAccountLedgerData(
  accountId: string,
  options: AccountLedgerOptions
): Promise<AccountLedgerData> {
  const from = options.from || null;
  const to = options.to || null;
  const order = options.order || "asc";
  const documentType = options.documentType || null;

  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, accountName: true } });
  if (!account) {
    throw new PartyLedgerLookupError("NO_ACCOUNT", "Account not found.");
  }

  const dateFilter: { gte?: Date; lt?: Date } = {};
  if (from) {
    const start = new Date(`${from}T00:00:00`);
    if (!Number.isNaN(start.getTime())) dateFilter.gte = start;
  }
  if (to) {
    const end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    if (!Number.isNaN(end.getTime())) dateFilter.lt = end;
  }

  const entries = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      journalEntry: { is: { isDeleted: false, ...(Object.keys(dateFilter).length > 0 ? { entryDate: dateFilter } : {}) } },
    },
    include: {
      journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true, description: true } },
    },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  const rawLines: RawLedgerLine[] = entries.map((entry) => ({
    id: entry.id,
    journalEntryId: entry.journalEntryId,
    entryDate: entry.journalEntry.entryDate,
    createdAt: entry.createdAt,
    referenceType: entry.journalEntry.referenceType,
    referenceId: entry.journalEntry.referenceId,
    entryDescription: entry.journalEntry.description,
    lineDescription: entry.description,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    sourceNumber: entry.sourceNumber,
    debit: Number(entry.debit),
    credit: Number(entry.credit),
  }));

  const displayRowsAll = await buildUserFacingLedgerRows(account.id, rawLines);

  // Type filter is applied AFTER classification, against each row's
  // own already-resolved `documentType` (see LedgerEntryType above) -
  // never a second/different type-detection pass, per the single-
  // centralized-classifier rule.
  const displayRows = documentType ? displayRowsAll.filter((row) => row.documentType === documentType) : displayRowsAll;

  let periodDebit: number;
  let periodCredit: number;
  let openingBalance = 0;

  if (documentType) {
    // Type-filtered summary: Opening/Period/Closing balance are a
    // deliberately SEPARATE, self-contained calculation scoped to
    // only this document type's own rows - computed chronologically
    // first (the SAME displayRows order buildUserFacingLedgerRows()
    // already returns), then only reversed for display below per
    // `order`. Never derived by slicing/adjusting the real unfiltered
    // account balance.
    periodDebit = displayRows.reduce((sum, row) => sum + row.debit, 0);
    periodCredit = displayRows.reduce((sum, row) => sum + row.credit, 0);

    if (from) {
      const openingEntries = await prisma.journalLine.findMany({
        where: {
          accountId: account.id,
          journalEntry: { is: { isDeleted: false, entryDate: { lt: new Date(`${from}T00:00:00`) } } },
        },
        include: {
          journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true, description: true } },
        },
        orderBy: { journalEntry: { entryDate: "asc" } },
      });
      const openingRawLines: RawLedgerLine[] = openingEntries.map((entry) => ({
        id: entry.id,
        journalEntryId: entry.journalEntryId,
        entryDate: entry.journalEntry.entryDate,
        createdAt: entry.createdAt,
        referenceType: entry.journalEntry.referenceType,
        referenceId: entry.journalEntry.referenceId,
        entryDescription: entry.journalEntry.description,
        lineDescription: entry.description,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        sourceNumber: entry.sourceNumber,
        debit: Number(entry.debit),
        credit: Number(entry.credit),
      }));
      const openingDisplayRows = await buildUserFacingLedgerRows(account.id, openingRawLines);
      openingBalance = openingDisplayRows
        .filter((row) => row.documentType === documentType)
        .reduce((sum, row) => sum + row.debit - row.credit, 0);
    }
  } else {
    // Unfiltered ("All") path - byte-for-byte the original
    // calculation (raw JournalLine sums, never the grouped/display
    // rows), untouched.
    periodDebit = entries.reduce((sum, entry) => sum + Number(entry.debit), 0);
    periodCredit = entries.reduce((sum, entry) => sum + Number(entry.credit), 0);

    if (from) {
      const openingEntries = await prisma.journalLine.findMany({
        where: {
          accountId: account.id,
          journalEntry: { is: { isDeleted: false, entryDate: { lt: new Date(`${from}T00:00:00`) } } },
        },
        select: { debit: true, credit: true },
      });
      openingBalance = openingEntries.reduce((sum, entry) => sum + Number(entry.debit) - Number(entry.credit), 0);
    }
  }

  const netBalance = periodDebit - periodCredit;
  const closingBalance = openingBalance + netBalance;

  let displayRunningBalance = openingBalance;
  const ledger: FinalLedgerRow[] = displayRows.map((row) => {
    displayRunningBalance += row.debit - row.credit;
    return {
      id: row.id,
      date: row.date,
      reference: row.reference,
      referenceHref: row.referenceHref,
      description: row.description,
      debit: row.debit,
      credit: row.credit,
      balance: Math.abs(displayRunningBalance),
      balanceType: classifyBalance(displayRunningBalance),
      isGrouped: row.isGrouped,
      isRemoved: row.isRemoved,
      history: row.history,
      documentType: row.documentType,
    };
  });

  // Chronological (asc) is the calculation order above - it must
  // stay that way for the running balance to be correct. Reversing
  // AFTER the fact only changes which order the finished rows are
  // handed back in; each row's own `balance` already reflects the
  // true balance as of that transaction and needs no recomputation.
  const orderedLedger = order === "desc" ? [...ledger].reverse() : ledger;

  return {
    account: { id: account.id, accountName: account.accountName },
    filters: { from, to, documentType },
    summary: {
      openingBalance,
      periodDebit,
      periodCredit,
      closingBalance,
      balanceType: classifyBalance(closingBalance),
    },
    ledger: orderedLedger,
  };
}

// ============================================================
// TRANSACTION SEARCH (shared by every ledger screen)
//
// Filters an already-built, already-business-described ledger row
// list - never the raw JournalLine table, and never re-queries the
// database. Matches against the row's own composed `reference` +
// `description` (which already embeds Bilty No/Challan No/Carrier
// No/Transporter/Party name wherever buildUserFacingLedgerRows()
// resolved that context - see biltyDescription()/challanDescription()
// above) plus every underlying raw entry in `history`, so a search
// term still finds a row even when it was collapsed/consolidated
// from several technical JournalEntries.
//
// Deliberately does NOT touch summary.openingBalance/periodDebit/
// periodCredit/closingBalance, and does NOT recompute any row's own
// `balance` - a search only narrows which rows are DISPLAYED; the
// account's real opening/closing/running balance stays exactly what
// it was for the full (unfiltered) selected date range, per the
// explicit "search must not distort the accounting balance" rule.
// ============================================================
export function filterLedgerRowsBySearch<T extends { reference: string; description: string; history: DisplayHistoryItem[] }>(
  rows: T[],
  search: string | null | undefined
): T[] {
  const q = (search || "").trim().toLowerCase();
  if (!q) return rows;

  return rows.filter((row) => {
    if (row.reference.toLowerCase().includes(q)) return true;
    if (row.description.toLowerCase().includes(q)) return true;
    return row.history.some((h) => h.description.toLowerCase().includes(q));
  });
}

export async function getPartyLedgerData(partyId: string, options: AccountLedgerOptions): Promise<PartyLedgerData> {
  const party = await prisma.party.findUnique({ where: { id: partyId }, include: { account: true } });
  if (!party) {
    throw new PartyLedgerLookupError("PARTY_NOT_FOUND", "Party not found");
  }
  if (!party.account) {
    throw new PartyLedgerLookupError("NO_ACCOUNT", "This party does not have an account yet.");
  }

  const data = await getAccountLedgerData(party.account.id, options);

  return {
    party: { id: party.id, partyName: party.partyName, partyTypes: party.partyTypes },
    ...data,
  };
}
