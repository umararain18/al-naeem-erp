import type { Prisma, PrismaClient } from "@prisma/client";
import {
  resolveDocumentPartyAccount,
  getChallanEligibleParties,
  getChallanEligiblePartyAccountIds,
  getBiltyLegitimatePartyAccountIds,
  getPhonchEligiblePartyAccountIds,
  getPrivatePhonchEligibleParties,
  getPrivatePhonchEligiblePartyAccountIds,
} from "@/lib/document-party-resolution";
import { assertPhonchReceiptNotExceeded } from "@/lib/phonch-accounting";
import { assertPrivatePhonchPaymentNotExceeded } from "@/lib/private-phonch-accounting";
import { getDriverCashBalance, getOrCreateCarrierProfitAccountId } from "@/lib/own-carrier";
import {
  getUnearnedRevenueAccountId,
  getGrossBiltyReceivableAccountId,
  getUnclaimedGrossBiltyReceivableAmountForCollection,
} from "@/lib/gross-accounts";
import { netIncome } from "@/lib/pnl";

// Expense category - set on EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT
// lines (never DRIVER_SALARY, which is its own lineType already and
// always implies category SALARY automatically - see
// postDriverSalaryLine). This is the ONE thing that still varies
// per-line now that every expense debits the same Carrier Profit
// account (see Account.ownCarrierIncomeId's own schema comment) -
// mirrors the Prisma-generated CarrierExpenseCategory enum exactly,
// minus SALARY.
export const EXPENSE_LINE_CATEGORIES = ["DIESEL", "TOLL", "KHANA", "MARAMMAT", "OTHER"] as const;
export type ExpenseLineCategory = (typeof EXPENSE_LINE_CATEGORIES)[number];

export function categoryLabel(category: string | null | undefined): string {
  switch (category) {
    case "DIESEL": return "Diesel";
    case "TOLL": return "Toll";
    case "KHANA": return "Khana";
    case "MARAMMAT": return "Marammat";
    case "SALARY": return "Salary";
    case "OTHER": return "Other";
    default: return "Expense";
  }
}

// ============================================================
// CARRIER TRIP - trip CRUD, document linking, and per-line posting.
// See prisma/schema.prisma's own module comment for the full design
// rationale (why one row = one JournalEntry, why linking never posts
// anything by itself, why COLLECTION reuses Daily Posting's own
// party-resolution rules directly rather than re-deriving them).
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export class CarrierTripError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CarrierTripError";
    this.code = code;
  }
}

