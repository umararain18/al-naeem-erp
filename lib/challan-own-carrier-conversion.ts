import type { Prisma, PrismaClient } from "@prisma/client";
import { getUnearnedRevenueAccountId } from "@/lib/gross-accounts";
import { getPartyNetFromSettlement } from "@/lib/settlement-correction";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// CONVERT A LEGACY (pre-Own-Carrier-module) CHALLAN TO OWN CARRIER
//
// Before the Own Carrier module existed, ANC's own fleet was dispatched
// like any external Transporter - via a real Party ("Al Naeem Cargo" or
// similar) set as Challan.transporterPartyId. That wrongly:
//  - recognized each dispatched Bilty's full rent as real Booking
//    Income (at BILTY_BOOKING time for a Bilty booked before the
//    Unearned Revenue feature existed, or at dispatch via
//    BILTY_REVENUE_RECOGNITION afterward - either way, instead of
//    deferring it to Trip close like a genuine own-carrier Challan);
//  - posted the Challan's Carrier Rent as a real expense + payable to
//    that Party (CHALLAN_DISPATCH/CHALLAN_DISPATCH_CORRECTION) - ANC
//    owing itself, inflating both Expense and a Payable that will
//    never actually be paid.
//
// Converting such a Challan must UNDO both effects with dated,
// `reversesEntryId`-linked reversal entries (never a silent soft-
// delete - the Challan keeps its full accounting history, visibly
// corrected) and then hand it over to the normal own-carrier model:
// ownCarrierId set, transporterPartyId cleared, carrierRent zeroed
// (the real figure moves to the linking Trip's CarrierTripDocument.
// carrierRentAmount, entered later - see Challan.ownCarrierId's own
// schema doc comment).
//
// Carrier Rent: a Challan's Carrier Rent may have been corrected one
// or more times (increases AND decreases) since dispatch - every live
// CHALLAN_DISPATCH/CHALLAN_DISPATCH_CORRECTION entry is reversed
// INDIVIDUALLY (its own lines, debit/credit swapped), which always
// nets correctly to the Challan's CURRENT carrierRent regardless of
// how many increases/decreases contributed - never an unsigned sum of
// entry magnitudes (see computeConversionImpact's own per-entry
// `amount`, signed off the CARRIER_RENT-category line).
//
// Booking Income: reversed as ONE net entry per Bilty - the Bilty's
// CURRENT net Booking Income (summed across every non-deleted line
// ever posted against it, from any source: a legacy direct booking
// credit, a dispatch-time recognition, or any correction since) is
// debited straight back to Unearned Revenue, `reversesEntryId`-linked
// only when exactly one source entry contributed (otherwise the net
// cannot be attributed to a single entry, but is still exactly
// correct).
//
// Deliberately conservative: a Challan that is currently SETTLED, or
// whose net Booking Income for some Bilty is negative or exceeds that
// Bilty's own total (an impossible/corrupt state to auto-reverse), is
// never auto-converted - computeConversionImpact reports it as
// blocked, for a human to resolve first, rather than guessing. Active
// Daily Posting payment rows (real cash already received/paid) are
// NOT a blocker - they are unaffected by which Transporter/Own
// Carrier the Challan is attributed to - and are reported as "kept".
// ============================================================

export class ChallanConversionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChallanConversionError";
    this.code = code;
  }
}

export const CHALLAN_DISPATCH_REFERENCE_TYPES = ["CHALLAN_DISPATCH", "CHALLAN_DISPATCH_CORRECTION"];
export const CHALLAN_OWN_CARRIER_CONVERSION_REVERSAL_REFERENCE_TYPE = "CHALLAN_OWN_CARRIER_CONVERSION_REVERSAL";

/** Uppercase, strip non-alphanumerics, then fix the one documented
 * transposition typo ("CMB191" <-> "CBM191") - letters swapped, not
 * genuinely different carrier numbers. Shared by the scan script and
 * the bulk convert script so a legacy Challan's mistyped
 * carrierNumber still matches the correctly-spelled Own Carrier. */
export function normalizeCarrierNumber(raw: string): string {
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return upper.replace(/^CMB(?=\d)/, "CBM");
}

