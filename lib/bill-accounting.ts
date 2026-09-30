import type { Prisma, PrismaClient } from "@prisma/client";
import { findBillWalkInReceivableAccountId } from "./gross-accounts";

// ============================================================
// BILL BOOK - accounting + validation
//
// Mirrors lib/phonch-accounting.ts's own two proven mechanisms
// exactly (Bill is single-client/single-"received", same shape as
// Showroom Phonch's single-Transporter/single-"received"):
//
//  1. Input validation/total computation - same shape as
//     resolvePhonchInput().
//  2. "Received" derivation - same shape as getPhonchPaymentState():
//     a PURE READ, derived every time from Daily Posting receipts
//     tagged sourceType "BILL", sourceId = this Bill's id, filtered to
//     the Client Party's own accountId. No "received" value is ever
//     stored on the Bill itself.
//
// See prisma/schema.prisma's own model Bill doc comment for why
// Bill's accounting is a NEW, independent client-side transaction -
// never a duplicate of Private/Showroom Phonch's own carrier-side
// accounting, which this file never reads or touches.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.009;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class BillValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BillValidationError";
    this.status = status;
  }
}

export class BillAccountingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BillAccountingError";
    this.code = code;
  }
}

// ------------------------------------------------------------
// INPUT SHAPE
// ------------------------------------------------------------

export type BillSourceTypeValue = "PRIVATE_PHONCH" | "SHOWROOM_PHONCH";

export interface BillItemSourceInput {
  sourceType: BillSourceTypeValue;
  privatePhonchVehicleId?: string;
  phonchVehicleId?: string;
}

export interface BillItemInput {
  vehicleName?: string;
  fromText?: string;
  toText?: string;
  engineNumber?: string;
  chassisNumber?: string;
  regdNumber?: string;
  rent?: number;
  delivery?: number;
  otherExpense?: number;
  source?: BillItemSourceInput;
}

export interface BillInput {
  billNo: string;
  date: string;
  clientPartyId?: string;
  clientName: string;
  clientPhone?: string;
  items: BillItemInput[];
}

/**
 * Resolves the effective Account a Bill's client-side accounting/
 * payment-state should be filtered against for a READ (list/detail/
 * PDF/Daily Posting search/reverse Bill link) - the selected existing
 * Party's own Account when one was chosen, or the shared Walk-in
 * Customers system account when this Bill's client is a random/one-
 * time name (clientPartyId null - see model Bill's own doc comment in
 * prisma/schema.prisma). Read-only: never creates the shared account
 * itself (see findBillWalkInReceivableAccountId()'s own doc comment)
 * - returns null only in the practically-impossible case where a
 * walk-in Bill exists but its own shared account has somehow never
 * been created, exactly mirroring the existing "no account yet"
 * fallback every caller already had before this account existed.
 */
export async function resolveBillClientAccountId(
  tx: Tx,
  clientParty: { account: { id: string } | null } | null
): Promise<string | null> {
  if (clientParty?.account?.id) return clientParty.account.id;
  return findBillWalkInReceivableAccountId(tx);
}

export interface ResolvedBillItem {
  lineNo: number;
  vehicleName: string | null;
  fromText: string | null;
  toText: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  regdNumber: string | null;
  rent: number;
  delivery: number;
  otherExpense: number;
  // Derived, never independently stored - see BillItem's own doc
  // comment in prisma/schema.prisma.
  total: number;
  source: BillItemSourceInput | null;
}

export interface ResolvedBill {
  billNo: string;
  date: Date;
  clientName: string;
  clientPhone: string | null;
  items: ResolvedBillItem[];
  // Locked to whichever source type the FIRST sourced item uses - null
  // when every item is a Manual row (no source at all). Enforced never
  // to mix within one Bill (Section 3 of the spec).
  sourceType: BillSourceTypeValue | null;
  total: number;
}

/**
 * Validates + normalizes a Bill create/edit payload and computes its
 * total. Throws BillValidationError on the first violation - never
 * silently drops/clamps an invalid line. Mirrors resolvePhonchInput()'s
 * own shape exactly.
 *
 * Enforces the LOCKED "one Bill = one source type" rule (Section 3):
 * every item's own source.sourceType, if present, must be identical -
 * mixing PRIVATE_PHONCH and SHOWROOM_PHONCH items on the same Bill is
 * rejected here, before any database write.
 */
