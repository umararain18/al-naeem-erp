import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// PRIVATE PHONCH - accounting + validation
//
// Mirrors lib/phonch-accounting.ts's own two proven mechanisms,
// adapted for a PAYABLE (money ANC owes out) instead of a
// RECEIVABLE:
//
//  1. Input validation/total computation - same shape as
//     resolvePhonchInput().
//  2. "Paid"/"Received" derivation - same shape as
//     getPhonchPaymentState()/getBiltyPaidVerification(): a PURE
//     READ, derived every time from Daily Posting lines tagged
//     sourceType "PRIVATE_PHONCH", sourceId = this record's id. No
//     "paid"/"remaining" value is ever stored on the record itself.
//
// Unlike Showroom Phonch (ONE responsible party - the Transporter),
// a Private Phonch can have SEVERAL distinct payable parties at once
// (the Transporter, plus every distinct Clearing Agent named on a
// vehicle row) - every payment-state function here is therefore keyed
// by (phonchId, payerAccountId), never assumed to be "the" single
// party.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.009;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class PrivatePhonchValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PrivatePhonchValidationError";
    this.status = status;
  }
}

export class PrivatePhonchAccountingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PrivatePhonchAccountingError";
    this.code = code;
  }
}

// ------------------------------------------------------------
// INPUT SHAPE
// ------------------------------------------------------------

export type PrivatePhonchDeliveryRecoveryParty = "TRANSPORTER" | "CLEARING_AGENT";

export interface PrivatePhonchVehicleInput {
  biltyNo?: string;
  challanNo?: string;
  chassisNumber?: string;
  engineNumber?: string;
  vehicleName?: string;
  clearingAgentPartyId?: string;
  totalRent: number;
  deliveryCharges?: number;
  carrierPayable?: number;
  // Only meaningful when totalRent = 0 and deliveryCharges > 0 - who
  // this vehicle's Delivery Charges are recovered FROM. Defaults to
  // "TRANSPORTER" (the pre-existing behavior) when omitted, so every
  // caller/test written before this field existed keeps working
  // unchanged.
  deliveryRecoveryParty?: PrivatePhonchDeliveryRecoveryParty;
  note?: string;
}

export interface PrivatePhonchInput {
  phonchNo: string;
  date: string;
  transporterPartyId: string;
  vehicles: PrivatePhonchVehicleInput[];
}

export interface ResolvedPrivatePhonchVehicle {
  lineNo: number;
  biltyNo: string | null;
  challanNo: string | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  vehicleName: string | null;
  clearingAgentPartyId: string | null;
  totalRent: number;
  deliveryCharges: number;
  carrierPayable: number;
  // Derived, never independently stored/trusted - see the schema's
  // own doc comment on PrivatePhonchVehicle.
  netRent: number;
  caPayable: number;
  // Derived. Non-zero ONLY when totalRent is 0 for this vehicle (a
  // fully-paid vehicle where only Delivery Charges remain) - see the
  // module doc comment below. Zero for every normal (totalRent > 0)
  // vehicle, where Delivery Charges is instead absorbed into Net
  // Rent/CA Payable exactly as before this rule existed.
  deliveryRecovery: number;
  // Who deliveryRecovery is owed BY - null unless deliveryRecovery > 0.
  deliveryRecoveryParty: PrivatePhonchDeliveryRecoveryParty | null;
  note: string | null;
}

export interface ResolvedPrivatePhonch {
  phonchNo: string;
  date: Date;
  transporterPartyId: string;
  vehicles: ResolvedPrivatePhonchVehicle[];
  totalRent: number;
  totalDeliveryCharges: number;
  totalNetRent: number;
  totalCarrierPayable: number;
  totalCaPayable: number;
  // Grand total of deliveryRecovery across every vehicle, REGARDLESS
  // of recipient - kept for display/back-compat. Never posted as one
  // combined line - see totalTransporterDeliveryRecovery and
  // caDeliveryRecoveryByPartyId below, which split it by WHO it's
  // owed by.
  totalDeliveryRecovery: number;
  // The Transporter's own share of totalDeliveryRecovery (vehicles
  // where deliveryRecoveryParty === "TRANSPORTER").
  totalTransporterDeliveryRecovery: number;
  // Each Clearing Agent's own share of totalDeliveryRecovery
  // (vehicles where deliveryRecoveryParty === "CLEARING_AGENT"),
  // keyed by clearingAgentPartyId - never combined into one figure,
  // exactly like caPayable is already kept per-party.
  caDeliveryRecoveryByPartyId: Map<string, number>;
}

