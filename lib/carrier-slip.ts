import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// CARRIER SLIP (Phase 1) - see prisma/schema.prisma's own module
// comment for the full design rationale.
//
// PHASE 1 SCOPE (explicit, so nothing here is overclaimed):
//  - CarrierSlipCollection/CarrierSlipExpense are a plain operational
//    record of what happened on a trip - amount, who/how collected,
//    which expense account, payment treatment. They are NOT YET real
//    JournalEntry postings. Driver Cash carry-forward below is
//    therefore computed from this STORED data, not from the ledger -
//    Phase 2 replaces this with a real Account-balance read (see
//    lib/own-carrier.ts's own Driver Cash Account) once Collection/
//    Expense entries actually post to it. Every UI surface showing
//    this figure must say so (e.g. "operational, not yet GL-posted").
//  - Vendor Khata payable creation/Daily Posting wiring is Phase 3.
//  - Return Load is Phase 3.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export class CarrierSlipError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CarrierSlipError";
    this.code = code;
  }
}

/**
 * The core safety guard (Q2 of the design confirmation): a Challan
 * already responsible to an EXTERNAL Transporter for Carrier Rent
 * (transporterPartyId set) must never also be linked to an Own
 * Carrier Slip - that Carrier Rent already belongs to a real external
 * payable (lib/settlement-payments.ts); treating the SAME figure as
 * this own vehicle's own profit input would double-count it. Also
 * rejects a Challan already linked to a DIFFERENT slip (defense in
 * depth - the DB's own @unique([linkedChallanId]) catches this too,
 * but this gives a clear, friendly error before that race is ever hit).
 */
export async function validateChallanLinkEligible(
  tx: Tx,
  challanId: string,
  excludeSlipId?: string
): Promise<{ carrierRent: number; totalBiltyRent: number; challanNo: string }> {
  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    select: {
      id: true,
      challanNo: true,
      isDeleted: true,
      transporterPartyId: true,
      carrierRent: true,
      carrierSlip: { select: { id: true } },
      bilties: { select: { bilty: { select: { total: true } } } },
    },
  });

  if (!challan || challan.isDeleted) {
    throw new CarrierSlipError("CHALLAN_NOT_FOUND", "Challan not found.");
  }

  if (challan.transporterPartyId) {
    throw new CarrierSlipError(
      "CHALLAN_HAS_EXTERNAL_TRANSPORTER",
      `Challan ${challan.challanNo} already has an external Transporter responsible for its Carrier Rent - it cannot also be linked to an Own Carrier Slip (that would double-count the same Carrier Rent as both an external payable and this vehicle's own profit figure).`
    );
  }

  if (challan.carrierSlip && challan.carrierSlip.id !== excludeSlipId) {
    throw new CarrierSlipError(
      "CHALLAN_ALREADY_LINKED",
      `Challan ${challan.challanNo} is already linked to another Carrier Slip.`
    );
  }

  const totalBiltyRent = challan.bilties.reduce((sum, cb) => sum + Number(cb.bilty.total), 0);

  return { carrierRent: Number(challan.carrierRent), totalBiltyRent, challanNo: challan.challanNo };
}

export async function validateBiltyLinkEligible(
  tx: Tx,
  biltyId: string,
  excludeSlipId?: string
): Promise<{ biltyNo: string; total: number }> {
  const bilty = await tx.bilty.findUnique({
    where: { id: biltyId },
    select: { id: true, biltyNo: true, total: true, isDeleted: true, carrierSlip: { select: { id: true } } },
  });

  if (!bilty || bilty.isDeleted) {
    throw new CarrierSlipError("BILTY_NOT_FOUND", "Bilty not found.");
  }

  if (bilty.carrierSlip && bilty.carrierSlip.id !== excludeSlipId) {
    throw new CarrierSlipError(
      "BILTY_ALREADY_LINKED",
      `Bilty ${bilty.biltyNo} is already linked to another Carrier Slip.`
    );
  }

  return { biltyNo: bilty.biltyNo, total: Number(bilty.total) };
}

export interface SlipFinancials {
  totalBiltyRent: number;
  carrierRent: number;
  officeCommission: number;
  totalExpenses: number;
  carrierProfit: number;
}

/**
 * Total Bilty Rent/Carrier Rent are NEVER read from the slip's own
 * manualTotalBiltyRent/manualCarrierRent columns when a Challan/Bilty
 * is linked - always re-fetched live here, exactly like every other
 * derived figure in this app (Bilty.toPay, PrivatePhonchVehicle's own
 * Net Rent, etc. - never trusted from a stored, independently-editable
 * column). The manual columns are read ONLY for a genuinely standalone
 * slip with no link at all.
 */