export function resolveBillInput(data: BillInput): ResolvedBill {
  if (!data.billNo || !data.billNo.trim()) {
    throw new BillValidationError("Bill No. is required");
  }

  if (!data.date || Number.isNaN(new Date(`${data.date}T00:00:00`).getTime())) {
    throw new BillValidationError("A valid Date is required");
  }

  if (!data.clientName || !data.clientName.trim()) {
    throw new BillValidationError("Client Name is required");
  }

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new BillValidationError("At least one vehicle row is required");
  }

  let total = 0;
  let sourceType: BillSourceTypeValue | null = null;

  const items: ResolvedBillItem[] = data.items.map((item, index) => {
    const label = `Vehicle line ${index + 1}`;

    const rent = round2(Number(item.rent) || 0);
    if (rent < 0) throw new BillValidationError(`${label}: Rent cannot be negative`);

    const delivery = round2(Number(item.delivery) || 0);
    if (delivery < 0) throw new BillValidationError(`${label}: Delivery cannot be negative`);

    const otherExpense = round2(Number(item.otherExpense) || 0);
    if (otherExpense < 0) throw new BillValidationError(`${label}: Other Expense cannot be negative`);

    const rowTotal = round2(rent + delivery + otherExpense);

    let source: BillItemSourceInput | null = null;
    if (item.source) {
      const st = item.source.sourceType;
      if (st !== "PRIVATE_PHONCH" && st !== "SHOWROOM_PHONCH") {
        throw new BillValidationError(`${label}: Invalid source type`);
      }
      if (st === "PRIVATE_PHONCH" && !item.source.privatePhonchVehicleId) {
        throw new BillValidationError(`${label}: A Private Phonch vehicle must be selected`);
      }
      if (st === "SHOWROOM_PHONCH" && !item.source.phonchVehicleId) {
        throw new BillValidationError(`${label}: A Showroom Phonch vehicle must be selected`);
      }
      if (sourceType === null) {
        sourceType = st;
      } else if (sourceType !== st) {
        throw new BillValidationError(
          "A Bill cannot mix Private Phonch and Showroom Phonch source vehicles. Use one source type per Bill."
        );
      }
      source = {
        sourceType: st,
        privatePhonchVehicleId: st === "PRIVATE_PHONCH" ? item.source.privatePhonchVehicleId : undefined,
        phonchVehicleId: st === "SHOWROOM_PHONCH" ? item.source.phonchVehicleId : undefined,
      };
    }

    total = round2(total + rowTotal);

    return {
      lineNo: index + 1,
      vehicleName: item.vehicleName?.trim() || null,
      fromText: item.fromText?.trim() || null,
      toText: item.toText?.trim() || null,
      engineNumber: item.engineNumber?.trim() || null,
      chassisNumber: item.chassisNumber?.trim() || null,
      regdNumber: item.regdNumber?.trim() || null,
      rent,
      delivery,
      otherExpense,
      total: rowTotal,
      source,
    };
  });

  if (total <= 0) {
    throw new BillValidationError("Bill Total must be greater than zero");
  }

  return {
    billNo: data.billNo.trim(),
    date: new Date(`${data.date}T00:00:00`),
    clientName: data.clientName.trim(),
    clientPhone: data.clientPhone?.trim() || null,
    items,
    sourceType,
    total,
  };
}

// ------------------------------------------------------------
// LEDGER DESCRIPTION - business-readable, mirrors
// buildPhonchLedgerDescription()'s own shape.
// ------------------------------------------------------------

