import type { Prisma, PrismaClient } from "@prisma/client";
import { reverseBiltyBookingIncome, BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE } from "@/lib/bilty-revenue-recognition";
import { getPartyNetFromSettlement } from "@/lib/settlement-correction";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// CONVERT A LEGACY (pre-Own-Carrier-module) CHALLAN TO OWN CARRIER
//
// Before the Own Carrier module existed, ANC's own fleet was dispatched
// like any external Transporter - via a real Party ("Al Naeem Cargo" or
// similar) set as Challan.transporterPartyId. That wrongly:
//  - recognized each dispatched Bilty's full rent as real Booking
//    Income immediately (BILTY_REVENUE_RECOGNITION), instead of
//    deferring it to Trip close like a genuine own-carrier Challan;
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
// Deliberately conservative: a Challan that is currently SETTLED, has
// any live Daily-Posting SettlementPayment row, or whose Bilty rent
// has been corrected AFTER dispatch (so the simple "reverse the latest
// recognition entry" shape no longer matches what is actually sitting
// in Booking Income) is never auto-converted - computeConversionImpact
// reports it as blocked, for a human to resolve first, rather than
// guessing.
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

export interface BiltyRevenueImpact {
  biltyId: string;
  biltyNo: string;
  total: number;
  /** Currently sitting (net) in a BOOKING_INCOME-category account for this Bilty, across every non-deleted line ever posted against it. */
  currentBookingIncomeNet: number;
  /** What reverseBiltyBookingIncome() would actually reverse - the latest live BILTY_REVENUE_RECOGNITION entry's own amount. */
  reversibleAmount: number;
  /** currentBookingIncomeNet !== reversibleAmount - something other than the plain recognition entry (e.g. a post-dispatch rent correction posted straight to Booking Income) is also sitting there; never auto-reversed. */
  needsManualReview: boolean;
}

export interface CarrierRentEntryImpact {
  journalEntryId: string;
  referenceType: string | null;
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
  carrierRentEntries: CarrierRentEntryImpact[];
  totalCarrierRentToReverse: number;
  bilties: BiltyRevenueImpact[];
  totalBookingIncomeToReverse: number;
  settlementEntriesPresent: boolean;
  activeSettlementPaymentCount: number;
  /** Only meaningful when settlementEntriesPresent (always false while isSettled is false, by construction - Unsettle fully reverses these). */
  ancPartyNetBalance: number | null;
  /** Human-readable reasons this Challan is NOT eligible for automatic conversion right now. Empty = eligible. */
  blockers: string[];
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

  const carrierRentForwardEntries = await tx.journalEntry.findMany({
    where: { referenceType: { in: CHALLAN_DISPATCH_REFERENCE_TYPES }, referenceId: challanId, isDeleted: false },
    include: { lines: true },
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

  const carrierRentEntries: CarrierRentEntryImpact[] = liveCarrierRentEntries.map((e) => ({
    journalEntryId: e.id,
    referenceType: e.referenceType,
    amount: e.lines.reduce((s, l) => s + Number(l.debit), 0),
    entryDate: e.entryDate,
    description: e.description,
  }));
  const totalCarrierRentToReverse = carrierRentEntries.reduce((s, e) => s + e.amount, 0);

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
      select: { debit: true, credit: true },
    });
    const currentBookingIncomeNet = incomeLines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);

    const latestRecognition = await tx.journalEntry.findFirst({
      where: { referenceType: BILTY_REVENUE_RECOGNITION_REFERENCE_TYPE, referenceId: bilty.id, isDeleted: false },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });
    const reversibleAmount = latestRecognition
      ? latestRecognition.lines.reduce((max, l) => Math.max(max, Number(l.credit)), 0)
      : 0;

    const needsManualReview = Math.abs(currentBookingIncomeNet - reversibleAmount) > 0.01;
    if (needsManualReview) {
      blockers.push(`Bilty ${bilty.biltyNo}: Booking Income (Rs. ${currentBookingIncomeNet}) does not match its plain dispatch recognition (Rs. ${reversibleAmount}) - a post-dispatch correction exists; needs manual review`);
    }

    bilties.push({
      biltyId: bilty.id,
      biltyNo: bilty.biltyNo,
      total: Number(bilty.total),
      currentBookingIncomeNet,
      reversibleAmount,
      needsManualReview,
    });
  }
  const totalBookingIncomeToReverse = bilties.reduce((s, b) => s + b.reversibleAmount, 0);

  const activeSettlementPaymentCount = await tx.settlementPayment.count({
    where: { challanId, isActive: true },
  });
  if (activeSettlementPaymentCount > 0) {
    blockers.push(`${activeSettlementPaymentCount} active Daily Posting payment row(s) exist against this Challan - resolve/reverse those first`);
  }

  const settlementEntriesPresent =
    (await tx.journalEntry.count({
      where: {
        referenceType: { in: ["SETTLEMENT", "SETTLEMENT_CORRECTION"] },
        referenceId: challanId,
        isDeleted: false,
      },
    })) > 0;

  const transporterAccountId = challan.transporterParty?.account?.id ?? null;
  const ancPartyNetBalance = transporterAccountId
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
    carrierRentEntries,
    totalCarrierRentToReverse,
    bilties,
    totalBookingIncomeToReverse,
    settlementEntriesPresent,
    activeSettlementPaymentCount,
    ancPartyNetBalance,
    blockers,
  };
}

export interface ConvertResult {
  impact: ConversionImpact;
  carrierRentReversed: number;
  bookingIncomeReversed: number;
}

/**
 * Performs the actual conversion - reverses every live Carrier Rent
 * dispatch entry and every Bilty's dispatch revenue recognition (both
 * dated the Challan's own loadingDate, `reversesEntryId`-linked),
 * clears transporterPartyId, zeroes carrierRent, and sets ownCarrierId.
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

  const reason = `Converted Challan ${impact.challanNo} from Transporter ${impact.transporterPartyName ?? ""} to Own Carrier ${carrier.carrierNumber}`;

  for (const entry of impact.carrierRentEntries) {
    const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: entry.journalEntryId }, include: { lines: true } });
    const description = `Own Carrier Conversion - ${impact.challanNo} - reversing: ${original.description}`;
    await tx.journalEntry.create({
      data: {
        entryDate: original.entryDate,
        referenceType: CHALLAN_OWN_CARRIER_CONVERSION_REVERSAL_REFERENCE_TYPE,
        referenceId: challanId,
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

  for (const b of impact.bilties) {
    if (b.reversibleAmount <= 0) continue;
    await reverseBiltyBookingIncome(
      tx,
      { id: b.biltyId, biltyNo: b.biltyNo },
      { entryDate: impact.loadingDate, reason, createdById }
    );
  }

  await tx.challan.update({
    where: { id: challanId },
    data: {
      ownCarrierId,
      transporterPartyId: null,
      carrierRent: 0,
      updatedById: createdById,
    },
  });

  return {
    impact,
    carrierRentReversed: impact.totalCarrierRentToReverse,
    bookingIncomeReversed: impact.totalBookingIncomeToReverse,
  };
}