export type CarrierTripDocumentType = "CHALLAN" | "PHONCH" | "PRIVATE_PHONCH";
const VALID_DOCUMENT_TYPES: CarrierTripDocumentType[] = ["CHALLAN", "PHONCH", "PRIVATE_PHONCH"];

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Convenience default only (like lib/payroll-accounting.ts's
 * nextEmployeeCode() / scripts' own suggestNextSlipNo precedent) -
 * the real concurrency guarantee is @@unique([carrierId, tripNo]),
 * caught as a Prisma P2002 by the creation route. Only numeric
 * existing tripNo values are considered (a carrier that has
 * renamed a trip to something non-numeric is never used to compute
 * the next suggestion, same "never guess past an ambiguous value"
 * discipline as the rest of this module) - defaults to "1" when
 * none exist. */
export async function suggestNextTripNo(tx: Tx, carrierId: string): Promise<string> {
  const trips = await tx.carrierTrip.findMany({
    where: { carrierId },
    select: { tripNo: true },
  });
  let max = 0;
  for (const t of trips) {
    const n = Number(t.tripNo);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

export interface CarrierTripLineTemplate {
  lineType: "EXPENSE_CASH" | "EXPENSE_OFFICE" | "EXPENSE_CREDIT" | "DRIVER_SALARY";
  category: string | null;
  vendorPartyId: string | null;
  vendorPartyName: string | null;
  officeAccountId: string | null;
  officeAccountName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  description: string | null;
  isDiesel: boolean;
  pumpPartyId: string | null;
  pumpPartyName: string | null;
}

/**
 * "Previous slip expenses as blank drafts" - the carrier's own most
 * recent OTHER Trip's recurring expense/salary lines (EXPENSE_CASH/
 * EXPENSE_OFFICE/EXPENSE_CREDIT/DRIVER_SALARY only - COLLECTION/
 * CASH_FROM_OFFICE/DEPOSIT_TO_OFFICE are one-off cash movements, never
 * a recurring pattern worth re-offering), as pure templates: every
 * field EXCEPT amount/liters/ratePerLiter, which the UI leaves blank
 * for the user to fill. A pure read - this never creates anything;
 * the resulting draft rows this feeds are UI-only state (localStorage)
 * until each is actually saved through the normal lines POST/PATCH
 * endpoints, so they can never create a JournalEntry by themselves.
 */
export async function getPreviousTripExpenseTemplates(
  tx: Tx,
  carrierId: string,
  currentTripId: string
): Promise<{ previousTripId: string; previousTripNo: string; templates: CarrierTripLineTemplate[] } | null> {
  const previousTrip = await tx.carrierTrip.findFirst({
    where: { carrierId, isDeleted: false, id: { not: currentTripId } },
    orderBy: [{ dateFrom: "desc" }, { createdAt: "desc" }],
    select: { id: true, tripNo: true },
  });
  if (!previousTrip) return null;

  const lines = await tx.carrierTripLine.findMany({
    where: { tripId: previousTrip.id, isDeleted: false, lineType: { in: ["EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY"] } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: {
      vendorParty: { select: { partyName: true } },
      officeAccount: { select: { accountName: true } },
      employee: { select: { name: true } },
      pumpParty: { select: { partyName: true } },
    },
  });

  const templates: CarrierTripLineTemplate[] = lines.map((l) => ({
    lineType: l.lineType as CarrierTripLineTemplate["lineType"],
    category: l.category,
    vendorPartyId: l.vendorPartyId,
    vendorPartyName: l.vendorParty?.partyName || null,
    officeAccountId: l.officeAccountId,
    officeAccountName: l.officeAccount?.accountName || null,
    employeeId: l.employeeId,
    employeeName: l.employee?.name || null,
    description: l.description,
    isDiesel: l.isDiesel,
    pumpPartyId: l.pumpPartyId,
    pumpPartyName: l.pumpParty?.partyName || null,
  }));

  return { previousTripId: previousTrip.id, previousTripNo: previousTrip.tripNo, templates };
}

async function assertDocumentExists(
  tx: Tx,
  documentType: CarrierTripDocumentType,
  documentId: string,
  /** CHALLAN only - the linking Trip's own carrierId. A Challan can
   * only ever be linked to a Trip belonging to the SAME Own Carrier it
   * was dispatched under (Challan.ownCarrierId) - this is what makes
   * CarrierTripDocument.carrierRentAmount/recognizeCarrierTripChallanIncome
   * unambiguous (see those functions' own doc comments). Phonch/
   * Private Phonch have no equivalent carrier FK, so no equivalent
   * restriction exists for them. */
  requireOwnCarrierId?: string
): Promise<{ label: string }> {
  if (documentType === "CHALLAN") {
    const challan = await tx.challan.findUnique({ where: { id: documentId }, select: { challanNo: true, isDeleted: true, ownCarrierId: true } });
    if (!challan || challan.isDeleted) throw new CarrierTripError("DOCUMENT_NOT_FOUND", "Challan not found.");
    if (requireOwnCarrierId && challan.ownCarrierId !== requireOwnCarrierId) {
      throw new CarrierTripError(
        "CHALLAN_NOT_OWN_CARRIER",
        `Challan ${challan.challanNo} is not dispatched under this Own Carrier - only this carrier's own Challans can be linked to its Trips.`
      );
    }
    return { label: `Challan ${challan.challanNo}` };
  }
  if (documentType === "PHONCH") {
    const phonch = await tx.phonch.findUnique({ where: { id: documentId }, select: { phonchNo: true, isDeleted: true } });
    if (!phonch || phonch.isDeleted) throw new CarrierTripError("DOCUMENT_NOT_FOUND", "Phonch not found.");
    return { label: `Phonch ${phonch.phonchNo}` };
  }
  const privatePhonch = await tx.privatePhonch.findUnique({ where: { id: documentId }, select: { phonchNo: true, isDeleted: true } });
  if (!privatePhonch || privatePhonch.isDeleted) throw new CarrierTripError("DOCUMENT_NOT_FOUND", "Private Phonch not found.");
  return { label: `Private Phonch ${privatePhonch.phonchNo}` };
}

export async function getTripOrThrow(tx: Tx, tripId: string) {
  const trip = await tx.carrierTrip.findUnique({
    where: { id: tripId },
    include: { carrier: { include: { driverCashAccount: true } } },
  });
  if (!trip || trip.isDeleted) {
    throw new CarrierTripError("TRIP_NOT_FOUND", "Trip not found.");
  }
  return trip;
}

/**
 * "Outstanding" for ONE linked document - a pure, read-only prefill
 * convenience for the Cash Book's quick-entry Collection row (never a
 * cap enforced at write time; the existing per-type assert* checks in
 * lib/phonch-accounting.ts / lib/private-phonch-accounting.ts remain
 * the only real validation, unchanged). Deliberately self-contained
 * rather than reusing those modules' own getPhonchPaymentState/
 * getPrivatePhonchPaymentState (which only see Daily Posting receipts,
 * not this Trip's own COLLECTION lines) or
 * getPrivatePhonchEligibleParties (a genuinely multi-party Clearing
 * Agent/Transporter split not worth replicating for a prefill):
 *   - CHALLAN: sum(bilty.toPay) across its Bilties - every COLLECTION
 *     ever posted against this exact document (any Trip, not just
 *     this one, since a document can only ever have one ACTIVE link
 *     at a time but may have been partly collected on an earlier one).
 *   - PHONCH: its own total (deliveryCharges + otherExpense + claim,
 *     the same figure the Phonch model's own total already is) minus
 *     every COLLECTION ever posted against it.
 *   - PRIVATE_PHONCH: not computed (returns null) - its Carrier
 *     Payable/Clearing Agent/Delivery Recovery split is genuinely
 *     multi-party; the quick-entry row leaves Amount blank for it
 *     rather than guess.
 * Never negative - a document already fully (or over-) collected
 * returns 0, not a sign-flipped figure.
 */
export async function getDocumentOutstandingAmount(
  tx: Tx,
  documentType: CarrierTripDocumentType,
  documentId: string
): Promise<number | null> {
  const collectedAgg = await tx.carrierTripLine.aggregate({
    where: { lineType: "COLLECTION", documentType, documentId, isDeleted: false },
    _sum: { amount: true },
  });
  const collected = round2(Number(collectedAgg._sum.amount || 0));

  if (documentType === "CHALLAN") {
    const bilties = await tx.challanBilty.findMany({ where: { challanId: documentId }, select: { bilty: { select: { toPay: true } } } });
    const total = round2(bilties.reduce((s, b) => s + Number(b.bilty.toPay), 0));
    return Math.max(0, round2(total - collected));
  }

  if (documentType === "PHONCH") {
    const phonch = await tx.phonch.findUnique({
      where: { id: documentId },
      select: { vehicles: { select: { deliveryCharges: true, otherExpenseAmount: true, claimAmount: true } } },
    });
    if (!phonch) return null;
    const total = round2(phonch.vehicles.reduce((s, v) => s + Number(v.deliveryCharges) + Number(v.otherExpenseAmount) + Number(v.claimAmount), 0));
    return Math.max(0, round2(total - collected));
  }

  return null;
}

/**
 * Links a Trip to an EXISTING Challan/Phonch/Private Phonch - a pure
 * tag, never a JournalEntry (see this module's own header comment).
 * Rejects when the Trip is CLOSED, the document doesn't exist, or the
 * document already has a currently-active link (pre-check here for a
 * clear message; the partial unique index in the migration is the
 * real, race-safe guarantee).
 */
export async function linkDocumentToTrip(
  tx: Tx,
  input: { tripId: string; documentType: CarrierTripDocumentType; documentId: string; linkedById: string }
) {
  if (!VALID_DOCUMENT_TYPES.includes(input.documentType)) {
    throw new CarrierTripError("INVALID_DOCUMENT_TYPE", "Only Challan, Phonch, and Private Phonch can be linked to a Trip.");
  }
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before linking a document.");
  }
  const { label } = await assertDocumentExists(tx, input.documentType, input.documentId, trip.carrierId);

  const activeLink = await tx.carrierTripDocument.findFirst({
    where: { documentType: input.documentType, documentId: input.documentId, unlinkedAt: null },
  });
  if (activeLink) {
    throw new CarrierTripError(
      "DOCUMENT_ALREADY_LINKED",
      activeLink.tripId === input.tripId
        ? `${label} is already linked to this Trip.`
        : `${label} is already linked to another Trip - unlink it there first.`
    );
  }

  return tx.carrierTripDocument.create({
    data: {
      tripId: input.tripId,
      documentType: input.documentType,
      documentId: input.documentId,
      linkedById: input.linkedById,
    },
  });
}

/** The carrier's own currently-OPEN Trip, most recent first - the
 * SAME "latest" ordering suggestNextTripNo/the Trip list already use
 * (dateFrom desc, createdAt desc tiebreak). Null when none is open. */
export async function getLatestOpenTrip(tx: Tx, carrierId: string) {
  return tx.carrierTrip.findFirst({
    where: { carrierId, isDeleted: false, status: "OPEN" },
    orderBy: [{ dateFrom: "desc" }, { createdAt: "desc" }],
  });
}

/**
 * Auto-links a freshly own-carrier Challan to its carrier's latest
 * OPEN Trip - called from app/api/challan/route.ts (create) and
 * app/api/challan/[id]/route.ts (edit, only on the unset -> set
 * transition) right after ownCarrierId is actually committed. A
 * no-op, never a thrown error, when there is no open Trip (the
 * Challan simply stays unlinked - the UI shows "Not linked - no open
 * Trip") or when the Challan is somehow already linked (should never
 * happen for a Challan that was not own-carrier a moment ago, but
 * this is a convenience auto-link, never worth failing the whole
 * Challan write over). Carrier Rent on the new link is deliberately
 * left at its schema default (0 / empty in the UI) - never prefilled.
 */
export async function autoLinkOwnCarrierChallan(
  tx: Tx,
  input: { challanId: string; ownCarrierId: string; linkedById: string }
): Promise<{ tripId: string; tripNo: string } | null> {
  const trip = await getLatestOpenTrip(tx, input.ownCarrierId);
  if (!trip) return null;

  try {
    await linkDocumentToTrip(tx, { tripId: trip.id, documentType: "CHALLAN", documentId: input.challanId, linkedById: input.linkedById });
    return { tripId: trip.id, tripNo: trip.tripNo };
  } catch (error) {
    if (error instanceof CarrierTripError) return null;
    throw error;
  }
}

export async function unlinkDocumentFromTrip(tx: Tx, input: { tripDocumentId: string; unlinkedById: string }) {
  const link = await tx.carrierTripDocument.findUnique({ where: { id: input.tripDocumentId }, include: { trip: true } });
  if (!link || link.unlinkedAt) {
    throw new CarrierTripError("LINK_NOT_FOUND", "This document link was not found or is already unlinked.");
  }
  if (link.trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before unlinking a document.");
  }
  return tx.carrierTripDocument.update({
    where: { id: input.tripDocumentId },
    data: { unlinkedAt: new Date(), unlinkedById: input.unlinkedById },
  });
}

/**
 * Edits the manually-entered Carrier Rent for one linked (own-carrier)
 * CHALLAN document - "editable until close" per this module's own
 * header comment: rejected once the owning Trip is CLOSED (reopen it
 * first, same as every other write here), and rejected for a
 * PHONCH/PRIVATE_PHONCH link or a CHALLAN link to a regular
 * (non-own-carrier) Challan, since carrierRentAmount is meaningless
 * for either (see CarrierTripDocument.carrierRentAmount's own schema
 * doc comment).
 */
export async function setCarrierRentOnLink(
  tx: Tx,
  input: { tripDocumentId: string; carrierRentAmount: number }
) {
  if (input.carrierRentAmount < 0) {
    throw new CarrierTripError("INVALID_AMOUNT", "Carrier Rent cannot be negative.");
  }
  const link = await tx.carrierTripDocument.findUnique({ where: { id: input.tripDocumentId }, include: { trip: true } });
  if (!link || link.unlinkedAt) {
    throw new CarrierTripError("LINK_NOT_FOUND", "This document link was not found or is already unlinked.");
  }
  if (link.trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before editing Carrier Rent.");
  }
  if (link.documentType !== "CHALLAN") {
    throw new CarrierTripError("NOT_A_CHALLAN", "Carrier Rent only applies to a linked Challan.");
  }
  const challan = await tx.challan.findUnique({ where: { id: link.documentId }, select: { ownCarrierId: true } });
  if (!challan || challan.ownCarrierId !== link.trip.carrierId) {
    throw new CarrierTripError("CHALLAN_NOT_OWN_CARRIER", "Carrier Rent only applies to this carrier's own-carrier Challan.");
  }

  return tx.carrierTripDocument.update({
    where: { id: input.tripDocumentId },
    data: { carrierRentAmount: input.carrierRentAmount },
  });
}

// ============================================================
// LINE POSTING - one CarrierTripLine = one real JournalEntry.
// referenceType "CARRIER_TRIP_LINE", referenceId = the Trip's own id
// (so "every posting for this Trip" is one indexed lookup) -
// deliberately the Trip's id, not the line's own id, since the line
// row does not exist yet at the point the JournalEntry is created
// (CarrierTripLine.journalEntryId is required, not nullable).
// ============================================================

export interface PostCollectionInput {
  tripId: string;
  date: Date;
  description?: string | null;
  amount: number;
  documentType: CarrierTripDocumentType;
  documentId: string;
  /** CHALLAN only - collect against ONE specific Bilty of the linked
   * Challan instead of the whole Challan. A Challan can have several
   * Bilties, each with its own To-Pay party - resolving one party for
   * the WHOLE Challan (the historical behavior below, still used when
   * this is omitted) is only ever unambiguous once the Challan is
   * fully settled into a single net party, which is why Trip Wasooli
   * against an own-carrier Challan with no settlement yet always
   * failed with "select the party explicitly" despite there being no
   * party selector - see postCollectionLine's own doc comment. The
   * caller posts ONE request per Bilty when splitting a collection
   * across several (never a combined multi-bilty request) - each
   * becomes its own CarrierTripLine/JournalEntry, tagged
   * sourceType:"BILTY"/sourceId:biltyId. */
  biltyId?: string;
  /** Required ONLY when resolution cannot resolve a single unambiguous
   * party (e.g. a Challan with more than one eligible Receivable
   * party, or a Bilty with several distinct Settlement payers already
   * recorded) - validated against that same document's own eligible-
   * party set, never accepted blindly. */
  counterAccountId?: string | null;
  createdById: string;
}

export interface BiltyCollectionState {
  biltyId: string;
  biltyNo: string;
  toPay: number;
  // null only when genuinely ambiguous (several distinct, disagreeing
  // Settlement payers already recorded for this Bilty) - the caller
  // must then require a manually-selected Counter Account, exactly
  // like the existing Challan-level flow already does for its own
  // ambiguous case.
  accountId: string | null;
  partyName: string | null;
  // Remaining amount currently collectible against `accountId` right
  // now (0 when accountId is null) - the EXACT SAME ceiling
  // postCollectionLine() itself enforces at write time
  // (assertBiltyCollectionNotExceeded below), read fresh here purely
  // for display/prefill in the Trip Wasooli Bilty picker.
  outstanding: number;
  // toPay - outstanding - informational only ("already received"),
  // never used to gate anything.
  received: number;
}

/**
 * Current Collection state for ONE Bilty, for Trip Wasooli's own
 * driver-collection purpose specifically - deliberately NOT the same
 * question as "who is this Bilty's Collection currently resolved to"
 * (resolveDocumentPartyAccount("BILTY", ...), used by Daily Posting
 * etc.), which resolves the WHOLE Bilty to a single Settlement payer
 * once ANY payer row exists for it (see getBiltyCollectionState's
 * prior implementation, kept only in git history) - that collapses a
 * CA's own partial settlement-payment slice and the Bilty's still-
 * genuinely-unclaimed remainder into one party, so a driver's own
 * in-person cash receipt for the UNCLAIMED remainder would wrongly
 * post as if received FROM the CA, clearing the CA's own liability
 * instead of reducing the real remainder (the exact bug a Trip
 * Wasooli/Settlement-Payment ordering test surfaced).
 *
 * The driver only ever physically collects cash the consignee pays
 * directly - never a transfer from a CA/third-party's own
 * reclassified slice - so the correct, unambiguous target for Trip
 * Wasooli is always Gross Bilty Receivable's own CURRENT unclaimed
 * balance for this Bilty (getUnclaimedGrossBiltyReceivableAmountForCollection,
 * the exact same ledger-true figure driving the Challan position's
 * "Receivable (To-Pay pending)" line) - never a specific party's
 * account. Once that balance is fully reclassified away (an old
 * single-payer CLEARING_AGENT settlement, or new-engine Settlement
 * Payment rows covering it in full) there is nothing left for the
 * driver to collect for this Bilty - accountId is null and
 * outstanding is 0, not an "ambiguous, pick a party" state (there is
 * no remaining ambiguity to resolve: there is simply nothing left).
 */
export async function getBiltyCollectionState(tx: Tx, biltyId: string): Promise<BiltyCollectionState> {
  const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { biltyNo: true, toPay: true, isDeleted: true } });
  if (!bilty || bilty.isDeleted) {
    throw new CarrierTripError("DOCUMENT_NOT_FOUND", "Bilty not found.");
  }
  const toPay = round2(Number(bilty.toPay));
  const outstanding = round2(await getUnclaimedGrossBiltyReceivableAmountForCollection(tx, biltyId));

  if (outstanding <= 0.009) {
    return { biltyId, biltyNo: bilty.biltyNo, toPay, accountId: null, partyName: null, outstanding: 0, received: toPay };
  }

  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);
  return { biltyId, biltyNo: bilty.biltyNo, toPay, accountId: grossAccountId, partyName: "Unallocated (To-Pay pending)", outstanding, received: round2(toPay - outstanding) };
}