/**
 * Validates + normalizes a Private Phonch create/edit payload and
 * (re)computes Net Rent/CA Payable from the raw inputs alone - never
 * trusts a client-sent netRent/caPayable value, per the formula:
 *
 *   Net Rent = Total Rent - Delivery Charges
 *   CA Payable = Net Rent - Carrier Payable
 *
 * EXCEPTION - a fully-paid vehicle (Total Rent = 0): Delivery Charges
 * must never push Net Rent/CA Payable negative just because there is
 * no Rent left to absorb them. For such a vehicle:
 *
 *   Net Rent = 0
 *   Carrier Payable = 0 (any nonzero value is rejected below, via the
 *     existing "Carrier Payable cannot exceed Net Rent" check, since
 *     Net Rent is now correctly 0 instead of negative)
 *   CA Payable = 0
 *   Delivery Recovery = Delivery Charges (a NEW, independent
 *     RECEIVABLE from the Transporter - see
 *     getPrivatePhonchDeliveryRecoveryState() below - never a payable
 *     to a Clearing Agent, never negative).
 *
 * Throws PrivatePhonchValidationError on the first violation - never
 * silently clamps/drops an invalid line.
 */
export function resolvePrivatePhonchInput(data: PrivatePhonchInput): ResolvedPrivatePhonch {
  if (!data.phonchNo || !data.phonchNo.trim()) {
    throw new PrivatePhonchValidationError("Private Phonch No. is required");
  }

  if (!data.date || Number.isNaN(new Date(`${data.date}T00:00:00`).getTime())) {
    throw new PrivatePhonchValidationError("A valid Date is required");
  }

  if (!data.transporterPartyId) {
    throw new PrivatePhonchValidationError("Transporter is required");
  }

  if (!Array.isArray(data.vehicles) || data.vehicles.length === 0) {
    throw new PrivatePhonchValidationError("At least one vehicle line is required");
  }

  let totalRent = 0;
  let totalDeliveryCharges = 0;
  let totalNetRent = 0;
  let totalCarrierPayable = 0;
  let totalCaPayable = 0;
  let totalDeliveryRecovery = 0;
  let totalTransporterDeliveryRecovery = 0;
  const caDeliveryRecoveryByPartyId = new Map<string, number>();
  // Tracked purely to enforce the mutual-exclusivity guard below - a
  // Clearing Agent's account can carry EITHER a CA Payable OR a CA
  // Delivery Recovery on a given Private Phonch, never both. Both
  // balance types read/cap Daily Posting lines on the SAME account by
  // JournalLine DIRECTION alone (see getPrivatePhonchPaymentState()'s
  // and getPrivatePhonchDeliveryRecoveryState()'s own polarity notes);
  // unlike the Transporter (who never has a "deposit" feature), a
  // Clearing Agent's CREDIT-direction line is ambiguous between "a
  // deposit increasing CA Payable" and "a recovery receipt reducing CA
  // Recovery" once both exist on the same account, so this guard
  // avoids that collision entirely rather than trying to resolve it.
  const caPayableByPartyIdForGuard = new Map<string, number>();

  const vehicles: ResolvedPrivatePhonchVehicle[] = data.vehicles.map((v, index) => {
    const label = `Vehicle line ${index + 1}`;

    const vTotalRent = round2(Number(v.totalRent) || 0);
    if (vTotalRent < 0) {
      throw new PrivatePhonchValidationError(`${label}: Total Rent cannot be negative`);
    }

    const deliveryCharges = round2(Number(v.deliveryCharges) || 0);
    if (deliveryCharges < 0) {
      throw new PrivatePhonchValidationError(`${label}: Delivery Charges cannot be negative`);
    }

    // Fully-paid vehicle (Total Rent = 0): Delivery Charges never
    // reduce Net Rent below zero - they become a Transporter Delivery
    // Recovery instead (see this function's own doc comment above).
    // A normal (Total Rent > 0) vehicle is completely unchanged: the
    // existing "cannot exceed Total Rent" guard still applies, and
    // Delivery Recovery stays 0.
    let netRent: number;
    let deliveryRecovery = 0;
    let deliveryRecoveryParty: PrivatePhonchDeliveryRecoveryParty | null = null;
    if (vTotalRent <= EPS) {
      netRent = 0;
      deliveryRecovery = deliveryCharges;
      if (deliveryRecovery > EPS) {
        deliveryRecoveryParty = v.deliveryRecoveryParty === "CLEARING_AGENT" ? "CLEARING_AGENT" : "TRANSPORTER";
        if (deliveryRecoveryParty === "CLEARING_AGENT") {
          if (!v.clearingAgentPartyId) {
            throw new PrivatePhonchValidationError(`${label}: Select a Clearing Agent for Delivery Recovery`);
          }
          caDeliveryRecoveryByPartyId.set(
            v.clearingAgentPartyId,
            round2((caDeliveryRecoveryByPartyId.get(v.clearingAgentPartyId) || 0) + deliveryRecovery)
          );
        } else {
          totalTransporterDeliveryRecovery = round2(totalTransporterDeliveryRecovery + deliveryRecovery);
        }
      }
    } else {
      if (deliveryCharges > vTotalRent + EPS) {
        throw new PrivatePhonchValidationError(`${label}: Delivery Charges cannot exceed Total Rent`);
      }
      netRent = round2(vTotalRent - deliveryCharges);
    }

    const carrierPayable = round2(Number(v.carrierPayable) || 0);
    if (carrierPayable < 0) {
      throw new PrivatePhonchValidationError(`${label}: Carrier Payable cannot be negative`);
    }
    if (carrierPayable > netRent + EPS) {
      throw new PrivatePhonchValidationError(
        vTotalRent <= EPS
          ? `${label}: Carrier Payable must be 0 when Total Rent is 0`
          : `${label}: Carrier Payable cannot exceed Net Rent`
      );
    }

    const caPayable = round2(netRent - carrierPayable);
    if (caPayable < -EPS) {
      throw new PrivatePhonchValidationError(`${label}: CA Payable cannot be negative`);
    }

    if (caPayable > EPS && !v.clearingAgentPartyId) {
      throw new PrivatePhonchValidationError(`${label}: Clearing Agent is required when CA Payable is greater than zero`);
    }

    if (caPayable > EPS && v.clearingAgentPartyId) {
      caPayableByPartyIdForGuard.set(
        v.clearingAgentPartyId,
        round2((caPayableByPartyIdForGuard.get(v.clearingAgentPartyId) || 0) + caPayable)
      );
    }

    if (vTotalRent <= 0 && deliveryCharges <= 0 && carrierPayable <= 0) {
      throw new PrivatePhonchValidationError(`${label}: Total Rent must be greater than zero`);
    }

    totalRent = round2(totalRent + vTotalRent);
    totalDeliveryCharges = round2(totalDeliveryCharges + deliveryCharges);
    totalNetRent = round2(totalNetRent + netRent);
    totalCarrierPayable = round2(totalCarrierPayable + carrierPayable);
    totalCaPayable = round2(totalCaPayable + caPayable);
    totalDeliveryRecovery = round2(totalDeliveryRecovery + deliveryRecovery);

    return {
      lineNo: index + 1,
      biltyNo: v.biltyNo?.trim() || null,
      challanNo: v.challanNo?.trim() || null,
      chassisNumber: v.chassisNumber?.trim() || null,
      engineNumber: v.engineNumber?.trim() || null,
      vehicleName: v.vehicleName?.trim() || null,
      clearingAgentPartyId: v.clearingAgentPartyId || null,
      totalRent: vTotalRent,
      deliveryCharges,
      carrierPayable,
      netRent,
      caPayable,
      deliveryRecovery,
      deliveryRecoveryParty,
      note: v.note?.trim() || null,
    };
  });

  // Mutual-exclusivity guard - see caPayableByPartyIdForGuard's own
  // comment above.
  for (const [partyId, recoveryAmount] of caDeliveryRecoveryByPartyId) {
    if (recoveryAmount > EPS && (caPayableByPartyIdForGuard.get(partyId) || 0) > EPS) {
      throw new PrivatePhonchValidationError(
        "A Clearing Agent cannot have both a CA Payable and a Delivery Recovery on the same Private Phonch. Use a different Clearing Agent for Delivery Recovery, or attribute it to the Transporter instead."
      );
    }
  }

  // Previously "Total Rent must be greater than zero" - now a
  // fully-paid-vehicle-only Private Phonch (Total Rent = 0 overall,
  // Delivery Recovery > 0) is legitimate, so the guard widens to
  // "must have SOME economic content", matching Showroom Phonch's own
  // analogous "Total Phonch Amount must be greater than zero" check.
  if (totalRent <= 0 && totalDeliveryRecovery <= 0) {
    throw new PrivatePhonchValidationError("Private Phonch must have some Total Rent or Delivery Charges");
  }

  return {
    phonchNo: data.phonchNo.trim(),
    date: new Date(`${data.date}T00:00:00`),
    transporterPartyId: data.transporterPartyId,
    vehicles,
    totalRent,
    totalDeliveryCharges,
    totalNetRent,
    totalCarrierPayable,
    totalCaPayable,
    totalDeliveryRecovery,
    totalTransporterDeliveryRecovery,
    caDeliveryRecoveryByPartyId,
  };
}

