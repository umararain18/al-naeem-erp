import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// SHOWROOM PHONCH / DELIVERY - accounting + validation
//
// Mirrors two already-proven, separate mechanisms rather than
// inventing a new one:
//
//  1. Input validation/total computation - same shape as
//     lib/manual-journal-validation.ts's resolveManualJournalEntry().
//  2. "Received" derivation - same shape as
//     lib/bilty-paid-verification.ts's getBiltyPaidVerification():
//     a PURE READ, derived every time from Daily Posting receipts
//     tagged sourceType "PHONCH", sourceId = this Phonch's id. No
//     "received" value is ever stored on the Phonch itself.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.009;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class PhonchValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PhonchValidationError";
    this.status = status;
  }
}

export class PhonchAccountingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PhonchAccountingError";
    this.code = code;
  }
}

// ------------------------------------------------------------
// INPUT SHAPE
// ------------------------------------------------------------

export interface PhonchVehicleInput {
  biltyNo?: string;
  challanNo?: string;
  chassisNumber?: string;
  engineNumber?: string;
  vehicleName?: string;
  partyId?: string;
  deliveryCharges: number;
  note?: string;
  otherExpenseAmount?: number;
  otherExpenseReason?: string;
  claimAmount?: number;
  claimReason?: string;
}

export interface PhonchInput {
  phonchNo: string;
  date: string;
  transporterPartyId: string;
  carrierNumber?: string;
  description?: string;
  vehicles: PhonchVehicleInput[];
}

export interface ResolvedPhonchVehicle {
  lineNo: number;
  biltyNo: string | null;
  challanNo: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  vehicleName: string | null;
  partyId: string | null;
  deliveryCharges: number;
  note: string | null;
  otherExpenseAmount: number;
  otherExpenseReason: string | null;
  claimAmount: number;
  claimReason: string | null;
}

export interface ResolvedPhonch {
  phonchNo: string;
  date: Date;
  transporterPartyId: string;
  carrierNumber: string | null;
  description: string | null;
  vehicles: ResolvedPhonchVehicle[];
  totalDeliveryCharges: number;
  totalOtherExpense: number;
  totalClaim: number;
  totalAmount: number;
}

/**
 * Validates + normalizes a Phonch create/edit payload and computes
 * its totals. Throws PhonchValidationError on the first violation -
 * never silently drops/clamps an invalid line.
 */