/** Every Bilty of a linked Challan, in display order - the Trip
 * Wasooli UI's own "pick one Bilty or split across Bilties" picker.
 * Small, bounded N per call (one Challan's own Bilties) - never used
 * for a list page, so no batching concern the way
 * lib/challan-list-query.ts's own callers have. */
export async function getChallanBiltyCollectionBreakdown(tx: Tx, challanId: string): Promise<BiltyCollectionState[]> {
  const challan = await tx.challan.findUnique({
    where: { id: challanId },
    select: { isDeleted: true, bilties: { select: { biltyId: true }, orderBy: { addedAt: "asc" } } },
  });
  if (!challan || challan.isDeleted) {
    throw new CarrierTripError("DOCUMENT_NOT_FOUND", "Challan not found.");
  }
  const results: BiltyCollectionState[] = [];
  for (const cb of challan.bilties) {
    results.push(await getBiltyCollectionState(tx, cb.biltyId));
  }
  return results;
}

/** The ledger-true remaining amount for ONE Bilty's Collection against
 * ONE specific account, right now - debit minus credit across every
 * JournalLine ever tagged sourceType:"BILTY"/sourceId:biltyId on that
 * account, across every referenceType (the original Settlement
 * reclassification's own debit establishing a party's liability, any
 * correction/reassignment, and any later Daily-Posting/Trip-Wasooli
 * receipt crediting it back down) - capped at [0, toPay]. Works
 * identically whether `accountId` is a real Party's account or Gross
 * Bilty Receivable itself (the "nobody has claimed this yet" state),
 * since both are just sub-ledgers tagged the exact same way - see
 * lib/gross-accounts.ts's own getGrossBiltyReceivableNetBalance for
 * the identical pattern on the Gross side specifically. This is the
 * ONE ceiling both the Trip Wasooli picker's display (getBiltyCollectionState
 * above) and its write-time guard (assertBiltyCollectionNotExceeded
 * below) read - never two independently-maintained figures. */
async function getBiltyCollectionOutstanding(tx: Tx, biltyId: string, accountId: string, toPay: number): Promise<number> {
  const lines = await tx.journalLine.findMany({
    where: { accountId, sourceType: "BILTY", sourceId: biltyId },
    select: { debit: true, credit: true },
  });
  const net = lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
  return Math.max(0, Math.min(round2(toPay), round2(net)));
}

/** Rejects a Trip Wasooli Collection receipt that would exceed what
 * is genuinely still outstanding against the resolved account for
 * this Bilty - see getBiltyCollectionOutstanding's own doc comment.
 * Must be called with the SAME `tx` the write itself uses, so it is
 * re-checked against live, in-transaction state (mirrors every other
 * assert*NotExceeded in this codebase). */
async function assertBiltyCollectionNotExceeded(tx: Tx, biltyId: string, accountId: string, amount: number): Promise<void> {
  const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { toPay: true, biltyNo: true } });
  const toPay = round2(Number(bilty?.toPay || 0));
  const remaining = await getBiltyCollectionOutstanding(tx, biltyId, accountId, toPay);
  if (round2(amount) > remaining + 0.009) {
    throw new CarrierTripError(
      "OVER_COLLECTION",
      `This receipt of Rs. ${round2(amount).toLocaleString()} would exceed the remaining outstanding amount (Rs. ${remaining.toLocaleString()}) for ${
        bilty ? `Bilty ${bilty.biltyNo}` : "this Bilty"
      }'s Collection.`
    );
  }
}

export interface PostSimpleInput {
  tripId: string;
  date: Date;
  description?: string | null;
  amount: number;
  createdById: string;
}

/** Meaningful only when isDiesel is true - see CarrierTripLine.isDiesel's
 * own schema doc comment for why these are independent of the
 * existing vendorPartyId/description fields. */
export interface DieselFields {
  isDiesel?: boolean;
  liters?: number | null;
  ratePerLiter?: number | null;
  pumpPartyId?: string | null;
}

function dieselLineData(input: DieselFields): Pick<Prisma.CarrierTripLineUncheckedCreateInput, "isDiesel" | "liters" | "ratePerLiter" | "pumpPartyId"> {
  if (!input.isDiesel) return {};
  return {
    isDiesel: true,
    liters: input.liters ?? null,
    ratePerLiter: input.ratePerLiter ?? null,
    pumpPartyId: input.pumpPartyId || null,
  };
}

export interface PostExpenseInput extends PostSimpleInput, DieselFields {
  category: ExpenseLineCategory;
}

export interface PostExpenseCreditInput extends PostExpenseInput {
  vendorPartyId: string;
}

function assertValidExpenseCategory(category: string): ExpenseLineCategory {
  if (!EXPENSE_LINE_CATEGORIES.includes(category as ExpenseLineCategory)) {
    throw new CarrierTripError("INVALID_CATEGORY", "Invalid expense category.");
  }
  return category as ExpenseLineCategory;
}

export interface PostSalaryInput extends PostSimpleInput {
  employeeId: string;
}

export interface PostOfficeTransferInput extends PostSimpleInput {
  officeAccountId: string;
}

async function createTripLineEntry(
  tx: Tx,
  trip: { id: string; carrier: { driverCashAccount: { id: string } | null } },
  params: {
    description: string;
    date: Date;
    createdById: string;
    lines: { accountId: string; debit: number; credit: number; sourceType?: string | null; sourceId?: string | null; sourceNumber?: string | null }[];
  },
  lineData: Omit<Prisma.CarrierTripLineUncheckedCreateInput, "journalEntryId" | "tripId" | "createdById">
) {
  if (!trip.carrier.driverCashAccount) {
    throw new CarrierTripError("NO_DRIVER_CASH_ACCOUNT", "This carrier has no Driver Cash account - data inconsistency, contact support.");
  }

  const entry = await tx.journalEntry.create({
    data: {
      entryDate: params.date,
      referenceType: "CARRIER_TRIP_LINE",
      referenceId: trip.id,
      description: params.description,
      createdById: params.createdById,
      lines: { create: params.lines.map((l) => ({ ...l, description: params.description })) },
    },
  });

  return tx.carrierTripLine.create({
    data: {
      ...lineData,
      tripId: trip.id,
      journalEntryId: entry.id,
      createdById: params.createdById,
    },
  });
}

/** IN - driver/office collected against a linked document. Reuses
 * Daily Posting's own party-resolution/over-receipt rules directly
 * (lib/document-party-resolution.ts, lib/phonch-accounting.ts,
 * lib/private-phonch-accounting.ts) - never a second, independent
 * accounting path. Dr Driver Cash / Cr the resolved party. */
export async function postCollectionLine(tx: Tx, input: PostCollectionInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const activeLink = await tx.carrierTripDocument.findFirst({
    where: { tripId: input.tripId, documentType: input.documentType, documentId: input.documentId, unlinkedAt: null },
  });
  if (!activeLink) {
    throw new CarrierTripError("DOCUMENT_NOT_LINKED", "This document is not currently linked to this Trip.");
  }

  const { label } = await assertDocumentExists(tx, input.documentType, input.documentId);

  // ------------------------------------------------------------
  // CHALLAN + biltyId - see PostCollectionInput.biltyId's own doc
  // comment for why this exists as a dedicated branch: the LINK is
  // validated at the Challan level (just above, unchanged), but
  // resolution/posting happens entirely at the BILTY level - the real
  // economic unit for To-Pay - instead of trying to resolve ONE party
  // for every Bilty on the Challan combined.
  // ------------------------------------------------------------
  if (input.documentType === "CHALLAN" && input.biltyId) {
    const challanBilty = await tx.challanBilty.findFirst({
      where: { challanId: input.documentId, biltyId: input.biltyId },
      select: { bilty: { select: { biltyNo: true, isDeleted: true } } },
    });
    if (!challanBilty || challanBilty.bilty.isDeleted) {
      throw new CarrierTripError("DOCUMENT_NOT_FOUND", "This Bilty does not belong to the linked Challan.");
    }
    const biltyLabel = `Bilty ${challanBilty.bilty.biltyNo}`;

    let biltyCounterAccountId = input.counterAccountId || null;
    if (!biltyCounterAccountId) {
      // Always the Bilty's own CURRENT unclaimed Gross balance - never
      // the whole-Bilty single-payer resolver - see
      // getBiltyCollectionState's own doc comment above for why: a
      // driver's own cash receipt must reduce the genuinely-unclaimed
      // remainder, never a CA/third-party's own already-reclassified
      // slice, however that slice was established.
      const unclaimed = await getUnclaimedGrossBiltyReceivableAmountForCollection(tx, input.biltyId);
      biltyCounterAccountId = unclaimed > 0.009 ? await getGrossBiltyReceivableAccountId(tx) : null;
    } else {
      const eligible = await getBiltyLegitimatePartyAccountIds(input.biltyId, "DEBIT");
      if (!eligible.has(biltyCounterAccountId)) {
        throw new CarrierTripError("INVALID_COUNTER_ACCOUNT", `Selected account is not a valid Receivable party for ${biltyLabel}.`);
      }
    }
    if (!biltyCounterAccountId) {
      throw new CarrierTripError(
        "PARTY_REQUIRED",
        `${biltyLabel} has nothing left outstanding to collect - its To-Pay has already been fully assigned to a party or received.`
      );
    }

    await assertBiltyCollectionNotExceeded(tx, input.biltyId, biltyCounterAccountId, input.amount);

    const driverCashId = trip.carrier.driverCashAccount!.id;
    const description = input.description?.trim() || `Collected against ${label} - ${biltyLabel}`;

    return createTripLineEntry(
      tx,
      trip,
      {
        date: input.date,
        createdById: input.createdById,
        description,
        lines: [
          { accountId: driverCashId, debit: input.amount, credit: 0, sourceType: "BILTY", sourceId: input.biltyId },
          { accountId: biltyCounterAccountId, debit: 0, credit: input.amount, sourceType: "BILTY", sourceId: input.biltyId },
        ],
      },
      {
        lineType: "COLLECTION",
        date: input.date,
        description,
        amount: input.amount,
        documentType: input.documentType,
        documentId: input.documentId,
      }
    );
  }

  // DEBIT = the main account (Driver Cash) receives money - same
  // direction convention Daily Posting already uses.
  let counterAccountId = input.counterAccountId || null;
  if (!counterAccountId) {
    const resolved = await resolveDocumentPartyAccount(input.documentType, input.documentId, "DEBIT");
    counterAccountId = resolved?.accountId || null;
  } else {
    const eligible =
      input.documentType === "CHALLAN"
        ? await getChallanEligiblePartyAccountIds(input.documentId, "DEBIT")
        : input.documentType === "PRIVATE_PHONCH"
          ? await getPrivatePhonchEligiblePartyAccountIds(input.documentId, "DEBIT")
          : await getPhonchEligiblePartyAccountIds(input.documentId);
    if (!eligible.has(counterAccountId)) {
      throw new CarrierTripError("INVALID_COUNTER_ACCOUNT", `Selected account is not a valid Receivable party for ${label}.`);
    }
  }
  if (!counterAccountId) {
    throw new CarrierTripError(
      "PARTY_REQUIRED",
      `Could not automatically determine who ${label}'s collection belongs to - select the party explicitly.`
    );
  }

  if (input.documentType === "PHONCH") {
    await assertPhonchReceiptNotExceeded(tx, input.documentId, counterAccountId, input.amount, "DEBIT");
  }
  if (input.documentType === "PRIVATE_PHONCH") {
    await assertPrivatePhonchPaymentNotExceeded(tx, input.documentId, counterAccountId, input.amount, "DEBIT");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || `Collected against ${label}`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: driverCashId, debit: input.amount, credit: 0, sourceType: input.documentType, sourceId: input.documentId },
        { accountId: counterAccountId, debit: 0, credit: input.amount, sourceType: input.documentType, sourceId: input.documentId },
      ],
    },
    {
      lineType: "COLLECTION",
      date: input.date,
      description,
      amount: input.amount,
      documentType: input.documentType,
      documentId: input.documentId,
    }
  );
}