function formatRs(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export function buildBillLedgerDescription(bill: { billNo: string }, items: ResolvedBillItem[], total: number): string {
  const vehicleNames = items.map((i) => i.vehicleName).filter((n): n is string => !!n);
  const parts: string[] = [`Bill ${bill.billNo}`];

  if (vehicleNames.length === 1) {
    parts.push(vehicleNames[0]);
    const single = items[0];
    if (single.fromText && single.toText) {
      parts.push(`${single.fromText} → ${single.toText}`);
    } else if (single.fromText) {
      parts.push(single.fromText);
    }
    if (single.rent > 0) parts.push(`Rent ${formatRs(single.rent)}`);
    if (single.delivery > 0) parts.push(`Delivery ${formatRs(single.delivery)}`);
    if (single.otherExpense > 0) parts.push(`Other Expense ${formatRs(single.otherExpense)}`);
  } else if (vehicleNames.length > 1) {
    parts.push(vehicleNames.join(", "));
    parts.push(`Bill Amount ${formatRs(total)}`);
  } else {
    parts.push(`Bill Amount ${formatRs(total)}`);
  }

  return parts.join(", ");
}

// ------------------------------------------------------------
// "RECEIVED" DERIVATION - exact same shape as getPhonchPaymentState().
// ------------------------------------------------------------

export interface BillPaymentState {
  billId: string;
  totalAmount: number;
  receivedAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID";
}

export async function getBillPaymentState(
  tx: Tx,
  billId: string,
  clientAccountId: string,
  totalAmount: number,
  // Set only when EDITING an existing Daily Posting receipt against
  // the SAME Bill, so that row's own prior amount is not double-
  // counted against itself before the new amount is checked.
  excludeJournalEntryId?: string
): Promise<BillPaymentState> {
  const lines = await tx.journalLine.findMany({
    where: {
      // CRITICAL: filtered to the Client Party's OWN accountId, never
      // just sourceType+sourceId alone - the exact bug class flagged
      // in this task's own spec (Showroom Phonch's list bug): a Daily
      // Posting's main Cash/Bank line is tagged with this SAME
      // sourceId too (see buildLinePair() in
      // app/api/daily-posting/route.ts), so summing every line for
      // this sourceId regardless of account would silently cancel the
      // Bank's debit against the Client's credit and always yield 0.
      accountId: clientAccountId,
      sourceType: "BILL",
      sourceId: billId,
      journalEntry: {
        referenceType: "DAILY_POSTING",
        isDeleted: false,
        ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
      },
    },
    select: { debit: true, credit: true },
  });

  // Client Party account CREDIT = money they paid ANC (their
  // receivable balance decreases) - the same direction convention
  // getPhonchPaymentState() already uses for its own Transporter
  // receivable.
  const receivedAmount = Math.max(0, round2(lines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)));

  const isInconsistent = receivedAmount > totalAmount + EPS;
  const remainingDue = isInconsistent ? 0 : Math.max(0, round2(totalAmount - receivedAmount));

  let status: "UNPAID" | "PARTIALLY_PAID" | "PAID";
  if (!isInconsistent && remainingDue <= EPS) status = "PAID";
  else if (receivedAmount > EPS) status = "PARTIALLY_PAID";
  else status = "UNPAID";

  return {
    billId,
    totalAmount,
    receivedAmount,
    remainingDue,
    isInconsistent,
    status,
  };
}

/**
 * Validates that a NEW Daily Posting receipt of `amount` credited
 * against `billId`'s Client Party would not exceed the Bill's own
 * Total. Mirrors assertPhonchReceiptNotExceeded()'s own shape exactly,
 * including computing the Bill's own Total fresh from `tx` (never
 * trusting a caller-supplied figure that could be stale).
 */
export async function assertBillReceiptNotExceeded(
  tx: Tx,
  billId: string,
  counterAccountId: string,
  amount: number,
  direction: "DEBIT" | "CREDIT",
  excludeJournalEntryId?: string
): Promise<void> {
  // direction is the MAIN account's own direction, per Daily Posting's
  // existing convention - DEBIT means the main account (Cash/Bank)
  // receives money, crediting the counter (Client) account - i.e. a
  // receipt from them. Only that shape can verify.
  if (direction !== "DEBIT") return;

  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: { items: { select: { rent: true, delivery: true, otherExpense: true } } },
  });
  const totalAmount = round2(
    (bill?.items || []).reduce((s, i) => s + Number(i.rent) + Number(i.delivery) + Number(i.otherExpense), 0)
  );

  const state = await getBillPaymentState(tx, billId, counterAccountId, totalAmount, excludeJournalEntryId);

  if (state.isInconsistent) {
    throw new BillAccountingError(
      "BILL_RECEIPT_INCONSISTENT",
      `This Bill's received amount (${state.receivedAmount}) already exceeds its Total (${state.totalAmount}) - a data inconsistency. Resolve this before posting further receipts.`
    );
  }

  if (round2(state.receivedAmount + amount) > state.totalAmount + EPS) {
    throw new BillAccountingError(
      "BILL_OVER_RECEIPT",
      `This receipt of ${round2(amount)} would exceed this Bill's remaining due (${state.remainingDue}). Total = ${state.totalAmount}, already received = ${state.receivedAmount}.`
    );
  }
}

// ------------------------------------------------------------
// EDIT-TIME "NOT BELOW ALREADY RECEIVED" CHECK - mirrors
// assertPhonchEditNotBelowSettled()'s exact shape (Bill is single-
// client/single-"received", same as Showroom Phonch).
// ------------------------------------------------------------

export async function assertBillEditNotBelowSettled(
  tx: Tx,
  billId: string,
  clientAccountId: string | null,
  currentTotalAmount: number,
  newTotalAmount: number
): Promise<void> {
  if (!clientAccountId) return;
  const state = await getBillPaymentState(tx, billId, clientAccountId, currentTotalAmount);
  if (round2(newTotalAmount) < state.receivedAmount - EPS) {
    throw new BillValidationError(
      `Amount cannot be less than the amount already received: ${formatRs(state.receivedAmount)}.`
    );
  }
}
