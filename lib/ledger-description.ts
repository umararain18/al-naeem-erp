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
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
};

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
}

function vehicleLabel(bilty: BiltyCtx | undefined | null): string | null {
  if (!bilty) return null;
  return bilty.vehicleModel || bilty.vehicleType || null;
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
  // has exactly one Bilty and no specific one was identified).
  relevantBilty: BiltyCtx | undefined | null,
  amount: number,
  direction: "Received" | "Paid"
): string {
  const parts: string[] = [challanReference(challan.challanNo)];
  const biltyNoText = relevantBilty?.biltyNo || challan.soleBiltyNo;
  if (biltyNoText) parts.push(biltyReference(biltyNoText));
  if (challan.carrierNumber) parts.push(`Carrier No ${challan.carrierNumber}`);
  if (challan.transporterName) parts.push(`Transporter ${challan.transporterName}`);
  const veh = vehicleLabel(relevantBilty);
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
      const key = `hk:${line.sourceType}:${line.sourceId}`;
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
    referenceType: line.referenceType,
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

  for (const bucket of buckets.values()) {
    if (bucket.payment?.biltyId) biltyIds.add(bucket.payment.biltyId);
    if (bucket.payment?.challanId) challanIds.add(bucket.payment.challanId);
  }
  for (const line of remaining) {
    if (line.sourceType === "BILTY" && line.sourceId) biltyIds.add(line.sourceId);
    if (line.sourceType === "CHALLAN" && line.sourceId) challanIds.add(line.sourceId);
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

  const [biltyRows, challanRows] = await Promise.all([
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
    });
    challanSoleBiltyById.set(c.id, sole || null);
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

      if (p.component === "CARRIER_RENT" && p.challanId) {
        const challan = challanCtxById.get(p.challanId);
        const veh = challan?.soleBiltyId ? biltyById.get(challan.soleBiltyId) : null;
        reference = challan ? challanReference(challan.challanNo) : "Challan";
        referenceHref = `/challan/${p.challanId}`;
        description = challan
          ? challanDescription(challan, veh, Math.abs(net), net >= 0 ? "Received" : "Paid")
          : `Carrier Rent, ${net >= 0 ? "Received" : "Paid"} ${formatRs(net)}`;
      } else if (p.biltyId) {
        const bilty = biltyById.get(p.biltyId);
        reference = bilty ? biltyReference(bilty.biltyNo) : "Bilty";
        referenceHref = `/bilty/${p.biltyId}`;
        description = bilty
          ? biltyDescription(bilty, Math.abs(net), net >= 0 ? "Received" : "Paid")
          : `Bilty, ${net >= 0 ? "Received" : "Paid"} ${formatRs(net)}`;
      } else {
        reference = "Settlement Payment";
        referenceHref = `/accounting-transactions/${earliest.journalEntryId}`;
        description = `${net >= 0 ? "Received" : "Paid"} ${formatRs(net)}`;
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
    } else if (line.sourceType === "BILTY" && line.sourceId && biltyById.has(line.sourceId)) {
      const bilty = biltyById.get(line.sourceId)!;
      reference = biltyReference(bilty.biltyNo);
      referenceHref = `/bilty/${line.sourceId}`;
      description = biltyDescription(bilty, amount, direction);
    } else if (line.sourceType === "CHALLAN" && line.sourceId && challanCtxById.has(line.sourceId)) {
      const challan = challanCtxById.get(line.sourceId)!;
      const veh = challan.soleBiltyId ? biltyById.get(challan.soleBiltyId) : null;
      reference = challanReference(challan.challanNo);
      referenceHref = `/challan/${line.sourceId}`;
      description = challanDescription(challan, veh, amount, direction);
    } else if (
      (line.referenceType === "BILTY_BOOKING" || line.referenceType === "BILTY_BOOKING_CORRECTION") &&
      line.referenceId &&
      biltyById.has(line.referenceId)
    ) {
      const bilty = biltyById.get(line.referenceId)!;
      reference = biltyReference(bilty.biltyNo);
      referenceHref = `/bilty/${line.referenceId}`;
      description = biltyDescription(bilty, amount, direction);
    } else if (
      (line.referenceType === "CHALLAN_DISPATCH" ||
        line.referenceType === "CHALLAN_DISPATCH_CORRECTION" ||
        line.referenceType === "SETTLEMENT" ||
        line.referenceType === "SETTLEMENT_CORRECTION") &&
      line.referenceId &&
      challanCtxById.has(line.referenceId)
    ) {
      const challan = challanCtxById.get(line.referenceId)!;
      const veh = challan.soleBiltyId ? biltyById.get(challan.soleBiltyId) : null;
      reference = challanReference(challan.challanNo);
      referenceHref = `/challan/${line.referenceId}`;
      description = challanDescription(challan, veh, amount, direction);
    } else if (line.referenceType === "DAILY_POSTING") {
      const alloc = allocationByLineId.get(line.id);
      if (alloc?.targetSourceType === "BILTY" && biltyById.has(alloc.targetSourceId)) {
        const bilty = biltyById.get(alloc.targetSourceId)!;
        reference = biltyReference(bilty.biltyNo);
        referenceHref = `/bilty/${alloc.targetSourceId}`;
        description = biltyDescription(bilty, amount, direction);
      } else if (alloc?.targetSourceType === "CHALLAN" && challanCtxById.has(alloc.targetSourceId)) {
        const challan = challanCtxById.get(alloc.targetSourceId)!;
        const veh = challan.soleBiltyId ? biltyById.get(challan.soleBiltyId) : null;
        reference = challanReference(challan.challanNo);
        referenceHref = `/challan/${alloc.targetSourceId}`;
        description = challanDescription(challan, veh, amount, direction);
      } else {
        reference = "Direct Entry";
        referenceHref = `/accounting-transactions/${line.journalEntryId}`;
        description = line.lineDescription || line.entryDescription || "—";
      }
    } else if (line.referenceType === "OPENING_BALANCE") {
      reference = "Opening Balance";
      referenceHref = null;
      description = line.lineDescription || line.entryDescription || "Opening Balance";
    } else if (line.referenceType && SIMPLE_REFERENCE_LABELS[line.referenceType]) {
      reference = SIMPLE_REFERENCE_LABELS[line.referenceType];
      referenceHref = `/accounting-transactions/${line.journalEntryId}`;
      description = line.lineDescription || line.entryDescription || reference;
    } else {
      reference = line.referenceType || "Direct Entry";
      referenceHref = `/accounting-transactions/${line.journalEntryId}`;
      description = line.lineDescription || line.entryDescription || "—";
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
    });
  }

  // Chronological, and explicitly deterministic on a tie: sort by
  // date first, then by each row's own construction order (itself
  // derived from the database's entryDate:"asc" ordering) as an
  // explicit secondary key - never left to rely only on the sort
  // algorithm's stability guarantee. Never reorders or changes any
  // stored JournalLine; this only decides the DISPLAY sequence.
  const withOrder = rows.map((row, index) => ({ row, index }));
  withOrder.sort((a, b) => {
    const dateDiff = new Date(a.row.date).getTime() - new Date(b.row.date).getTime();
    if (dateDiff !== 0) return dateDiff;
    return a.index - b.index;
  });
  return withOrder.map((w) => w.row);
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
}