// ------------------------------------------------------------
// LEDGER DESCRIPTION - business-readable, comma-separated, fully
// self-contained (used as-is in the Party Ledger and the
// JournalEntry's own description). One description is built PER
// DESTINATION PARTY (the Transporter's own line reads differently
// from each Clearing Agent's own line), mirroring how
// buildPhonchLedgerDescription() is one shared builder but each
// caller passes the amount/direction relevant to ITS OWN line.
// ------------------------------------------------------------

function formatRs(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

function summarizeSharedText(values: (string | null)[]): string | null {
  const set = new Set(values.filter((v): v is string => !!v));
  return set.size === 1 ? [...set][0] : null;
}

export function buildPrivatePhonchTransporterDescription(
  phonch: { phonchNo: string },
  vehicles: ResolvedPrivatePhonchVehicle[],
  totalCarrierPayable: number
): string {
  const parts: string[] = [`Private Phonch No. ${phonch.phonchNo}`];
  const sharedBiltyNo = summarizeSharedText(vehicles.map((v) => v.biltyNo));
  if (sharedBiltyNo) parts.push(`Bilty No. ${sharedBiltyNo}`);
  const sharedChallanNo = summarizeSharedText(vehicles.map((v) => v.challanNo));
  if (sharedChallanNo) parts.push(`Challan No. ${sharedChallanNo}`);
  parts.push(`${vehicles.length}x vehicle`);
  parts.push(`Carrier Rent Payable ${formatRs(totalCarrierPayable)}`);
  return parts.join(", ");
}

export function buildPrivatePhonchClearingAgentDescription(
  phonch: { phonchNo: string },
  vehicles: ResolvedPrivatePhonchVehicle[],
  clearingAgentName: string,
  caPayableForThisAgent: number
): string {
  const parts: string[] = [`Private Phonch No. ${phonch.phonchNo}`];
  const sharedBiltyNo = summarizeSharedText(vehicles.map((v) => v.biltyNo));
  if (sharedBiltyNo) parts.push(`Bilty No. ${sharedBiltyNo}`);
  const sharedChallanNo = summarizeSharedText(vehicles.map((v) => v.challanNo));
  if (sharedChallanNo) parts.push(`Challan No. ${sharedChallanNo}`);
  parts.push(`${vehicles.length}x vehicle`);
  parts.push(`Clearing Agent ${clearingAgentName}`);
  parts.push(`Amanat Payable ${formatRs(caPayableForThisAgent)}`);
  return parts.join(", ");
}

// ------------------------------------------------------------
// PAYMENT STATE (per payer account) - exact same shape as
// getPhonchPaymentState(), keyed additionally by which payer account
// (Transporter's own, or one specific Clearing Agent's own).
// ------------------------------------------------------------

export interface PrivatePhonchPaymentState {
  phonchId: string;
  payerAccountId: string;
  totalPayable: number;
  paidAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "PAYABLE" | "CLEARED";
}

// Shared low-level read - every Daily Posting JournalLine tagged to
// this Private Phonch, on one specific account. Both payment-state
// functions below (and the edit-time "already settled" check further
// down) read through this SAME query, never a separately-written one,
// so the set of lines considered can never drift between them.
async function sumPrivatePhonchAccountDailyPostingLines(
  tx: Tx,
  phonchId: string,
  accountId: string,
  excludeJournalEntryId?: string
): Promise<{ debit: number; credit: number }> {
  const lines = await tx.journalLine.findMany({
    where: {
      accountId,
      sourceType: "PRIVATE_PHONCH",
      sourceId: phonchId,
      journalEntry: {
        referenceType: "DAILY_POSTING",
        isDeleted: false,
        ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
      },
    },
    select: { debit: true, credit: true },
  });
  return {
    debit: round2(lines.reduce((s, l) => s + Number(l.debit), 0)),
    credit: round2(lines.reduce((s, l) => s + Number(l.credit), 0)),
  };
}

export async function getPrivatePhonchPaymentState(
  tx: Tx,
  phonchId: string,
  payerAccountId: string,
  totalPayable: number,
  excludeJournalEntryId?: string,
  isTransporterAccount = false
): Promise<PrivatePhonchPaymentState> {
  const { debit, credit } = await sumPrivatePhonchAccountDailyPostingLines(tx, phonchId, payerAccountId, excludeJournalEntryId);

  // A PAYABLE party account carries a CREDIT balance (ANC owes them).
  // A Daily Posting PAYMENT to them DEBITS their account (reduces
  // what's owed) - the opposite polarity from a RECEIVABLE (Bilty/
  // Showroom Phonch), where a receipt CREDITS the party. A Clearing
  // Agent DEPOSIT (Case 11) instead CREDITS their account further
  // (increases what's owed) - both are read here identically as
  // (debit - credit), so a deposit naturally reduces `paidAmount`
  // back toward/below zero rather than being miscounted as a payment.
  //
  // EXCEPTION - the Transporter's own account can ALSO carry an
  // entirely separate, opposite-polarity Delivery Recovery receivable
  // (see getPrivatePhonchDeliveryRecoveryState() below), posted as
  // CREDIT lines on this SAME account/phonch/sourceType. Those
  // credits are not a Case-11-style deposit against Carrier Payable -
  // they belong to a different economic event - so netting them here
  // would let an unrelated recovery receipt inflate or deflate Carrier
  // Payable's own remainingDue. For the Transporter specifically,
  // paidAmount is DEBIT-lines-only; every other (Clearing Agent)
  // account keeps the original debit-minus-credit netting, since a
  // deposit legitimately increasing what's owed is a real feature
  // there.
  const paidAmount = isTransporterAccount ? debit : round2(debit - credit);

  const isInconsistent = paidAmount > totalPayable + EPS;
  const remainingDue = isInconsistent ? 0 : Math.max(0, round2(totalPayable - paidAmount));

  return {
    phonchId,
    payerAccountId,
    totalPayable,
    paidAmount: Math.max(0, paidAmount),
    remainingDue,
    isInconsistent,
    status: !isInconsistent && remainingDue <= EPS ? "CLEARED" : "PAYABLE",
  };
}

// ------------------------------------------------------------
// TRANSPORTER DELIVERY RECOVERY STATE - a genuine RECEIVABLE (money
// owed BY the Transporter TO ANC), independent of and opposite in
// polarity from the Transporter's own Carrier Payable above. Arises
// only from a fully-paid (Total Rent = 0) vehicle's Delivery Charges -
// see resolvePrivatePhonchInput()'s own doc comment. Mirrors
// getBiltyPaidVerification()/getPhonchPaymentState()'s RECEIVABLE
// convention exactly (a receipt CREDITS the party, reducing what they
// owe) - the deliberate opposite of getPrivatePhonchPaymentState()
// above, which is PAYABLE-oriented (a payment DEBITS the party).
// Reads the exact same JournalLine rows a Carrier Payable payment
// would (same account, same sourceId), but sums debit/credit in the
// OPPOSITE direction - safe because, structurally, a Carrier Payable
// payment is always posted as a Daily Posting PAYMENT (direction
// CREDIT, i.e. a DEBIT to the Transporter's account) while a Delivery
// Recovery receipt is always posted as a Daily Posting RECEIPT
// (direction DEBIT, i.e. a CREDIT to the Transporter's account) - the
// two can never be confused with each other on the same account.
// ------------------------------------------------------------

export interface PrivatePhonchDeliveryRecoveryState {
  phonchId: string;
  transporterAccountId: string;
  totalRecovery: number;
  recoveredAmount: number;
  remainingDue: number;
  isInconsistent: boolean;
  status: "RECEIVABLE" | "CLEARED";
}

export async function getPrivatePhonchDeliveryRecoveryState(
  tx: Tx,
  phonchId: string,
  transporterAccountId: string,
  totalRecovery: number,
  excludeJournalEntryId?: string
): Promise<PrivatePhonchDeliveryRecoveryState> {
  const { credit } = await sumPrivatePhonchAccountDailyPostingLines(tx, phonchId, transporterAccountId, excludeJournalEntryId);

  // CREDIT-lines-only - see getPrivatePhonchPaymentState()'s identical
  // note above. A DEBIT line on this same account/phonch/sourceType
  // belongs to an entirely separate Carrier Payable payment and must
  // never reduce this receivable (this function is only ever called
  // for the Transporter's own account, which never has a Case-11-style
  // deposit concept of its own).
  const recoveredAmount = credit;
  const isInconsistent = recoveredAmount > totalRecovery + EPS;
  const remainingDue = isInconsistent ? 0 : Math.max(0, round2(totalRecovery - recoveredAmount));

  return {
    phonchId,
    transporterAccountId,
    totalRecovery,
    recoveredAmount,
    remainingDue,
    isInconsistent,
    status: !isInconsistent && remainingDue <= EPS ? "CLEARED" : "RECEIVABLE",
  };
}

// ------------------------------------------------------------
// OVERALL STATUS - the single authoritative rule for "what is this
// Private Phonch's current outstanding position", used identically by
// the list and the detail page (never re-derived independently in the
// UI). Carrier Payable and CA Payable are the same PAYABLE direction;
// Delivery Recovery is the opposite, RECEIVABLE direction - the two
// are never netted against each other, only checked for co-existence.
// ------------------------------------------------------------

export type PrivatePhonchOverallStatus = "PAYABLE" | "RECEIVABLE" | "MIXED" | "CLEARED";

export function derivePrivatePhonchOverallStatus(params: {
  carrierRemaining: number;
  caRemaining: number;
  recoveryRemaining: number;
}): PrivatePhonchOverallStatus {
  const hasPayable = params.carrierRemaining > EPS || params.caRemaining > EPS;
  const hasReceivable = params.recoveryRemaining > EPS;
  if (hasPayable && hasReceivable) return "MIXED";
  if (hasPayable) return "PAYABLE";
  if (hasReceivable) return "RECEIVABLE";
  return "CLEARED";
}

// ------------------------------------------------------------
// EDIT-TIME "NOT BELOW ALREADY SETTLED" CHECK - a financial edit
// (Total Rent/Delivery Charges/Carrier Payable/Clearing Agent
// reassignment) is allowed after partial payment, as long as the
// EDITED amount on every independent payable/receivable line is still
// >= what has already actually been paid/received against it via
// Daily Posting. Historical Daily Posting JournalEntries are never
// touched by an edit - only the Private Phonch's own creation entry
// is replaced (see the PATCH route's existing replace-on-edit
// pattern), so "already settled" is always read fresh from Daily
// Posting lines, never from a value carried over in memory.
// ------------------------------------------------------------

export async function getPrivatePhonchAlreadySettledAmount(
  tx: Tx,
  phonchId: string,
  accountId: string,
  kind: "CARRIER_PAYABLE" | "DELIVERY_RECOVERY" | "CA_PAYABLE"
): Promise<number> {
  const { debit, credit } = await sumPrivatePhonchAccountDailyPostingLines(tx, phonchId, accountId);
  if (kind === "CARRIER_PAYABLE") return Math.max(0, debit);
  if (kind === "DELIVERY_RECOVERY") return Math.max(0, credit);
  return Math.max(0, round2(debit - credit));
}

/**
 * Validates a Private Phonch EDIT's new financial amounts against
 * what has already been settled via Daily Posting, independently per
 * line - never netting Carrier Payable against Delivery Recovery, and
 * never combining several Clearing Agents into one figure. Throws
 * PrivatePhonchValidationError with a business-readable message on
 * the FIRST violation found - the caller must reject the entire edit
 * atomically (no partial save) on any failure.
 *
 * `transporterAccountId` must be the CURRENT (pre-edit) Transporter's
 * own account - already-settled amounts belong to a specific account
 * permanently and are read from it regardless of what the edit itself
 * changes. Changing the Transporter PARTY itself while it already has
 * a settled amount is rejected separately by the caller (see the
 * PATCH route) - this function only validates AMOUNTS, not identity.
 */
export async function assertPrivatePhonchEditNotBelowSettled(
  tx: Tx,
  phonchId: string,
  transporterAccountId: string | null,
  resolved: ResolvedPrivatePhonch,
  caAccountIdByPartyId: Map<string, string>
): Promise<void> {
  if (transporterAccountId) {
    const carrierAlreadyPaid = await getPrivatePhonchAlreadySettledAmount(tx, phonchId, transporterAccountId, "CARRIER_PAYABLE");
    if (round2(resolved.totalCarrierPayable) < carrierAlreadyPaid - EPS) {
      throw new PrivatePhonchValidationError(
        `Cannot reduce Carrier Payable below the amount already paid. ${formatRs(carrierAlreadyPaid)} has already been paid.`
      );
    }

    const recoveryAlreadyReceived = await getPrivatePhonchAlreadySettledAmount(tx, phonchId, transporterAccountId, "DELIVERY_RECOVERY");
    if (round2(resolved.totalTransporterDeliveryRecovery) < recoveryAlreadyReceived - EPS) {
      throw new PrivatePhonchValidationError(
        `Cannot reduce Delivery Recovery below the amount already received. ${formatRs(recoveryAlreadyReceived)} has already been received.`
      );
    }
  }

  // New CA Payable, summed by ACCOUNT (never by partyId alone - the
  // same Clearing Agent could theoretically appear via a different
  // party record, but never two different Clearing Agents sharing one
  // account), from the NEW (post-edit) vehicle set only.
  const newCaPayableByAccountId = new Map<string, number>();
  for (const v of resolved.vehicles) {
    if (!v.clearingAgentPartyId || v.caPayable <= 0) continue;
    const accountId = caAccountIdByPartyId.get(v.clearingAgentPartyId);
    if (!accountId) continue;
    newCaPayableByAccountId.set(accountId, round2((newCaPayableByAccountId.get(accountId) || 0) + v.caPayable));
  }

  // New Clearing Agent Delivery Recovery, summed by ACCOUNT the same
  // way - independent of, and never netted against, newCaPayableByAccountId
  // above (the mutual-exclusivity guard in resolvePrivatePhonchInput()
  // already ensures a given account never legitimately appears in both).
  const newCaRecoveryByAccountId = new Map<string, number>();
  for (const [partyId, amount] of resolved.caDeliveryRecoveryByPartyId) {
    const accountId = caAccountIdByPartyId.get(partyId);
    if (!accountId || amount <= 0) continue;
    newCaRecoveryByAccountId.set(accountId, round2((newCaRecoveryByAccountId.get(accountId) || 0) + amount));
  }

  // Every account that has EVER received a Daily Posting payment
  // against this Private Phonch - not just Clearing Agents still named
  // on the NEW vehicle list - so reassigning/removing an
  // already-paid/already-recovered Clearing Agent is caught exactly
  // like reducing their amount would be (their new effective amount is
  // then 0). Checked as BOTH a payable and a recovery, independently -
  // an account only ever has a genuine nonzero settled amount as one
  // of the two (the mutual-exclusivity guard), but checking both sides
  // costs nothing and needs no assumption about which one it was.
  //
  // account.partyId != null is required here - a Daily Posting's OWN
  // main Cash/Bank account is tagged with this SAME sourceType/sourceId
  // on every line (see app/api/daily-posting/route.ts's buildLinePair()),
  // so without this filter the main account itself would be swept in
  // here and misread as a Clearing Agent with a settled amount.
  const historicalPayeeAccounts = await tx.journalLine.findMany({
    where: {
      sourceType: "PRIVATE_PHONCH",
      sourceId: phonchId,
      ...(transporterAccountId ? { accountId: { not: transporterAccountId } } : {}),
      account: { partyId: { not: null } },
      journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false },
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });

  for (const { accountId } of historicalPayeeAccounts) {
    const alreadyPaid = await getPrivatePhonchAlreadySettledAmount(tx, phonchId, accountId, "CA_PAYABLE");
    const newPayableAmount = newCaPayableByAccountId.get(accountId) || 0;
    if (round2(newPayableAmount) < alreadyPaid - EPS) {
      throw new PrivatePhonchValidationError(
        `Cannot reduce Clearing Agent Payable below the amount already paid. ${formatRs(alreadyPaid)} has already been paid.`
      );
    }

    const alreadyRecovered = await getPrivatePhonchAlreadySettledAmount(tx, phonchId, accountId, "DELIVERY_RECOVERY");
    const newRecoveryAmount = newCaRecoveryByAccountId.get(accountId) || 0;
    if (round2(newRecoveryAmount) < alreadyRecovered - EPS) {
      throw new PrivatePhonchValidationError(
        `Cannot reduce Delivery Recovery below the amount already received. ${formatRs(alreadyRecovered)} has already been received.`
      );
    }
  }
}

/**
 * Validates that a NEW Daily Posting PAYMENT (direction CREDIT - the
 * main Cash/Bank account pays out, debiting the counter/payable
 * account) against `phonchId` would not exceed that specific payer's
 * own remaining due. A Clearing Agent DEPOSIT (direction DEBIT - the
 * main account receives money, crediting the Clearing Agent) is never
 * capped here - Case 11 explicitly allows it as a real, independent
 * receipt regardless of the current payable balance. A Transporter
 * RECEIPT (direction DEBIT - recovering Delivery Charges from a
 * fully-paid vehicle) IS capped, against its own remaining recovery
 * only, via getPrivatePhonchDeliveryRecoveryState() above.
 */
export async function assertPrivatePhonchPaymentNotExceeded(
  tx: Tx,
  phonchId: string,
  counterAccountId: string,
  amount: number,
  direction: "DEBIT" | "CREDIT",
  excludeJournalEntryId?: string
): Promise<void> {
  if (direction === "DEBIT") {
    // A Delivery Recovery receipt is capped against its own remaining
    // recovery, whether it's owed by the Transporter OR a Clearing
    // Agent (see the vehicle-level deliveryRecoveryParty choice). A
    // Clearing Agent DEPOSIT (Case 11, unrelated to recovery) remains
    // deliberately uncapped for any account that has no recovery of
    // its own on this Private Phonch.
    const phonch = await tx.privatePhonch.findUnique({
      where: { id: phonchId },
      select: {
        transporterParty: { select: { account: { select: { id: true } } } },
        vehicles: {
          select: {
            totalRent: true,
            deliveryCharges: true,
            deliveryRecoveryParty: true,
            clearingAgentParty: { select: { account: { select: { id: true } } } },
          },
        },
      },
    });
    if (!phonch) return;
    const transporterAccountId = phonch.transporterParty.account?.id;

    let accountId: string;
    let totalRecovery: number;
    let recoveredByLabel: string;

    if (transporterAccountId && counterAccountId === transporterAccountId) {
      accountId = transporterAccountId;
      totalRecovery = round2(
        phonch.vehicles.reduce(
          (s, v) => s + (Number(v.totalRent) <= EPS && v.deliveryRecoveryParty !== "CLEARING_AGENT" ? Number(v.deliveryCharges) : 0),
          0
        )
      );
      recoveredByLabel = "Transporter";
    } else {
      accountId = counterAccountId;
      totalRecovery = round2(
        phonch.vehicles
          .filter(
            (v) => Number(v.totalRent) <= EPS && v.deliveryRecoveryParty === "CLEARING_AGENT" && v.clearingAgentParty?.account?.id === counterAccountId
          )
          .reduce((s, v) => s + Number(v.deliveryCharges), 0)
      );
      recoveredByLabel = "Clearing Agent's";
    }

    if (totalRecovery <= EPS) return;

    const state = await getPrivatePhonchDeliveryRecoveryState(tx, phonchId, accountId, totalRecovery, excludeJournalEntryId);

    if (state.isInconsistent) {
      throw new PrivatePhonchAccountingError(
        "PRIVATE_PHONCH_RECOVERY_INCONSISTENT",
        `This Private Phonch's recorded ${recoveredByLabel} recovery (${state.recoveredAmount}) already exceeds its Delivery Recovery (${state.totalRecovery}) - a data inconsistency. Resolve this before posting further receipts.`
      );
    }
    if (round2(state.recoveredAmount + amount) > state.totalRecovery + EPS) {
      throw new PrivatePhonchAccountingError(
        "PRIVATE_PHONCH_OVER_RECOVERY",
        `This receipt of ${round2(amount)} would exceed the ${recoveredByLabel} remaining Delivery Recovery (${state.remainingDue}) on this Private Phonch. Recovery = ${state.totalRecovery}, already received = ${state.recoveredAmount}.`
      );
    }
    return;
  }

  // direction is the MAIN account's own direction, per Daily
  // Posting's existing convention - CREDIT means the main account
  // (Cash/Bank) pays OUT money, debiting the counter (payable)
  // account - i.e. a payment TO them.
  const phonch = await tx.privatePhonch.findUnique({
    where: { id: phonchId },
    select: {
      transporterPartyId: true,
      transporterParty: { select: { account: { select: { id: true } } } },
      vehicles: { select: { clearingAgentPartyId: true, totalRent: true, deliveryCharges: true, carrierPayable: true } },
    },
  });
  if (!phonch) return;

  const transporterAccountId = phonch.transporterParty.account?.id;
  const isTransporter = !!(transporterAccountId && counterAccountId === transporterAccountId);
  let totalPayable: number;

  if (isTransporter) {
    totalPayable = round2(phonch.vehicles.reduce((s, v) => s + Number(v.carrierPayable), 0));
  } else {
    // Sum CA Payable across every vehicle row whose Clearing Agent's
    // OWN account is the one being paid - resolved by account id
    // (fetched once, batched) rather than assuming counterAccountId
    // IS a partyId.
    const caPartyIds = [...new Set(phonch.vehicles.map((v) => v.clearingAgentPartyId).filter((id): id is string => !!id))];
    if (caPartyIds.length === 0) return; // nothing to cap against - not this Phonch's payable at all
    const caAccounts = await tx.party.findMany({
      where: { id: { in: caPartyIds } },
      select: { id: true, account: { select: { id: true } } },
    });
    const matchingPartyIds = caAccounts.filter((p) => p.account?.id === counterAccountId).map((p) => p.id);
    if (matchingPartyIds.length === 0) return; // not a party of this Phonch at all - not this guard's concern

    totalPayable = round2(
      phonch.vehicles
        .filter((v) => v.clearingAgentPartyId && matchingPartyIds.includes(v.clearingAgentPartyId))
        .reduce((s, v) => s + Math.max(0, round2(Number(v.totalRent) - Number(v.deliveryCharges) - Number(v.carrierPayable))), 0)
    );
  }

  const state = await getPrivatePhonchPaymentState(tx, phonchId, counterAccountId, totalPayable, excludeJournalEntryId, isTransporter);

  if (state.isInconsistent) {
    throw new PrivatePhonchAccountingError(
      "PRIVATE_PHONCH_PAYMENT_INCONSISTENT",
      `This Private Phonch's recorded payment (${state.paidAmount}) already exceeds its payable (${state.totalPayable}) to this account - a data inconsistency. Resolve this before posting further payments.`
    );
  }

  if (round2(state.paidAmount + amount) > state.totalPayable + EPS) {
    throw new PrivatePhonchAccountingError(
      "PRIVATE_PHONCH_OVER_PAYMENT",
      `This payment of ${round2(amount)} would exceed this account's remaining payable (${state.remainingDue}) on this Private Phonch. Payable = ${state.totalPayable}, already paid = ${state.paidAmount}.`
    );
  }
}