/** IN - office hands cash to the driver. Dr Driver Cash / Cr office account. */
export async function postCashFromOfficeLine(tx: Tx, input: PostOfficeTransferInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const officeAccount = await tx.account.findUnique({ where: { id: input.officeAccountId } });
  if (!officeAccount || !officeAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected office account was not found or is inactive.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || "Cash from office";

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: driverCashId, debit: input.amount, credit: 0 },
        { accountId: input.officeAccountId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "CASH_FROM_OFFICE", date: input.date, description, amount: input.amount, officeAccountId: input.officeAccountId }
  );
}

/** OUT - trip expense paid by the driver from Driver Cash. Dr this
 * carrier's own Carrier Profit account / Cr Driver Cash - every
 * expense/salary line debits the SAME account now (see
 * Account.ownCarrierIncomeId's own schema comment), so `category` is
 * what distinguishes a Diesel purchase from a Toll payment, never an
 * account picker. */
export async function postExpenseCashLine(tx: Tx, input: PostExpenseInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  const category = assertValidExpenseCategory(input.category);

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const carrierProfitAccountId = await getOrCreateCarrierProfitAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || categoryLabel(category);

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: carrierProfitAccountId, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "EXPENSE_CASH", date: input.date, description, amount: input.amount, category, ...dieselLineData(input) }
  );
}

/** OUT - trip expense (e.g. Diesel paid via an office account) charged
 * directly to an office Cash/Bank account. Dr Carrier Profit / Cr
 * office account. Never touches Driver Cash - same "payment source
 * never moves Driver Cash" rule as EXPENSE_CREDIT. */
export async function postExpenseOfficeLine(tx: Tx, input: PostExpenseInput & { officeAccountId: string }) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  const category = assertValidExpenseCategory(input.category);

  const officeAccount = await tx.account.findUnique({ where: { id: input.officeAccountId } });
  if (!officeAccount || !officeAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected office account was not found or is inactive.");
  }

  const carrierProfitAccountId = await getOrCreateCarrierProfitAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || `${categoryLabel(category)} (Office Account - ${officeAccount.accountName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: carrierProfitAccountId, debit: input.amount, credit: 0 },
        { accountId: input.officeAccountId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "EXPENSE_OFFICE", date: input.date, description, amount: input.amount, category, officeAccountId: input.officeAccountId, ...dieselLineData(input) }
  );
}

/** OUT - trip expense, Udhaar (credit) to a Vendor Party. Dr Carrier Profit / Cr Vendor. Never touches Driver Cash. */
export async function postExpenseCreditLine(tx: Tx, input: PostExpenseCreditInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  const category = assertValidExpenseCategory(input.category);

  const vendorParty = await tx.party.findUnique({ where: { id: input.vendorPartyId }, include: { account: true } });
  if (!vendorParty || !vendorParty.isActive || !vendorParty.account) {
    throw new CarrierTripError("INVALID_VENDOR", "Selected vendor party was not found or is inactive.");
  }

  const carrierProfitAccountId = await getOrCreateCarrierProfitAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || `${categoryLabel(category)} (Udhaar - ${vendorParty.partyName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: carrierProfitAccountId, debit: input.amount, credit: 0 },
        { accountId: vendorParty.account.id, debit: 0, credit: input.amount },
      ],
    },
    {
      lineType: "EXPENSE_CREDIT",
      date: input.date,
      description,
      amount: input.amount,
      category,
      vendorPartyId: input.vendorPartyId,
      ...dieselLineData(input),
    }
  );
}

/** OUT - driver salary is a carrier expense now (never a Payslip/
 * employee-account posting): Dr this carrier's own Carrier Profit
 * account / Cr Driver Cash. No "employee must have a linked account"
 * requirement any more - the Employee row only needs to exist and not
 * be binned, since salary no longer touches that employee's own
 * account at all. category is always "SALARY" - not user-supplied,
 * since DRIVER_SALARY is its own distinct lineType already. */
export async function postDriverSalaryLine(tx: Tx, input: PostSalaryInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const employee = await tx.employee.findUnique({ where: { id: input.employeeId } });
  if (!employee || employee.isDeleted) {
    throw new CarrierTripError("INVALID_EMPLOYEE", "Selected employee was not found.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const carrierProfitAccountId = await getOrCreateCarrierProfitAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || `Salary paid to ${employee.name}`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: carrierProfitAccountId, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "DRIVER_SALARY", date: input.date, description, amount: input.amount, employeeId: input.employeeId, category: "SALARY" }
  );
}

/** OUT - driver hands cash back to office/bank. Dr office account / Cr Driver Cash. */
export async function postDepositToOfficeLine(tx: Tx, input: PostOfficeTransferInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const officeAccount = await tx.account.findUnique({ where: { id: input.officeAccountId } });
  if (!officeAccount || !officeAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected office account was not found or is inactive.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || `Deposit to ${officeAccount.accountName}`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: input.officeAccountId, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "DEPOSIT_TO_OFFICE", date: input.date, description, amount: input.amount, officeAccountId: input.officeAccountId }
  );
}

export const TRIP_LINE_TYPES = ["COLLECTION", "CASH_FROM_OFFICE", "EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY", "DEPOSIT_TO_OFFICE"] as const;
export type TripLineType = (typeof TRIP_LINE_TYPES)[number];

/**
 * Single type-dispatch shared by the create route
 * (app/api/own-carrier/[id]/trips/[tripId]/lines/route.ts POST) and
 * the edit-via-reverse-and-repost route (that same directory's
 * [lineId]/route.ts PATCH) - both need the EXACT same "which
 * type-specific fields does this lineType require" logic, and this
 * is the one place it is written. `rawInput` is the raw request body
 * (or an existing line's own saved fields, re-shaped the same way) -
 * only the fields relevant to `lineType` are read from it.
 */
function dieselFieldsFromRawInput(rawInput: Record<string, unknown>): DieselFields {
  if (!rawInput.isDiesel) return {};
  return {
    isDiesel: true,
    liters: rawInput.liters != null ? Number(rawInput.liters) : null,
    ratePerLiter: rawInput.ratePerLiter != null ? Number(rawInput.ratePerLiter) : null,
    pumpPartyId: (rawInput.pumpPartyId as string) || null,
  };
}