export interface BookingIncomeSourceEntry {
  journalEntryId: string;
  referenceType: string | null;
  /** This entry's own signed contribution to the Bilty's net Booking Income (credit - debit on its own BOOKING_INCOME line(s)). */
  amount: number;
  entryDate: Date;
}

export interface BiltyRevenueImpact {
  biltyId: string;
  biltyNo: string;
  total: number;
  /** Currently sitting (net) in a BOOKING_INCOME-category account for this Bilty, from ANY source (legacy booking, dispatch recognition, corrections) - exactly what will be reversed back to Unearned Revenue. */
  currentBookingIncomeNet: number;
  /** Every live, non-deleted entry that contributed a BOOKING_INCOME line for this Bilty. */
  sourceEntries: BookingIncomeSourceEntry[];
  /** Negative, or greater than this Bilty's own total - an impossible/corrupt state; never auto-reversed. */
  needsManualReview: boolean;
}

export interface CarrierRentEntryImpact {
  journalEntryId: string;
  referenceType: string | null;
  /** This entry's own signed contribution to the Challan's current Carrier Rent (debit - credit on its own CARRIER_RENT-category line) - an increase correction is positive, a decrease correction is negative. */
  amount: number;
  entryDate: Date;
  description: string | null;
}

export interface ConversionImpact {
  challanId: string;
  challanNo: string;
  loadingDate: Date;
  status: string;
  isSettled: boolean;
  transporterPartyId: string | null;
  transporterPartyName: string | null;
  transporterAccountId: string | null;
  /** The Challan's own stored carrierRent field - should always equal totalCarrierRentToReverse's signed net. */
  challanCarrierRentField: number;
  carrierRentEntries: CarrierRentEntryImpact[];
  /** Signed net of every live carrierRentEntries amount - the Challan's CURRENT Carrier Rent, not an unsigned sum of entry magnitudes. */
  totalCarrierRentToReverse: number;
  /** See this field's own computation comment above - true only for
   * the pre-Gross-accounting-era direct-to-party dispatch pattern. */
  hasLegacyDirectPartyEntry: boolean;
  bilties: BiltyRevenueImpact[];
  /** Sum of every Bilty's currentBookingIncomeNet - the CURRENT total Booking Income that would move back to Unearned Revenue. */
  totalBookingIncomeToReverse: number;
  settlementEntriesPresent: boolean;
  /** Active Daily Posting payment rows against this Challan - real receipts, NEVER a blocker; reported as "kept", unaffected by this conversion. */
  activeSettlementPaymentCount: number;
  /** The Transporter Party's current net settlement position for this Challan (always 0 while isSettled is false - nothing has been reclassified to it yet). */
  ancPartyNetBalanceBefore: number | null;
  /** Always 0 once eligible and converted - the Transporter is fully cleared of this Challan's attribution. */
  ancPartyNetBalanceAfter: number | null;
  /** Human-readable reasons this Challan is NOT eligible for automatic conversion right now. Empty = eligible. */
  blockers: string[];
}

async function getActiveBookingIncomeAccountId(tx: Tx): Promise<string> {
  const account = await tx.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } });
  if (!account) {
    throw new ChallanConversionError("MISSING_BOOKING_INCOME_ACCOUNT", "Required account is not configured. Please configure a BOOKING_INCOME account.");
  }
  return account.id;
}

/**
 * Pure read - computes exactly what converting this Challan WOULD do,
 * without writing anything. Shared by the scan script, the bulk
 * script's --dry-run (and its --apply, to get the real amounts right
 * before posting), and the single-Challan "Convert to Own Carrier"
 * API route.
 */