export function resolvePhonchInput(data: PhonchInput): ResolvedPhonch {
  if (!data.phonchNo || !data.phonchNo.trim()) {
    throw new PhonchValidationError("Phonch No. is required");
  }

  if (!data.date || Number.isNaN(new Date(`${data.date}T00:00:00`).getTime())) {
    throw new PhonchValidationError("A valid Date is required");
  }

  if (!data.transporterPartyId) {
    throw new PhonchValidationError("Transporter is required");
  }

  if (!Array.isArray(data.vehicles) || data.vehicles.length === 0) {
    throw new PhonchValidationError("At least one vehicle line is required");
  }

  let totalDeliveryCharges = 0;
  let totalOtherExpense = 0;
  let totalClaim = 0;

  const vehicles: ResolvedPhonchVehicle[] = data.vehicles.map((v, index) => {
    const deliveryCharges = round2(Number(v.deliveryCharges) || 0);
    if (deliveryCharges < 0) {
      throw new PhonchValidationError(`Vehicle line ${index + 1}: Delivery Charges cannot be negative`);
    }

    const otherExpenseAmount = round2(Number(v.otherExpenseAmount) || 0);
    if (otherExpenseAmount < 0) {
      throw new PhonchValidationError(`Vehicle line ${index + 1}: Other Expense cannot be negative`);
    }
    if (otherExpenseAmount > 0 && !v.otherExpenseReason?.trim()) {
      throw new PhonchValidationError(`Vehicle line ${index + 1}: Other Expense reason is required when Other Expense is used`);
    }

    const claimAmount = round2(Number(v.claimAmount) || 0);
    if (claimAmount < 0) {
      throw new PhonchValidationError(`Vehicle line ${index + 1}: Claim amount cannot be negative`);
    }
    if (claimAmount > 0 && !v.chassisNumber?.trim()) {
      throw new PhonchValidationError(`Vehicle line ${index + 1}: Chassis No. is required to record a Claim`);
    }
    if (claimAmount > 0 && !v.claimReason?.trim()) {
      throw new PhonchValidationError(`Vehicle line ${index + 1}: Claim/damage reason is required when a Claim is used`);
    }

    totalDeliveryCharges = round2(totalDeliveryCharges + deliveryCharges);
    totalOtherExpense = round2(totalOtherExpense + otherExpenseAmount);
    totalClaim = round2(totalClaim + claimAmount);

    return {
      lineNo: index + 1,
      biltyNo: v.biltyNo?.trim() || null,
      challanNo: v.challanNo?.trim() || null,
      chassisNumber: v.chassisNumber?.trim() || null,
      engineNumber: v.engineNumber?.trim() || null,
      vehicleName: v.vehicleName?.trim() || null,
      partyId: v.partyId || null,
      deliveryCharges,
      note: v.note?.trim() || null,
      otherExpenseAmount,
      otherExpenseReason: otherExpenseAmount > 0 ? v.otherExpenseReason!.trim() : null,
      claimAmount,
      claimReason: claimAmount > 0 ? v.claimReason!.trim() : null,
    };
  });

  const totalAmount = round2(totalDeliveryCharges + totalOtherExpense + totalClaim);
  if (totalAmount <= 0) {
    throw new PhonchValidationError("Total Phonch Amount must be greater than zero");
  }

  return {
    phonchNo: data.phonchNo.trim(),
    date: new Date(`${data.date}T00:00:00`),
    transporterPartyId: data.transporterPartyId,
    carrierNumber: data.carrierNumber?.trim() || null,
    description: data.description?.trim() || null,
    vehicles,
    totalDeliveryCharges,
    totalOtherExpense,
    totalClaim,
    totalAmount,
  };
}

// ------------------------------------------------------------
// LEDGER DESCRIPTION (Step 10) - business-readable, comma-separated,
// fully self-contained (used as-is in the Party Ledger, its PDF/
// Excel exports, and the JournalEntry's own description - never
// re-derived differently in different places).
// ------------------------------------------------------------