function toYMD(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** null when `date` is within [dateFrom, dateTo] (dateTo open-ended
 * if null, i.e. an OPEN trip never warns on its own upper bound) -
 * otherwise a human message naming which bound it misses. Exported
 * so the Trip-edit flow (PATCH .../trips/[tripId]) can run the exact
 * same check in the opposite direction (existing lines/documents
 * against a NEW proposed range) without a second implementation. */
export function tripDateRangeWarning(trip: { tripNo: string; dateFrom: Date; dateTo: Date | null }, date: Date): string | null {
  if (date.getTime() < trip.dateFrom.getTime()) {
    return `This date (${toYMD(date)}) is before Trip ${trip.tripNo}'s own start date (${toYMD(trip.dateFrom)}).`;
  }
  if (trip.dateTo && date.getTime() > trip.dateTo.getTime()) {
    return `This date (${toYMD(date)}) is after Trip ${trip.tripNo}'s own end date (${toYMD(trip.dateTo)}).`;
  }
  return null;
}

/** HARD block (never overridable) on a future-dated line - compared
 * at day resolution against today, so "today" itself always passes. */
function assertLineDateNotFuture(date: Date): void {
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (date.getTime() > todayEnd.getTime()) {
    throw new CarrierTripError("FUTURE_DATE", `This line's date (${toYMD(date)}) is in the future - it cannot be later than today.`);
  }
}

/**
 * Shared date validation for every Trip line write (create via
 * postTripLineByType, and edit via editCarrierTripLine - which calls
 * back into postTripLineByType for its replacement line, so this one
 * call site covers both). Future-dated is always rejected outright;
 * outside the Trip's own [dateFrom, dateTo] range is a WARNING only -
 * rejected UNLESS the caller already confirmed it (rawInput.
 * confirmOutsideRange), mirroring the existing "confirmDuplicate"
 * pattern in app/api/daily-posting/route.ts.
 */
async function assertLineDateValid(tx: Tx, tripId: string, date: Date, rawInput: Record<string, unknown>): Promise<void> {
  assertLineDateNotFuture(date);
  const trip = await tx.carrierTrip.findUnique({ where: { id: tripId }, select: { tripNo: true, dateFrom: true, dateTo: true } });
  if (!trip) return; // getTripOrThrow (called right after, by every post*Line function) reports the real "not found" error.
  const warning = tripDateRangeWarning(trip, date);
  if (warning && !rawInput.confirmOutsideRange) {
    throw new CarrierTripError("OUTSIDE_TRIP_RANGE", `${warning} Continue anyway?`);
  }
}

export async function postTripLineByType(
  tx: Tx,
  lineType: TripLineType,
  base: { tripId: string; date: Date; description: string | null; amount: number; createdById: string },
  rawInput: Record<string, unknown>
) {
  await assertLineDateValid(tx, base.tripId, base.date, rawInput);

  switch (lineType) {
    case "COLLECTION": {
      const documentType = rawInput.documentType as CarrierTripDocumentType;
      if (!rawInput.documentId || !documentType) {
        throw new CarrierTripError("MISSING_DOCUMENT", "A linked document is required for a Collection line.");
      }
      return postCollectionLine(tx, {
        ...base,
        documentType,
        documentId: rawInput.documentId as string,
        biltyId: (rawInput.biltyId as string) || undefined,
        counterAccountId: (rawInput.counterAccountId as string) || null,
      });
    }
    case "CASH_FROM_OFFICE":
      if (!rawInput.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
      return postCashFromOfficeLine(tx, { ...base, officeAccountId: rawInput.officeAccountId as string });
    case "DEPOSIT_TO_OFFICE":
      if (!rawInput.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
      return postDepositToOfficeLine(tx, { ...base, officeAccountId: rawInput.officeAccountId as string });
    case "EXPENSE_CASH":
      if (!rawInput.category) throw new CarrierTripError("MISSING_CATEGORY", "Expense category is required.");
      return postExpenseCashLine(tx, { ...base, category: rawInput.category as ExpenseLineCategory, ...dieselFieldsFromRawInput(rawInput) });
    case "EXPENSE_OFFICE":
      if (!rawInput.category) throw new CarrierTripError("MISSING_CATEGORY", "Expense category is required.");
      if (!rawInput.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
      return postExpenseOfficeLine(tx, { ...base, category: rawInput.category as ExpenseLineCategory, officeAccountId: rawInput.officeAccountId as string, ...dieselFieldsFromRawInput(rawInput) });
    case "EXPENSE_CREDIT":
      if (!rawInput.category) throw new CarrierTripError("MISSING_CATEGORY", "Expense category is required.");
      if (!rawInput.vendorPartyId) throw new CarrierTripError("MISSING_VENDOR", "Vendor party is required for a credit expense.");
      return postExpenseCreditLine(tx, { ...base, category: rawInput.category as ExpenseLineCategory, vendorPartyId: rawInput.vendorPartyId as string, ...dieselFieldsFromRawInput(rawInput) });
    case "DRIVER_SALARY":
      if (!rawInput.employeeId) throw new CarrierTripError("MISSING_EMPLOYEE", "Employee is required for a salary line.");
      return postDriverSalaryLine(tx, { ...base, employeeId: rawInput.employeeId as string });
    default:
      throw new CarrierTripError("INVALID_LINE_TYPE", "Invalid line type.");
  }
}

/**
 * Edits a line "in place" from the UI's point of view - under the
 * hood this is NEVER a mutation of the existing row: it reverses the
 * existing line (reverseCarrierTripLine - same reversesEntryId
 * mechanism as every other correction in this schema) and posts a
 * brand new one via postTripLineByType, in ONE transaction, so there
 * is never a moment with neither line live. The lineType itself is
 * NOT editable this way (the new line must be the SAME type as the
 * one being replaced) - switching types is a delete-and-recreate the
 * UI does explicitly, never an implicit side effect of an edit.
 */
export async function editCarrierTripLine(
  tx: Tx,
  input: {
    lineId: string;
    deletedById: string;
    reason?: string;
    date: Date;
    description: string | null;
    amount: number;
    rawInput: Record<string, unknown>;
  }
) {
  const existing = await tx.carrierTripLine.findUnique({ where: { id: input.lineId }, select: { tripId: true, lineType: true, isDeleted: true } });
  if (!existing || existing.isDeleted) {
    throw new CarrierTripError("LINE_NOT_FOUND", "This line was not found or is already reversed.");
  }

  await reverseCarrierTripLine(tx, { lineId: input.lineId, deletedById: input.deletedById, reason: input.reason || "edited" });

  return postTripLineByType(
    tx,
    existing.lineType as TripLineType,
    { tripId: existing.tripId, date: input.date, description: input.description, amount: input.amount, createdById: input.deletedById },
    input.rawInput
  );
}

/**
 * Reverses one CarrierTripLine - NEVER edits/deletes its JournalEntry;
 * posts a NEW entry with reversesEntryId pointing at it (same
 * mechanism lib/challan-lifecycle.ts's Unsettle already uses) and
 * flips CarrierTripLine.isDeleted. Blocked once the owning Trip is
 * CLOSED (reopen it first), same as every other write here.
 */
export async function reverseCarrierTripLine(tx: Tx, input: { lineId: string; deletedById: string; reason?: string }) {
  const line = await tx.carrierTripLine.findUnique({
    where: { id: input.lineId },
    include: { journalEntry: { include: { lines: true } }, trip: true },
  });
  if (!line || line.isDeleted) {
    throw new CarrierTripError("LINE_NOT_FOUND", "This line was not found or is already reversed.");
  }
  if (line.trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before reversing a line.");
  }

  const existingReversal = await tx.journalEntry.findFirst({ where: { reversesEntryId: line.journalEntryId, isDeleted: false } });
  if (existingReversal) {
    throw new CarrierTripError("ALREADY_REVERSED", "This line has already been reversed.");
  }

  const description = `Reversed - ${line.description || line.lineType} (${input.reason?.trim() || "removed"})`;

  await tx.journalEntry.create({
    data: {
      // The ORIGINAL line's own date, never "today" - a reversal is a
      // correction of an entry that happened on ITS OWN date, not a
      // new event happening today. Dating it today would misstate
      // Driver Cash's balance on every day between the original date
      // and today (see getTripOpeningBalance's own date-scoped
      // reasoning above - a reversal dated wrong is exactly the kind
      // of "later activity leaking into an earlier Previous Balance"
      // this fix is closing the other half of).
      entryDate: line.journalEntry.entryDate,
      referenceType: "CARRIER_TRIP_LINE_REVERSAL",
      referenceId: line.tripId,
      reversesEntryId: line.journalEntryId,
      description,
      createdById: input.deletedById,
      lines: {
        create: line.journalEntry.lines.map((l) => ({
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

  return tx.carrierTripLine.update({
    where: { id: input.lineId },
    data: { isDeleted: true, deletedAt: new Date(), deletedById: input.deletedById },
  });
}

// ============================================================
// TRIP CLOSE INCOME RECOGNITION - see Challan.ownCarrierId's own
// schema doc comment for the full rationale. An own-carrier Challan's
// Bilty rent sits untouched in Unearned Revenue from booking all the
// way through dispatch; closing the Trip that links it is the ONE
// moment its income is finally recognized, split between real
// Booking Income and this carrier's own "Carrier Profit" account by the
// manually-entered CarrierTripDocument.carrierRentAmount.
//
// referenceType "CARRIER_TRIP_CLOSE", referenceId = the CHALLAN's own
// id (never the Trip's or the link's) - a Challan can only ever have
// ONE currently-active Trip link at a time (the partial unique index
// on CarrierTripDocument), so this is always unambiguous, exactly
// like lib/bilty-revenue-recognition.ts's own per-Bilty scoping -
// even across an unlink -> relink-to-a-later-Trip cycle (only
// possible while OPEN; see unlinkDocumentFromTrip), since at most one
// recognition is ever live for a given Challan at once.
// ============================================================

export const CARRIER_TRIP_CLOSE_REFERENCE_TYPE = "CARRIER_TRIP_CLOSE";
export const CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE = "CARRIER_TRIP_CLOSE_REVERSAL";

// Net count idiom - see lib/bilty-revenue-recognition.ts's own
// getRecognitionNet() for why NET (recognitions - reversals) is
// required rather than a plain existence check: a Challan can
// legitimately cycle through recognize (close) -> reverse (reopen) ->
// recognize (re-close) more than once.
async function getChallanCloseRecognitionNet(tx: Tx, challanId: string): Promise<number> {
  const [recognizedCount, reversedCount] = await Promise.all([
    tx.journalEntry.count({ where: { referenceType: CARRIER_TRIP_CLOSE_REFERENCE_TYPE, referenceId: challanId, isDeleted: false } }),
    tx.journalEntry.count({ where: { referenceType: CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE, referenceId: challanId, isDeleted: false } }),
  ]);
  return recognizedCount - reversedCount;
}

/** True if this own-carrier Challan's income is CURRENTLY recognized
 * (i.e. some Trip holding it has been closed, and not since reopened
 * without a later re-close) - read by app/api/challan/[id]/route.ts
 * and the Challan list to show "Income pending (Trip slip not
 * closed)" before this is true. */
export async function isCarrierTripChallanIncomeRecognized(tx: Tx, challanId: string): Promise<boolean> {
  return (await getChallanCloseRecognitionNet(tx, challanId)) > 0;
}

async function getActiveBookingIncomeAccountId(tx: Tx): Promise<string> {
  const account = await tx.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } });
  if (!account) {
    throw new CarrierTripError("MISSING_BOOKING_INCOME_ACCOUNT", "Required account is not configured. Please configure a BOOKING_INCOME account.");
  }
  return account.id;
}

/**
 * Recognizes ONE linked own-carrier Challan's income at Trip CLOSE:
 * Dr Unearned Revenue (this Challan's total Bilty rent) / Cr Booking
 * Income (Bilty rent - Carrier Rent) / Cr this carrier's own Own
 * Carrier Income account (Carrier Rent). A no-op (returns false) if
 * already recognized (net > 0, see getChallanCloseRecognitionNet), if
 * the Challan is not actually an own-carrier Challan, or if its total
 * Bilty rent is 0 - mirrors recognizeBiltyBookingIncome()'s own
 * idempotency exactly. If Carrier Rent happens to exceed Bilty rent
 * (a loss-making dispatch), Booking Income is debited instead of
 * credited for the shortfall, rather than silently clamping it away.
 */
export async function recognizeCarrierTripChallanIncome(
  tx: Tx,
  input: { tripDocumentId: string; entryDate: Date; tripNo: string; createdById: string }
): Promise<boolean> {
  const link = await tx.carrierTripDocument.findUnique({ where: { id: input.tripDocumentId }, include: { trip: true } });
  if (!link || link.documentType !== "CHALLAN") return false;

  const challan = await tx.challan.findUnique({ where: { id: link.documentId }, select: { id: true, challanNo: true, ownCarrierId: true } });
  if (!challan || !challan.ownCarrierId || challan.ownCarrierId !== link.trip.carrierId) return false;

  if ((await getChallanCloseRecognitionNet(tx, challan.id)) > 0) return false;

  const bilties = await tx.challanBilty.findMany({ where: { challanId: challan.id }, select: { bilty: { select: { total: true } } } });
  const biltyRentTotal = round2(bilties.reduce((s, b) => s + Number(b.bilty.total), 0));
  if (biltyRentTotal <= 0) return false;

  const carrierRentAmount = round2(Math.max(0, Number(link.carrierRentAmount)));
  const bookingIncomeAmount = round2(biltyRentTotal - carrierRentAmount);

  const [unearnedRevenueAccountId, bookingIncomeAccountId, carrierProfitAccountId] = await Promise.all([
    getUnearnedRevenueAccountId(tx),
    getActiveBookingIncomeAccountId(tx),
    getOrCreateCarrierProfitAccountId(tx, link.trip.carrierId),
  ]);

  const description = `Trip ${input.tripNo} closed - Challan ${challan.challanNo} income recognized (Bilty Rent ${biltyRentTotal}, Carrier Rent ${carrierRentAmount})`;

  const lines: { accountId: string; debit: number; credit: number; sourceType: string; sourceId: string; sourceNumber: string }[] = [
    { accountId: unearnedRevenueAccountId, debit: biltyRentTotal, credit: 0, sourceType: "CHALLAN", sourceId: challan.id, sourceNumber: challan.challanNo },
  ];
  if (bookingIncomeAmount >= 0) {
    lines.push({ accountId: bookingIncomeAccountId, debit: 0, credit: bookingIncomeAmount, sourceType: "CHALLAN", sourceId: challan.id, sourceNumber: challan.challanNo });
  } else {
    lines.push({ accountId: bookingIncomeAccountId, debit: -bookingIncomeAmount, credit: 0, sourceType: "CHALLAN", sourceId: challan.id, sourceNumber: challan.challanNo });
  }
  if (carrierRentAmount > 0) {
    lines.push({ accountId: carrierProfitAccountId, debit: 0, credit: carrierRentAmount, sourceType: "CHALLAN", sourceId: challan.id, sourceNumber: challan.challanNo });
  }

  await tx.journalEntry.create({
    data: {
      entryDate: input.entryDate,
      referenceType: CARRIER_TRIP_CLOSE_REFERENCE_TYPE,
      referenceId: challan.id,
      description,
      createdById: input.createdById,
      lines: { create: lines.map((l) => ({ ...l, description })) },
    },
  });

  return true;
}

/**
 * The exact reverse of recognizeCarrierTripChallanIncome() - called
 * when a Trip holding a recognized own-carrier Challan is reopened.
 * A no-op (returns false) if nothing is currently recognized for this
 * Challan.
 */
export async function reverseCarrierTripChallanIncome(
  tx: Tx,
  input: { challanId: string; entryDate: Date; reason: string; createdById: string }
): Promise<boolean> {
  if ((await getChallanCloseRecognitionNet(tx, input.challanId)) <= 0) return false;

  const entry = await tx.journalEntry.findFirst({
    where: { referenceType: CARRIER_TRIP_CLOSE_REFERENCE_TYPE, referenceId: input.challanId, isDeleted: false },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });
  if (!entry) return false;

  const description = `Trip reopened - ${input.reason} - reversing: ${entry.description}`;

  await tx.journalEntry.create({
    data: {
      entryDate: input.entryDate,
      referenceType: CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE,
      referenceId: input.challanId,
      reversesEntryId: entry.id,
      description,
      createdById: input.createdById,
      lines: {
        create: entry.lines.map((l) => ({
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

  return true;
}

/**
 * Orchestrates Trip CLOSE: sets status CLOSED (auto-filling dateTo
 * with today if the user never set one - Close never blocks on a
 * missing end date), then recognizes income for every currently
 * ACTIVE (unlinkedAt: null) CHALLAN link on this Trip, dated the
 * Trip's own end date.
 */
export async function closeCarrierTrip(tx: Tx, input: { tripId: string; updatedById: string }) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status === "CLOSED") {
    throw new CarrierTripError("ALREADY_CLOSED", "This Trip is already closed.");
  }

  const dateTo = trip.dateTo ?? new Date();

  const updated = await tx.carrierTrip.update({
    where: { id: input.tripId },
    data: { status: "CLOSED", dateTo, updatedById: input.updatedById },
  });

  const challanLinks = await tx.carrierTripDocument.findMany({
    where: { tripId: input.tripId, documentType: "CHALLAN", unlinkedAt: null },
  });

  for (const link of challanLinks) {
    await recognizeCarrierTripChallanIncome(tx, {
      tripDocumentId: link.id,
      entryDate: dateTo,
      tripNo: trip.tripNo,
      createdById: input.updatedById,
    });
  }

  return updated;
}

/**
 * Orchestrates Trip REOPEN: reverses income recognition for every
 * currently ACTIVE CHALLAN link on this Trip (safe no-op for any
 * Challan that was never actually recognized - e.g. zero Bilty rent),
 * then sets status back to OPEN.
 */
export async function reopenCarrierTrip(tx: Tx, input: { tripId: string; updatedById: string; reason?: string }) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status === "OPEN") {
    throw new CarrierTripError("ALREADY_OPEN", "This Trip is already open.");
  }

  const challanLinks = await tx.carrierTripDocument.findMany({
    where: { tripId: input.tripId, documentType: "CHALLAN", unlinkedAt: null },
  });

  const reason = input.reason?.trim() || `Trip ${trip.tripNo} reopened`;

  for (const link of challanLinks) {
    await reverseCarrierTripChallanIncome(tx, {
      challanId: link.documentId,
      entryDate: new Date(),
      reason,
      createdById: input.updatedById,
    });
  }

  return tx.carrierTrip.update({
    where: { id: input.tripId },
    data: { status: "OPEN", updatedById: input.updatedById },
  });
}

/**
 * Validates a proposed Trip.dateFrom/dateTo change - called from
 * PATCH /api/own-carrier/[id]/trips/[tripId] BEFORE the actual
 * update, never from inside it, since this never touches any
 * JournalEntry (editing a Trip's own dates is purely a record edit -
 * see this function's own callers for why Previous Balance then
 * simply recalculates on its next read, from getTripOpeningBalance
 * reading the Trip's own, now-updated, dateFrom).
 *
 * `blocked` (always rejected, no override) covers:
 *  - dateFrom after dateTo.
 * `warnings` (rejected UNLESS the caller already confirmed) covers:
 *  - an existing line, or a linked document's own date (Challan.
 *    loadingDate / Phonch.date / PrivatePhonch.date), that would fall
 *    outside the NEW range.
 *  - the new range overlapping another (non-deleted) Trip of the
 *    SAME carrier - an open-ended Trip (dateTo null) is treated as
 *    ongoing through "today" for this comparison, mirroring
 *    getTripCashBook's own "ongoing through today" treatment of an
 *    open Trip's own missing end date.
 */
export async function validateTripDateRangeChange(
  tx: Tx,
  input: { tripId: string; carrierId: string; newDateFrom: Date; newDateTo: Date | null }
): Promise<{ blocked: string | null; warnings: string[] }> {
  const { tripId, carrierId, newDateFrom, newDateTo } = input;

  if (newDateTo && newDateFrom.getTime() > newDateTo.getTime()) {
    return { blocked: "Start date cannot be after end date.", warnings: [] };
  }

  const warnings: string[] = [];
  const rangeEnd = newDateTo ?? new Date();

  const lines = await tx.carrierTripLine.findMany({
    where: { tripId, isDeleted: false },
    select: { date: true, description: true, lineType: true },
  });
  const linesOutside = lines.filter((l) => l.date.getTime() < newDateFrom.getTime() || l.date.getTime() > rangeEnd.getTime());
  if (linesOutside.length > 0) {
    warnings.push(
      `${linesOutside.length} existing line(s) (e.g. ${linesOutside[0].description || linesOutside[0].lineType} on ${toYMD(linesOutside[0].date)}) would fall outside the new date range.`
    );
  }

  const docs = await tx.carrierTripDocument.findMany({ where: { tripId, unlinkedAt: null } });
  for (const doc of docs) {
    let docDate: Date | null = null;
    let label = `${doc.documentType} ${doc.documentId}`;
    if (doc.documentType === "CHALLAN") {
      const d = await tx.challan.findUnique({ where: { id: doc.documentId }, select: { challanNo: true, loadingDate: true } });
      if (d) { docDate = d.loadingDate; label = `Challan ${d.challanNo}`; }
    } else if (doc.documentType === "PHONCH") {
      const d = await tx.phonch.findUnique({ where: { id: doc.documentId }, select: { phonchNo: true, date: true } });
      if (d) { docDate = d.date; label = `Phonch ${d.phonchNo}`; }
    } else if (doc.documentType === "PRIVATE_PHONCH") {
      const d = await tx.privatePhonch.findUnique({ where: { id: doc.documentId }, select: { phonchNo: true, date: true } });
      if (d) { docDate = d.date; label = `Private Phonch ${d.phonchNo}`; }
    }
    if (docDate && (docDate.getTime() < newDateFrom.getTime() || docDate.getTime() > rangeEnd.getTime())) {
      warnings.push(`Linked ${label} is dated ${toYMD(docDate)}, outside the new date range.`);
    }
  }

  const otherTrips = await tx.carrierTrip.findMany({
    where: { carrierId, isDeleted: false, id: { not: tripId } },
    select: { tripNo: true, dateFrom: true, dateTo: true },
  });
  for (const other of otherTrips) {
    const otherEnd = other.dateTo ?? new Date();
    const overlaps = newDateFrom.getTime() <= otherEnd.getTime() && other.dateFrom.getTime() <= rangeEnd.getTime();
    if (overlaps) {
      warnings.push(`The new range overlaps Trip ${other.tripNo} (${toYMD(other.dateFrom)} - ${other.dateTo ? toYMD(other.dateTo) : "ongoing"}).`);
    }
  }

  return { blocked: null, warnings };
}

// ============================================================
// READ - Trip Cash Book + Trip Profit Report. Pure reads, nothing
// here is ever stored - always derived live from CarrierTripLine +
// the real ledger, same philosophy as lib/challan-position.ts.
// ============================================================

export interface TripCashBookRow {
  id: string;
  date: string;
  lineType: string;
  description: string;
  in: number;
  out: number;
  balance: number;
  documentType: string | null;
  documentId: string | null;
  // Type-specific fields, exposed only so the Cash Book's inline Edit
  // can re-populate a line's own original fields without a second
  // fetch - every write path still only ever reads these from
  // CarrierTripLine itself via lib/carrier-trip.ts's own post*Line
  // functions, never from this read-only row shape.
  category: string | null;
  officeAccountId: string | null;
  vendorPartyId: string | null;
  employeeId: string | null;
  // Diesel structured fields (CarrierTripLine.isDiesel's own schema
  // doc comment) - isDiesel is the real flag the Diesel box/total and
  // the Profit Report filter by, never a "Diesel - ..." description
  // prefix.
  isDiesel: boolean;
  liters: number | null;
  ratePerLiter: number | null;
  pumpPartyId: string | null;
  pumpPartyName: string | null;
  // "TRIP_LINE" for a real CarrierTripLine (editable/reversible via
  // this Trip's own line endpoints) vs "EXTERNAL" for a Driver Cash
  // JournalLine from any OTHER source (Daily Posting, a direct
  // Journal Entry, etc.) dated within this Trip's own date range -
  // shown for visibility/reconciliation only, never editable or
  // reversible from this page. See getTripCashBook's own doc comment.
  source: "TRIP_LINE" | "EXTERNAL";
}

/** EXPENSE_CREDIT/EXPENSE_OFFICE never move Driver Cash (neither is a
 * cash event for THIS account - Udhaar to a Vendor, or a direct office
 * account payment) - shown in the Out column for visibility, same as
 * the approved UI sketch, but excluded from the running balance.
 * Exported so lib/carrier-trip-summary.ts's own computeTripSummaryBar
 * (the Trip page's summary bar) can be tested directly against this,
 * the real source of truth, rather than a second reimplementation
 * that could silently drift from it. */
export function cashDelta(lineType: string, amount: number): number {
  if (lineType === "COLLECTION" || lineType === "CASH_FROM_OFFICE") return amount;
  if (lineType === "EXPENSE_CASH" || lineType === "DRIVER_SALARY" || lineType === "DEPOSIT_TO_OFFICE") return -amount;
  return 0; // EXPENSE_CREDIT / EXPENSE_OFFICE
}

/** Driver Cash's own ledger-true balance AS OF the moment just before
 * `dateFrom` - the sum (debit - credit) of EVERY JournalLine ever
 * posted to this account (any source: an earlier Trip's own lines,
 * Daily Posting, a direct Journal Entry, the account's own opening-
 * balance entry) whose JournalEntry.entryDate is strictly before
 * `dateFrom`. This is the account's own "opening balance" (there is
 * no separate Account.openingBalance column - an opening balance is
 * itself just an early JournalLine, already included here) plus
 * every earlier line, nothing more and nothing less.
 *
 * Previously this instead computed the account's CURRENT (as-of-now)
 * balance minus this Trip's own net cash effect, which silently
 * pulled in anything dated AFTER this Trip - later Trips' own lines,
 * later corrections/reversals, later Daily Posting receipts - into a
 * "Previous Balance" that should only ever reflect what came before.
 * Driver Cash never resets between Trips, so a strictly date-scoped
 * balance is what "Previous Balance" has always meant; it was simply
 * computed wrong. Shared by getTripCashBook (its own "Opening
 * Balance" row) and getTripProfitReport (its own "Previous Balance"
 * stat). */
async function getTripOpeningBalance(tx: Tx, dateFrom: Date, driverCashAccountId: string): Promise<number> {
  const result = await tx.journalLine.aggregate({
    where: { accountId: driverCashAccountId, journalEntry: { isDeleted: false, entryDate: { lt: dateFrom } } },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(result._sum.debit || 0);
  const credit = Number(result._sum.credit || 0);
  return round2(debit - credit);
}

// referenceTypes this module itself ever posts to Driver Cash under -
// excluded from the "external" scan below so another source's lines
// are never confused with this Trip's own (already shown via `lines`
// above) or another Trip's own (deliberately never borrowed into
// THIS Trip's cash book - each Trip only ever shows its own lines
// plus genuinely external activity in its own date range).
const TRIP_LINE_REFERENCE_TYPES = ["CARRIER_TRIP_LINE", "CARRIER_TRIP_LINE_REVERSAL"];

export async function getTripCashBook(tx: Tx, tripId: string): Promise<{ openingBalance: number; rows: TripCashBookRow[]; closingBalance: number }> {
  const trip = await getTripOrThrow(tx, tripId);
  const driverCashAccountId = trip.carrier.driverCashAccount?.id;
  if (!driverCashAccountId) {
    throw new CarrierTripError("NO_DRIVER_CASH_ACCOUNT", "This carrier has no Driver Cash account - data inconsistency, contact support.");
  }
  const lines = await tx.carrierTripLine.findMany({
    where: { tripId, isDeleted: false },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: { pumpParty: { select: { partyName: true } } },
  });

  const openingBalance = await getTripOpeningBalance(tx, trip.dateFrom, driverCashAccountId);

  // Driver Cash activity from any OTHER source (Daily Posting, a
  // direct Journal Entry, etc.) dated within THIS Trip's own date
  // range - shown for visibility/reconciliation (e.g. a driver
  // "Peshki" receipt posted directly via Daily Posting instead of
  // Trip Wasooli) even though it was never a CarrierTripLine. An
  // OPEN trip (no dateTo yet) scans through today - the same
  // "ongoing through today" assumption closeCarrierTrip() itself
  // makes when auto-filling dateTo.
  const rangeEnd = trip.dateTo ?? new Date();
  const externalLines = await tx.journalLine.findMany({
    where: {
      accountId: driverCashAccountId,
      journalEntry: {
        isDeleted: false,
        referenceType: { notIn: TRIP_LINE_REFERENCE_TYPES },
        entryDate: { gte: trip.dateFrom, lte: rangeEnd },
      },
    },
    include: { journalEntry: { select: { entryDate: true, description: true, referenceType: true } } },
    orderBy: { journalEntry: { entryDate: "asc" } },
  });

  type MergedRow = { date: Date; createdAt: Date; delta: number; build: (balance: number) => TripCashBookRow };

  const merged: MergedRow[] = [
    ...lines.map((l) => ({
      date: l.date,
      createdAt: l.createdAt,
      // The REAL cash effect - 0 for EXPENSE_CREDIT/EXPENSE_OFFICE
      // even though their `out` is still shown for visibility (see
      // cashDelta's own doc comment) - never derived from the
      // displayed in/out below, which would wrongly pull those two
      // line types into the running balance.
      delta: cashDelta(l.lineType, Number(l.amount)),
      build: (balance: number): TripCashBookRow => {
        const amount = Number(l.amount);
        return {
          id: l.id,
          date: l.date.toISOString(),
          lineType: l.lineType,
          description: l.description || l.lineType,
          in: cashDelta(l.lineType, amount) > 0 ? amount : l.lineType === "COLLECTION" || l.lineType === "CASH_FROM_OFFICE" ? amount : 0,
          out: cashDelta(l.lineType, amount) < 0 || l.lineType === "EXPENSE_CREDIT" || l.lineType === "EXPENSE_OFFICE" ? amount : 0,
          balance,
          documentType: l.documentType,
          documentId: l.documentId,
          category: l.category,
          officeAccountId: l.officeAccountId,
          vendorPartyId: l.vendorPartyId,
          employeeId: l.employeeId,
          isDiesel: l.isDiesel,
          liters: l.liters != null ? Number(l.liters) : null,
          ratePerLiter: l.ratePerLiter != null ? Number(l.ratePerLiter) : null,
          pumpPartyId: l.pumpPartyId,
          pumpPartyName: l.pumpParty?.partyName || null,
          source: "TRIP_LINE",
        };
      },
    })),
    ...externalLines.map((jl) => {
      const net = round2(Number(jl.debit) - Number(jl.credit));
      const entryDate = jl.journalEntry.entryDate;
      return {
        date: entryDate,
        createdAt: entryDate,
        delta: net,
        build: (balance: number): TripCashBookRow => ({
          id: jl.id,
          date: entryDate.toISOString(),
          lineType: "DAILY_POSTING",
          description: jl.journalEntry.description || jl.description || "Daily Posting",
          in: net > 0 ? net : 0,
          out: net < 0 ? -net : 0,
          balance,
          documentType: jl.sourceType || null,
          documentId: jl.sourceId || null,
          category: null,
          officeAccountId: null,
          vendorPartyId: null,
          employeeId: null,
          isDiesel: false,
          liters: null,
          ratePerLiter: null,
          pumpPartyId: null,
          pumpPartyName: null,
          source: "EXTERNAL",
        }),
      };
    }),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime());

  let balance = openingBalance;
  const rows: TripCashBookRow[] = merged.map((m) => {
    balance = round2(balance + m.delta);
    return m.build(balance);
  });

  return { openingBalance, rows, closingBalance: balance };
}

export interface TripProfitReport {
  previousBalance: number;
  /** Per linked own-carrier Challan: its own total Bilty rent, the
   * manually-entered Carrier Rent, and Booking Income = the two
   * subtracted. Empty for a Trip with no own-carrier Challan linked. */
  challanIncome: { documentId: string; label: string; biltyRent: number; carrierRent: number; bookingIncome: number }[];
  /** Non-Challan linked documents' own income figure (Phonch/Private
   * Phonch) - unrelated to the Challan income-deferral mechanism
   * above, kept as its own simple read exactly as before. */
  otherIncome: { documentType: string; documentId: string; label: string; amount: number }[];
  totalBiltyRent: number;
  totalCarrierRent: number;
  totalBookingIncome: number;
  /** diesel (whichever of EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT
   * it was paid through) + every other EXPENSE_CASH/EXPENSE_OFFICE/
   * EXPENSE_CREDIT + DRIVER_SALARY line - every real cost of running
   * the Trip, regardless of payment source. */
  expenses: { lineId: string; lineType: string; category: string | null; description: string; amount: number; isDiesel: boolean }[];
  totalCarrierExpense: number;
  /** The isDiesel subset of totalCarrierExpense - see CarrierTripLine.
   * isDiesel's own schema doc comment. Never description-text based. */
  totalDiesel: number;
  /** Breakdown by CarrierExpenseCategory (DIESEL/TOLL/KHANA/MARAMMAT/
   * SALARY/OTHER), derived straight from each line's own `category`
   * column - never from which account it debited (every expense/
   * salary line debits the same Carrier Profit account now, so an
   * account-based breakdown would be meaningless). */
  categoryBreakdown: { category: string; amount: number }[];
  /** Carrier Rent - Carrier Expense (NOT the same as totalBookingIncome
   * - that is ANC's own booking income, unrelated to this carrier's
   * own profit on the trip it ran). */
  ownCarrierProfit: number;
}

/**
 * See TripProfitReport's own field comments for what each figure
 * means. CASH_FROM_OFFICE/DEPOSIT_TO_OFFICE/COLLECTION are pure cash
 * movements, never expenses or income here - Collection against a
 * linked document is a RECEIPT of an amount already recognized
 * elsewhere (Booking Income at Trip Close for a Challan, or at
 * creation for Phonch/Private Phonch), never double-counted as income
 * again on this report.
 */
export async function getTripProfitReport(tx: Tx, tripId: string): Promise<TripProfitReport> {
  const trip = await getTripOrThrow(tx, tripId);
  const driverCashAccountId = trip.carrier.driverCashAccount?.id;
  const previousBalance = driverCashAccountId ? await getTripOpeningBalance(tx, trip.dateFrom, driverCashAccountId) : 0;

  const [documents, lines] = await Promise.all([
    tx.carrierTripDocument.findMany({ where: { tripId, unlinkedAt: null } }),
    tx.carrierTripLine.findMany({
      where: { tripId, isDeleted: false, lineType: { in: ["EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY"] } },
    }),
  ]);

  const challanIncome: TripProfitReport["challanIncome"] = [];
  const otherIncome: TripProfitReport["otherIncome"] = [];
  for (const doc of documents) {
    if (doc.documentType === "CHALLAN") {
      const challan = await tx.challan.findUnique({ where: { id: doc.documentId }, select: { challanNo: true } });
      if (!challan) continue;
      const bilties = await tx.challanBilty.findMany({ where: { challanId: doc.documentId }, select: { bilty: { select: { total: true } } } });
      const biltyRent = round2(bilties.reduce((s, b) => s + Number(b.bilty.total), 0));
      const carrierRent = round2(Math.max(0, Number(doc.carrierRentAmount)));
      challanIncome.push({ documentId: doc.documentId, label: `Challan ${challan.challanNo}`, biltyRent, carrierRent, bookingIncome: round2(biltyRent - carrierRent) });
    } else if (doc.documentType === "PHONCH") {
      const phonch = await tx.phonch.findUnique({
        where: { id: doc.documentId },
        select: { phonchNo: true, vehicles: { select: { deliveryCharges: true } } },
      });
      if (phonch) {
        const amount = round2(phonch.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0));
        otherIncome.push({ documentType: "PHONCH", documentId: doc.documentId, label: `Phonch ${phonch.phonchNo}`, amount });
      }
    } else {
      const privatePhonch = await tx.privatePhonch.findUnique({
        where: { id: doc.documentId },
        select: { phonchNo: true, vehicles: { select: { totalRent: true, deliveryCharges: true } } },
      });
      if (privatePhonch) {
        const amount = round2(privatePhonch.vehicles.reduce((s, v) => s + (Number(v.totalRent) - Number(v.deliveryCharges)), 0));
        otherIncome.push({ documentType: "PRIVATE_PHONCH", documentId: doc.documentId, label: `Private Phonch ${privatePhonch.phonchNo}`, amount });
      }
    }
  }

  const expenses = lines.map((l) => ({ lineId: l.id, lineType: l.lineType, category: l.category, description: l.description || l.lineType, amount: round2(Number(l.amount)), isDiesel: l.isDiesel }));

  const totalBiltyRent = round2(challanIncome.reduce((s, c) => s + c.biltyRent, 0));
  const totalCarrierRent = round2(challanIncome.reduce((s, c) => s + c.carrierRent, 0));
  const totalBookingIncome = round2(challanIncome.reduce((s, c) => s + c.bookingIncome, 0));
  const totalCarrierExpense = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const totalDiesel = round2(expenses.filter((e) => e.isDiesel).reduce((s, e) => s + e.amount, 0));

  const categoryTotals = new Map<string, number>();
  for (const e of expenses) {
    const key = e.category || "OTHER";
    categoryTotals.set(key, round2((categoryTotals.get(key) || 0) + e.amount));
  }
  const categoryBreakdown = Array.from(categoryTotals.entries()).map(([category, amount]) => ({ category, amount }));

  return {
    previousBalance,
    challanIncome,
    otherIncome,
    totalBiltyRent,
    totalCarrierRent,
    totalBookingIncome,
    expenses,
    totalCarrierExpense,
    totalDiesel,
    categoryBreakdown,
    ownCarrierProfit: round2(totalCarrierRent - totalCarrierExpense),
  };
}

export interface CarrierAllTripsSummary {
  tripCount: number;
  totalBiltyRent: number;
  totalCarrierRent: number;
  totalBookingIncome: number;
  totalCarrierExpense: number;
  totalOwnCarrierProfit: number;
}

/** "Carrier page: all-trips summary" - sums every non-deleted Trip's
 * own getTripProfitReport() across the carrier's whole life, open and
 * closed alike (same "adequate for a profit ESTIMATE" status as the
 * per-Trip report itself - never a second, independent calculation). */
export async function getCarrierAllTripsSummary(tx: Tx, carrierId: string): Promise<CarrierAllTripsSummary> {
  const trips = await tx.carrierTrip.findMany({ where: { carrierId, isDeleted: false }, select: { id: true } });

  let totalBiltyRent = 0;
  let totalCarrierRent = 0;
  let totalBookingIncome = 0;
  let totalCarrierExpense = 0;

  for (const trip of trips) {
    const report = await getTripProfitReport(tx, trip.id);
    totalBiltyRent = round2(totalBiltyRent + report.totalBiltyRent);
    totalCarrierRent = round2(totalCarrierRent + report.totalCarrierRent);
    totalBookingIncome = round2(totalBookingIncome + report.totalBookingIncome);
    totalCarrierExpense = round2(totalCarrierExpense + report.totalCarrierExpense);
  }

  return {
    tripCount: trips.length,
    totalBiltyRent,
    totalCarrierRent,
    totalBookingIncome,
    totalCarrierExpense,
    totalOwnCarrierProfit: round2(totalCarrierRent - totalCarrierExpense),
  };
}

// ============================================================
// CARRIER PAGE SUMMARY + UNLINKED CHALLANS
// ============================================================

export interface CarrierPageSummary {
  /** Driver Cash's own live ledger balance - negative means the
   * carrier/driver is OWED this much (payable to driver), never
   * sign-flipped for display - see formatSignedMoney() at the UI
   * layer for how that's rendered. */
  driverCashBalance: number;
  /** This carrier's own Udhaar vendors only (every vendorPartyId ever
   * used on one of this carrier's EXPENSE_CREDIT lines) - each
   * vendor's own real Account balance (credit - debit, i.e. the SAME
   * convention lib/receivable-payable.ts's getReceivablePayable()
   * already uses), so this carrier's own vendors still show up in the
   * global Payable report/ledgers too - never a second, independent
   * number. */
  vendorsPayable: { partyId: string; partyName: string; balance: number }[];
  totalVendorsPayable: number;
  /** Sum of getDocumentOutstandingAmount() across every one of this
   * carrier's own-carrier Challans (CHALLAN only - Phonch/Private
   * Phonch outstanding is not computed here, same scope
   * getDocumentOutstandingAmount itself already limits to), trip-link
   * state irrelevant - an uncollected Challan is still receivable
   * whether or not it is currently linked to an open Trip. */
  challanReceivable: number;
  /** This carrier's own Carrier Profit account's own net ledger
   * balance (credit - debit, lib/pnl.ts's netIncome convention) -
   * ALL trips, open and closed alike. The exact same number that
   * shows as this carrier's own line on the P&L report. */
  carrierProfit: number;
}

export async function getCarrierPageSummary(tx: Tx, carrierId: string): Promise<CarrierPageSummary> {
  const carrier = await tx.ownCarrier.findUnique({
    where: { id: carrierId },
    include: { driverCashAccount: true, ownCarrierIncomeAccount: true },
  });
  if (!carrier) throw new CarrierTripError("OWN_CARRIER_NOT_FOUND", "Own Carrier not found.");

  const driverCashBalance = carrier.driverCashAccount ? await getDriverCashBalance(tx, carrier.driverCashAccount.id) : 0;

  let carrierProfit = 0;
  if (carrier.ownCarrierIncomeAccount) {
    const agg = await tx.journalLine.aggregate({
      where: { accountId: carrier.ownCarrierIncomeAccount.id, journalEntry: { isDeleted: false } },
      _sum: { debit: true, credit: true },
    });
    carrierProfit = round2(netIncome({ debit: Number(agg._sum.debit || 0), credit: Number(agg._sum.credit || 0) }));
  }

  const vendorLines = await tx.carrierTripLine.findMany({
    where: { trip: { carrierId }, lineType: "EXPENSE_CREDIT", isDeleted: false, vendorPartyId: { not: null } },
    select: { vendorPartyId: true },
    distinct: ["vendorPartyId"],
  });
  const vendorIds = vendorLines.map((l) => l.vendorPartyId!).filter(Boolean);

  const vendorsPayable: CarrierPageSummary["vendorsPayable"] = [];
  if (vendorIds.length > 0) {
    const vendors = await tx.party.findMany({
      where: { id: { in: vendorIds } },
      include: { account: true },
    });
    for (const vendor of vendors) {
      if (!vendor.account) continue;
      const agg = await tx.journalLine.aggregate({
        where: { accountId: vendor.account.id, journalEntry: { isDeleted: false } },
        _sum: { debit: true, credit: true },
      });
      const balance = round2(Number(agg._sum.debit || 0) - Number(agg._sum.credit || 0));
      if (balance < 0) {
        vendorsPayable.push({ partyId: vendor.id, partyName: vendor.partyName, balance: round2(Math.abs(balance)) });
      }
    }
    vendorsPayable.sort((a, b) => b.balance - a.balance);
  }
  const totalVendorsPayable = round2(vendorsPayable.reduce((s, v) => s + v.balance, 0));

  const challans = await tx.challan.findMany({ where: { ownCarrierId: carrierId, isDeleted: false }, select: { id: true } });
  let challanReceivable = 0;
  for (const c of challans) {
    const outstanding = await getDocumentOutstandingAmount(tx, "CHALLAN", c.id);
    challanReceivable = round2(challanReceivable + (outstanding || 0));
  }

  return { driverCashBalance, vendorsPayable, totalVendorsPayable, challanReceivable, carrierProfit };
}

/**
 * This carrier's own own-carrier Challans with NO currently-active
 * Trip link - either dispatched while no Trip was OPEN
 * (autoLinkOwnCarrierChallan's own no-op case), or unlinked since.
 * The carrier page surfaces these with a "Link" action so they don't
 * silently sit unlinked forever.
 */
export async function getUnlinkedOwnCarrierChallans(
  tx: Tx,
  carrierId: string
): Promise<{ id: string; challanNo: string; loadingDate: Date }[]> {
  const challans = await tx.challan.findMany({
    where: { ownCarrierId: carrierId, isDeleted: false },
    select: { id: true, challanNo: true, loadingDate: true },
    orderBy: { loadingDate: "desc" },
  });
  if (challans.length === 0) return [];

  const activeLinks = await tx.carrierTripDocument.findMany({
    where: { documentType: "CHALLAN", documentId: { in: challans.map((c) => c.id) }, unlinkedAt: null },
    select: { documentId: true },
  });
  const linkedIds = new Set(activeLinks.map((l) => l.documentId));

  return challans.filter((c) => !linkedIds.has(c.id));
}