export async function computeConversionImpact(tx: Tx, challanId: string): Promise<ConversionImpact> {
  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    include: {
      transporterParty: { select: { id: true, partyName: true, account: { select: { id: true } } } },
      bilties: { select: { bilty: { select: { id: true, biltyNo: true, total: true, isDeleted: true } } } },
    },
  });
  if (!challan) {
    throw new ChallanConversionError("CHALLAN_NOT_FOUND", "Challan not found");
  }

  const blockers: string[] = [];

  if (challan.isDeleted) blockers.push("Challan is in Bin");
  if (challan.ownCarrierId) blockers.push("Challan is already an Own Carrier dispatch");
  if (!challan.transporterPartyId) blockers.push("Challan has no Transporter Party to convert from");
  if (challan.isSettled) blockers.push("Challan is settled - Unsettle first");

  // ---- Carrier Rent: every live dispatch/correction entry, signed ----
  const carrierRentForwardEntries = await tx.journalEntry.findMany({
    where: { referenceType: { in: CHALLAN_DISPATCH_REFERENCE_TYPES }, referenceId: challanId, isDeleted: false },
    include: { lines: { include: { account: { select: { id: true, category: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const alreadyReversedIds = new Set(
    (
      await tx.journalEntry.findMany({
        where: { reversesEntryId: { in: carrierRentForwardEntries.map((e) => e.id) }, isDeleted: false },
        select: { reversesEntryId: true },
      })
    ).map((e) => e.reversesEntryId as string)
  );
  const liveCarrierRentEntries = carrierRentForwardEntries.filter((e) => !alreadyReversedIds.has(e.id));

  const carrierRentEntries: CarrierRentEntryImpact[] = liveCarrierRentEntries.map((e) => {
    // Signed net of THIS entry's own CARRIER_RENT-category line(s) -
    // an increase correction's Carrier Rent line is debited (positive
    // contribution); a decrease correction's is credited (negative
    // contribution) - never the raw debit side of every line, which
    // would double-count the matching Gross/clearing line too and can
    // never go negative, hiding a reduction entirely (the exact bug
    // reported against Challan 6506/6402 in production).
    const amount = e.lines
      .filter((l) => l.account.category === "CARRIER_RENT")
      .reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    return {
      journalEntryId: e.id,
      referenceType: e.referenceType,
      amount,
      entryDate: e.entryDate,
      description: e.description,
    };
  });
  const totalCarrierRentToReverse = carrierRentEntries.reduce((s, e) => s + e.amount, 0);

  // True if any live dispatch/correction entry credited the
  // Transporter Party's own account DIRECTLY rather than the Gross
  // Carrier Rent Payable suspense account - the pre-Gross-accounting-
  // era dispatch pattern this module's own header describes. A
  // Challan with ONLY Gross-routed entries (the current, modern
  // pattern) is false here - its own carrierRent is already
  // correctly reversible via the generic Gross-targeted correction in
  // lib/settlement-correction.ts, and reversing those SAME entries a
  // SECOND time via this module's own entry-by-entry reversal would
  // double-count. Used by the Challan edit route (not just this
  // module's own dedicated conversion action) to decide whether a
  // Transporter -> Own Carrier transition needs this module's
  // reversal at all.
  const transporterAccountIdForLegacyCheck = challan.transporterParty?.account?.id ?? null;
  const hasLegacyDirectPartyEntry = transporterAccountIdForLegacyCheck
    ? liveCarrierRentEntries.some((e) =>
        e.lines.some((l) => l.accountId === transporterAccountIdForLegacyCheck && Number(l.credit) > 0.009)
      )
    : false;

  // ---- Booking Income: CURRENT net per Bilty, from ANY source ----
  const activeBilties = challan.bilties.filter((b) => !b.bilty.isDeleted).map((b) => b.bilty);

  const bilties: BiltyRevenueImpact[] = [];
  for (const bilty of activeBilties) {
    const incomeLines = await tx.journalLine.findMany({
      where: {
        sourceType: "BILTY",
        sourceId: bilty.id,
        journalEntry: { isDeleted: false },
        account: { category: "BOOKING_INCOME" },
      },
      select: { debit: true, credit: true, journalEntryId: true, journalEntry: { select: { referenceType: true, entryDate: true } } },
    });

    const byEntry = new Map<string, { referenceType: string | null; entryDate: Date; net: number }>();
    for (const line of incomeLines) {
      const existing = byEntry.get(line.journalEntryId) ?? { referenceType: line.journalEntry.referenceType, entryDate: line.journalEntry.entryDate, net: 0 };
      existing.net += Number(line.credit) - Number(line.debit);
      byEntry.set(line.journalEntryId, existing);
    }
    const sourceEntries: BookingIncomeSourceEntry[] = Array.from(byEntry.entries()).map(([journalEntryId, v]) => ({
      journalEntryId,
      referenceType: v.referenceType,
      amount: v.net,
      entryDate: v.entryDate,
    }));
    const currentBookingIncomeNet = sourceEntries.reduce((s, e) => s + e.amount, 0);

    const total = Number(bilty.total);
    const needsManualReview = currentBookingIncomeNet < -0.01 || currentBookingIncomeNet > total + 0.01;
    if (needsManualReview) {
      blockers.push(`Bilty ${bilty.biltyNo}: Booking Income (Rs. ${currentBookingIncomeNet}) is negative or exceeds its own total (Rs. ${total}) - needs manual review`);
    }

    bilties.push({
      biltyId: bilty.id,
      biltyNo: bilty.biltyNo,
      total,
      currentBookingIncomeNet,
      sourceEntries,
      needsManualReview,
    });
  }
  const totalBookingIncomeToReverse = bilties.reduce((s, b) => s + b.currentBookingIncomeNet, 0);

  // ---- Active Daily Posting payments - informational only, never a blocker ----
  const activeSettlementPaymentCount = await tx.settlementPayment.count({
    where: { challanId, isActive: true },
  });

  const settlementEntriesPresent =
    (await tx.journalEntry.count({
      where: {
        referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] },
        referenceId: challanId,
        isDeleted: false,
      },
    })) > 0;

  const transporterAccountId = challan.transporterParty?.account?.id ?? null;
  const ancPartyNetBalanceBefore = transporterAccountId
    ? await getPartyNetFromSettlement(tx, challanId, transporterAccountId)
    : null;

  return {
    challanId: challan.id,
    challanNo: challan.challanNo,
    loadingDate: challan.loadingDate,
    status: challan.status,
    isSettled: challan.isSettled,
    transporterPartyId: challan.transporterPartyId,
    transporterPartyName: challan.transporterParty?.partyName ?? null,
    transporterAccountId,
    challanCarrierRentField: Number(challan.carrierRent),
    carrierRentEntries,
    totalCarrierRentToReverse,
    hasLegacyDirectPartyEntry,
    bilties,
    totalBookingIncomeToReverse,
    settlementEntriesPresent,
    activeSettlementPaymentCount,
    ancPartyNetBalanceBefore,
    ancPartyNetBalanceAfter: transporterAccountId ? 0 : null,
    blockers,
  };
}

export interface ConvertResult {
  impact: ConversionImpact;
  carrierRentReversed: number;
  bookingIncomeReversed: number;
}

/**
 * Reverses every live Carrier Rent dispatch/correction entry
 * individually (dated each entry's own entryDate - already the
 * Challan date, see lib/settlement-correction.ts). Pure write, no
 * blocker check of its own - the caller (convertChallanToOwnCarrier,
 * or the Challan edit route's own Transporter -> Own Carrier
 * transition) must already have confirmed `impact.blockers` is
 * empty. Does NOT touch ownCarrierId/transporterPartyId/carrierRent,
 * and does NOT touch Booking Income (see
 * reverseLegacyBookingIncomeToUnearnedRevenue below, kept as a
 * SEPARATE function deliberately: the Challan edit route's own
 * "OWN CARRIER TRANSITION" block already reverses each still-linked
 * Bilty's MODERN (BILTY_REVENUE_RECOGNITION) Booking Income itself
 * whenever becomingOwnCarrier - calling both that AND this module's
 * own all-sources Booking Income reversal for the SAME Bilty would
 * double-reverse the modern portion. The edit route therefore calls
 * ONLY this Carrier-Rent-specific function; convertChallanToOwnCarrier
 * (the dedicated, standalone conversion action, where nothing else
 * touches Booking Income) calls both this AND that one.
 */
export async function reverseLegacyCarrierRentDispatchEntries(
  tx: Tx,
  impact: ConversionImpact,
  createdById: string
): Promise<number> {
  for (const entry of impact.carrierRentEntries) {
    const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: entry.journalEntryId }, include: { lines: true } });
    const description = `Own Carrier Conversion - ${impact.challanNo} - reversing: ${original.description}`;
    await tx.journalEntry.create({
      data: {
        entryDate: original.entryDate,
        referenceType: CHALLAN_OWN_CARRIER_CONVERSION_REVERSAL_REFERENCE_TYPE,
        referenceId: impact.challanId,
        reversesEntryId: original.id,
        description,
        createdById,
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            debit: Number(l.credit),
            credit: Number(l.debit),
            description,
            sourceType: l.sourceType,
            sourceId: l.sourceId,
            sourceNumber: l.sourceNumber,
          })),
        },
      },
    });
  }
  return impact.totalCarrierRentToReverse;
}