function formatRs(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

/** Returns the one shared non-empty Bilty No. across vehicles, or null if none/mixed. */
function summarizeSharedBiltyNo(vehicles: ResolvedPhonchVehicle[]): string | null {
  const values = new Set(vehicles.map((v) => v.biltyNo).filter((v): v is string => !!v));
  return values.size === 1 ? [...values][0] : null;
}

/**
 * Groups vehicles by their vehicle-level Party/Showroom (NEVER the
 * Transporter - a separate, always-distinct field), preserving the
 * order each distinct Party first appears in the vehicle lines
 * (never alphabetical/by-count). A vehicle with no Party assigned is
 * grouped under `null` (rendered as "(no Party)") rather than
 * invented/guessed.
 */
function groupVehiclesByParty(
  vehicles: ResolvedPhonchVehicle[],
  vehiclePartyNames: Map<string, string>
): { partyName: string | null; count: number }[] {
  const order: (string | null)[] = [];
  const counts = new Map<string | null, number>();
  for (const v of vehicles) {
    const name = v.partyId ? vehiclePartyNames.get(v.partyId) || null : null;
    if (!counts.has(name)) {
      counts.set(name, 0);
      order.push(name);
    }
    counts.set(name, counts.get(name)! + 1);
  }
  return order.map((partyName) => ({ partyName, count: counts.get(partyName)! }));
}

export function buildPhonchLedgerDescription(
  phonch: { phonchNo: string; carrierNumber: string | null; description: string | null },
  vehicles: ResolvedPhonchVehicle[],
  totals: { totalDeliveryCharges: number; totalOtherExpense: number; totalClaim: number },
  vehiclePartyNames: Map<string, string>,
  transporterName: string
): string {
  const parts: string[] = [`Phonch No. ${phonch.phonchNo}`];

  const sharedBiltyNo = summarizeSharedBiltyNo(vehicles);
  if (sharedBiltyNo) parts.push(`Bilty No. ${sharedBiltyNo}`);

  // Vehicle-party grouping - "3x vehicle of X, 2x vehicle of Y, ...,
  // Total 5x vehicle" - replaces the old bare "Total Vehicles N" and
  // the old single-Party summary, since this supersedes both.
  const groups = groupVehiclesByParty(vehicles, vehiclePartyNames);
  for (const g of groups) {
    parts.push(`${g.count}x vehicle of ${g.partyName || "(no Party)"}`);
  }
  parts.push(`Total ${vehicles.length}x vehicle`);

  parts.push(`Transporter ${transporterName}`);

  if (phonch.carrierNumber) parts.push(`Carrier No. ${phonch.carrierNumber}`);

  if (totals.totalDeliveryCharges > 0) {
    parts.push(`Delivery Charges ${formatRs(totals.totalDeliveryCharges)}`);
  }

  if (totals.totalOtherExpense > 0) {
    const reasons = [...new Set(vehicles.map((v) => v.otherExpenseReason).filter((r): r is string => !!r))];
    parts.push(`Other Expense: ${reasons.join("; ")} ${formatRs(totals.totalOtherExpense)}`);
  }

  if (totals.totalClaim > 0) {
    // Each claimed vehicle keeps its OWN chassis/vehicle name/reason/
    // amount - never merged/attributed to the wrong vehicle, even
    // when several vehicles on the same Phonch have separate claims.
    const claimTexts = vehicles
      .filter((v) => v.claimAmount > 0)
      .map((v) =>
        [`Chassis ${v.chassisNumber}`, v.vehicleName, v.claimReason, formatRs(v.claimAmount)]
          .filter(Boolean)
          .join(", ")
      );
    parts.push(`Claim: ${claimTexts.join("; ")}`);
  }

  if (phonch.description) parts.push(`Description: ${phonch.description}`);

  return parts.join(", ");
}

// ------------------------------------------------------------
// "RECEIVED" DERIVATION (Step 9/17) - exact same shape as
// lib/bilty-paid-verification.ts's getBiltyPaidVerification().
// ------------------------------------------------------------

export interface PhonchPaymentState {
  phonchId: string;
  totalAmount: number;
  receivedAmount: number;
  remainingDue: number;
  /** True only if receivedAmount somehow exceeds totalAmount - a data
   * inconsistency that must be surfaced explicitly, never silently
   * clamped (per the module's own explicit "no Math.max() clamping"
   * requirement). Should never occur if every Daily Posting receipt
   * is validated through assertPhonchReceiptNotExceeded() below. */
  isInconsistent: boolean;
  status: "RECEIVABLE" | "CLEARED";
}

export async function getPhonchPaymentState(
  tx: Tx,
  phonchId: string,
  transporterAccountId: string,
  totalAmount: number,
  // Set only when EDITING an existing Daily Posting receipt against
  // the SAME Phonch, so that row's own prior amount is not double-
  // counted against itself before the new amount is checked - see
  // lib/bilty-paid-verification.ts's identical parameter.
  excludeJournalEntryId?: string
): Promise<PhonchPaymentState> {
  const lines = await tx.journalLine.findMany({
    where: {
      accountId: transporterAccountId,
      sourceType: "PHONCH",
      sourceId: phonchId,
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
  // (app/api/daily-posting/route.ts) and getBiltyPaidVerification()
  // already use for any receipt.
  const receivedAmount = Math.max(
    0,
    round2(lines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0))
  );

  const isInconsistent = receivedAmount > totalAmount + EPS;
  const remainingDue = isInconsistent ? 0 : Math.max(0, round2(totalAmount - receivedAmount));

  return {
    phonchId,
    totalAmount,
    receivedAmount,
    remainingDue,
    isInconsistent,
    status: !isInconsistent && remainingDue <= EPS ? "CLEARED" : "RECEIVABLE",
  };
}

// ------------------------------------------------------------
// EDIT-TIME "NOT BELOW ALREADY RECEIVED" CHECK - a financial edit is
// allowed after partial receipt, as long as the EDITED Total Amount is
// still >= what has already actually been received via Daily Posting.
// Reuses getPhonchPaymentState() above (the one authoritative reader
// of Daily Posting lines for this Phonch) rather than a second,
// separately-computed balance - the `totalAmount` argument passed to
// it here is irrelevant to the returned receivedAmount (which is
// derived purely from JournalLines), so the CURRENT (pre-edit) total
// is passed through for semantic clarity only.
// ------------------------------------------------------------

export async function assertPhonchEditNotBelowSettled(
  tx: Tx,
  phonchId: string,
  transporterAccountId: string | null,
  currentTotalAmount: number,
  newTotalAmount: number
): Promise<void> {
  if (!transporterAccountId) return;
  const state = await getPhonchPaymentState(tx, phonchId, transporterAccountId, currentTotalAmount);
  if (round2(newTotalAmount) < state.receivedAmount - EPS) {
    throw new PhonchValidationError(
      `Amount cannot be less than the amount already received: ${formatRs(state.receivedAmount)}.`
    );
  }
}

/**
 * Validates that a NEW Daily Posting receipt of `amount` credited
 * against `phonchId`'s Transporter would not verify more than the
 * Phonch's Total Amount allows. Mirrors
 * assertPaidVerificationNotExceeded() in lib/bilty-paid-verification.ts,
 * including computing the Phonch's own Total Amount fresh from `tx`
 * (never trusting a caller-supplied figure that could be stale).
 */
export async function assertPhonchReceiptNotExceeded(
  tx: Tx,
  phonchId: string,
  counterAccountId: string,
  amount: number,
  direction: "DEBIT" | "CREDIT",
  excludeJournalEntryId?: string
): Promise<void> {
  // direction is the MAIN account's own direction, per Daily
  // Posting's existing convention - DEBIT means the main account
  // (Cash/Bank) receives money, crediting the counter (Transporter)
  // account - i.e. a receipt from them. Only that shape can verify.
  if (direction !== "DEBIT") return;

  const phonch = await tx.phonch.findUnique({
    where: { id: phonchId },
    select: { vehicles: { select: { deliveryCharges: true, otherExpenseAmount: true, claimAmount: true } } },
  });
  const totalAmount = round2(
    (phonch?.vehicles || []).reduce(
      (s, v) => s + Number(v.deliveryCharges) + Number(v.otherExpenseAmount) + Number(v.claimAmount),
      0
    )
  );

  const state = await getPhonchPaymentState(tx, phonchId, counterAccountId, totalAmount, excludeJournalEntryId);

  if (state.isInconsistent) {
    throw new PhonchAccountingError(
      "PHONCH_RECEIPT_INCONSISTENT",
      `This Phonch's verified receipt (${state.receivedAmount}) already exceeds its Total Amount (${state.totalAmount}) - a data inconsistency. Resolve this before posting further receipts.`
    );
  }

  if (round2(state.receivedAmount + amount) > state.totalAmount + EPS) {
    throw new PhonchAccountingError(
      "PHONCH_OVER_RECEIPT",
      `This receipt of ${round2(amount)} would exceed this Phonch's remaining due (${state.remainingDue}). Total Amount = ${state.totalAmount}, already received = ${state.receivedAmount}.`
    );
  }
}