export async function computeSlipFinancials(
  tx: Tx,
  slip: {
    id: string;
    linkedChallanId: string | null;
    linkedBiltyId: string | null;
    manualTotalBiltyRent: Prisma.Decimal | number | null;
    manualCarrierRent: Prisma.Decimal | number | null;
  }
): Promise<SlipFinancials> {
  let totalBiltyRent = 0;
  let carrierRent = 0;

  if (slip.linkedChallanId) {
    const challan = await tx.challan.findUnique({
      where: { id: slip.linkedChallanId },
      select: { carrierRent: true, bilties: { select: { bilty: { select: { total: true } } } } },
    });
    if (challan) {
      carrierRent = Number(challan.carrierRent);
      totalBiltyRent = challan.bilties.reduce((sum, cb) => sum + Number(cb.bilty.total), 0);
    }
  } else if (slip.linkedBiltyId) {
    const bilty = await tx.bilty.findUnique({ where: { id: slip.linkedBiltyId }, select: { total: true } });
    if (bilty) totalBiltyRent = Number(bilty.total);
  } else {
    totalBiltyRent = Number(slip.manualTotalBiltyRent || 0);
    carrierRent = Number(slip.manualCarrierRent || 0);
  }

  const expenseRows = await tx.carrierSlipExpense.findMany({ where: { slipId: slip.id }, select: { amount: true } });
  const totalExpenses = expenseRows.reduce((sum, e) => sum + Number(e.amount), 0);

  return {
    totalBiltyRent,
    carrierRent,
    officeCommission: calcOfficeCommission(totalBiltyRent, carrierRent),
    totalExpenses,
    carrierProfit: calcCarrierProfit(carrierRent, totalExpenses),
  };
}

/** ANC Office Commission = Total Bilty Rent - Carrier Rent (locked formula) - kept
 * entirely separate from Carrier Profit below, never mixed into it. Exported as a pure
 * function purely so the formula itself is unit-testable without a database. */
export function calcOfficeCommission(totalBiltyRent: number, carrierRent: number): number {
  return totalBiltyRent - carrierRent;
}

/** Carrier Profit = Carrier Rent - Total Carrier Expenses (+ Return Load, deferred to
 * Phase 3 - see this file's own header comment). */
export function calcCarrierProfit(carrierRent: number, totalExpenses: number): number {
  return carrierRent - totalExpenses;
}

/** Locked Rules #5-7: only a collection actually received by the DRIVER, in CASH,
 * increases physical driver cash - never an Office collection, never Bank/Online. */
export function isDriverCashReceipt(collectedBy: CollectedBy, method: CollectionMethodValue): boolean {
  return collectedBy === "DRIVER" && method === "CASH";
}

/** Locked Rules #8-10: only a NAQAD (driver-paid-from-his-own-cash) expense reduces
 * driver cash - OFFICE_PAID and KHATA never do. */
export function isDriverPaidCashExpense(paymentType: PaymentTypeValue): boolean {
  return paymentType === "NAQAD";
}

type CollectedBy = "DRIVER" | "OFFICE";
type CollectionMethodValue = "CASH" | "BANK_ONLINE";
type PaymentTypeValue = "NAQAD" | "KHATA" | "OFFICE_PAID";

export interface DriverCashSummary {
  openingCash: number;
  driverCashReceived: number;
  driverPaidCashExpenses: number;
  closingCash: number;
}

/**
 * PHASE 1 ONLY - see this file's own header comment. Computed from
 * this carrier's own STORED CarrierSlipCollection/CarrierSlipExpense
 * rows across every one of its slips, ordered the same way the
 * carry-forward itself must be read (departureDate, then createdAt as
 * the tiebreak for same-day trips) - never from the real ledger yet,
 * since nothing here posts to it until Phase 2.
 *
 *   Closing = Opening + Driver Cash Received − Driver-Paid Cash Expenses
 *
 * Driver Cash Received only counts a collection where collectedBy ===
 * DRIVER and method === CASH (never an Office collection, never Bank/
 * Online - Locked Rules #5-7). Driver-Paid Cash Expenses only counts
 * an expense where paymentType === NAQAD (Locked Rules #8-10 - OFFICE_PAID
 * and KHATA never reduce driver cash). "Office cash advance" and "cash
 * deposited to office" are Phase 2 (real Daily Posting DIRECT postings
 * against this carrier's own Driver Cash account) - not yet reflected
 * here, since Phase 1 has no posting mechanism for them at all.
 */
export async function computeDriverCashCarryForward(tx: Tx, carrierId: string, uptoSlipId: string): Promise<DriverCashSummary> {
  const slips = await tx.carrierSlip.findMany({
    where: { carrierId, isDeleted: false },
    select: { id: true, departureDate: true, createdAt: true },
    orderBy: [{ departureDate: "asc" }, { createdAt: "asc" }],
  });

  let openingCash = 0;
  let thisSlipReceived = 0;
  let thisSlipPaid = 0;

  for (const s of slips) {
    const [collections, expenses] = await Promise.all([
      tx.carrierSlipCollection.findMany({ where: { slipId: s.id }, select: { amount: true, collectedBy: true, method: true } }),
      tx.carrierSlipExpense.findMany({ where: { slipId: s.id }, select: { amount: true, paymentType: true } }),
    ]);

    const received = collections
      .filter((c) => isDriverCashReceipt(c.collectedBy, c.method))
      .reduce((sum, c) => sum + Number(c.amount), 0);
    const paid = expenses
      .filter((e) => isDriverPaidCashExpense(e.paymentType))
      .reduce((sum, e) => sum + Number(e.amount), 0);

    if (s.id === uptoSlipId) {
      thisSlipReceived = received;
      thisSlipPaid = paid;
      break;
    }

    openingCash = openingCash + received - paid;
  }

  const closingCash = openingCash + thisSlipReceived - thisSlipPaid;

  return {
    openingCash,
    driverCashReceived: thisSlipReceived,
    driverPaidCashExpenses: thisSlipPaid,
    closingCash,
  };
}