/** Posts ONE net Booking-Income-to-Unearned-Revenue reversal per
 * Bilty (dated the Challan's loadingDate), from ANY source (legacy
 * direct booking, modern dispatch recognition, or any correction
 * since - see ConversionImpact.bilties' own doc comment). See
 * reverseLegacyCarrierRentDispatchEntries's own doc comment above for
 * why this is kept separate and who may safely call it. */
export async function reverseLegacyBookingIncomeToUnearnedRevenue(
  tx: Tx,
  impact: ConversionImpact,
  createdById: string
): Promise<number> {
  if (!impact.bilties.some((b) => b.currentBookingIncomeNet > 0.009)) {
    return 0;
  }

  const [bookingIncomeAccountId, unearnedRevenueAccountId] = await Promise.all([
    getActiveBookingIncomeAccountId(tx),
    getUnearnedRevenueAccountId(tx),
  ]);

  for (const b of impact.bilties) {
    if (b.currentBookingIncomeNet <= 0.009) continue;
    const amount = b.currentBookingIncomeNet;
    const description = `Own Carrier Conversion - ${impact.challanNo} - Bilty ${b.biltyNo} Booking Income reversed to Unearned Revenue`;
    // reversesEntryId only when exactly ONE entry contributed this
    // Bilty's entire net - otherwise the net cannot be attributed to
    // a single source entry (still exactly correct; just not
    // individually linked).
    const reversesEntryId = b.sourceEntries.length === 1 ? b.sourceEntries[0].journalEntryId : undefined;

    await tx.journalEntry.create({
      data: {
        entryDate: impact.loadingDate,
        referenceType: CHALLAN_OWN_CARRIER_CONVERSION_REVERSAL_REFERENCE_TYPE,
        referenceId: impact.challanId,
        ...(reversesEntryId ? { reversesEntryId } : {}),
        description,
        createdById,
        lines: {
          create: [
            {
              accountId: bookingIncomeAccountId,
              debit: amount,
              credit: 0,
              description,
              sourceType: "BILTY",
              sourceId: b.biltyId,
              sourceNumber: b.biltyNo,
            },
            {
              accountId: unearnedRevenueAccountId,
              debit: 0,
              credit: amount,
              description,
              sourceType: "BILTY",
              sourceId: b.biltyId,
              sourceNumber: b.biltyNo,
            },
          ],
        },
      },
    });
  }

  return impact.totalBookingIncomeToReverse;
}