export interface PartyLedgerData {
  party: { id: string; partyName: string; partyTypes: string[] };
  account: { id: string; accountName: string };
  filters: { from: string | null; to: string | null };
  summary: {
    openingBalance: number;
    periodDebit: number;
    periodCredit: number;
    closingBalance: number;
    balanceType: "RECEIVABLE" | "PAYABLE" | "SETTLED";
  };
  ledger: FinalLedgerRow[];
}

function classifyBalance(value: number): "RECEIVABLE" | "PAYABLE" | "SETTLED" {
  if (value > 0.009) return "RECEIVABLE";
  if (value < -0.009) return "PAYABLE";
  return "SETTLED";
}

export async function getPartyLedgerData(
  partyId: string,
  options: {
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
     * "desc" (newest -> oldest) - the normal browser Party Ledger
     * screen, matching every other normal ERP list/ledger screen.
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
  }
): Promise<PartyLedgerData> {
  const from = options.from || null;
  const to = options.to || null;
  const order = options.order || "asc";

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

  const party = await prisma.party.findUnique({ where: { id: partyId }, include: { account: true } });
  if (!party) {
    throw new PartyLedgerLookupError("PARTY_NOT_FOUND", "Party not found");
  }
  if (!party.account) {
    throw new PartyLedgerLookupError("NO_ACCOUNT", "This party does not have an account yet.");
  }

  const entries = await prisma.journalLine.findMany({
    where: {
      accountId: party.account.id,
      journalEntry: { is: { isDeleted: false, ...(Object.keys(dateFilter).length > 0 ? { entryDate: dateFilter } : {}) } },
    },
    include: {
      journalEntry: { select: { id: true, entryDate: true, referenceType: true, referenceId: true, description: true } },
    },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  const periodDebit = entries.reduce((sum, entry) => sum + Number(entry.debit), 0);
  const periodCredit = entries.reduce((sum, entry) => sum + Number(entry.credit), 0);
  const netBalance = periodDebit - periodCredit;

  let openingBalance = 0;
  if (from) {
    const openingEntries = await prisma.journalLine.findMany({
      where: {
        accountId: party.account.id,
        journalEntry: { is: { isDeleted: false, entryDate: { lt: new Date(`${from}T00:00:00`) } } },
      },
      select: { debit: true, credit: true },
    });
    openingBalance = openingEntries.reduce((sum, entry) => sum + Number(entry.debit) - Number(entry.credit), 0);
  }

  const closingBalance = openingBalance + netBalance;

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

  const displayRows = await buildUserFacingLedgerRows(party.account.id, rawLines);

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
    };
  });

  // Chronological (asc) is the calculation order above - it must
  // stay that way for the running balance to be correct. Reversing
  // AFTER the fact only changes which order the finished rows are
  // handed back in; each row's own `balance` already reflects the
  // true balance as of that transaction and needs no recomputation.
  const orderedLedger = order === "desc" ? [...ledger].reverse() : ledger;

  return {
    party: { id: party.id, partyName: party.partyName, partyTypes: party.partyTypes },
    account: { id: party.account.id, accountName: party.account.accountName },
    filters: { from, to },
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