/**
 * Performs the actual conversion - reverses history via
 * reverseLegacyCarrierRentDispatchEntries() and
 * reverseLegacyBookingIncomeToUnearnedRevenue(), then clears
 * transporterPartyId, zeroes carrierRent, and sets ownCarrierId.
 * Throws ChallanConversionError (never writes anything) if
 * computeConversionImpact() reports any blocker.
 */
export async function convertChallanToOwnCarrier(
  tx: Tx,
  params: { challanId: string; ownCarrierId: string; createdById: string }
): Promise<ConvertResult> {
  const { challanId, ownCarrierId, createdById } = params;

  const carrier = await tx.ownCarrier.findUnique({ where: { id: ownCarrierId }, select: { id: true, isDeleted: true, isActive: true, carrierNumber: true } });
  if (!carrier || carrier.isDeleted || !carrier.isActive) {
    throw new ChallanConversionError("OWN_CARRIER_NOT_FOUND", "Selected Own Carrier was not found or is not active");
  }

  const impact = await computeConversionImpact(tx, challanId);
  if (impact.blockers.length > 0) {
    throw new ChallanConversionError("NOT_ELIGIBLE", impact.blockers.join("; "));
  }

  const carrierRentReversed = await reverseLegacyCarrierRentDispatchEntries(tx, impact, createdById);
  const bookingIncomeReversed = await reverseLegacyBookingIncomeToUnearnedRevenue(tx, impact, createdById);

  await tx.challan.update({
    where: { id: challanId },
    data: {
      ownCarrierId,
      transporterPartyId: null,
      carrierRent: 0,
      updatedById: createdById,
    },
  });

  return { impact, carrierRentReversed, bookingIncomeReversed };
}
