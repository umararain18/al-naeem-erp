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
import {
  getDriverCashBalance,
  getOrCreateCarrierProfitAccountId,
  getOrCreateTripInProgressAccountId,
  getOrCreateDefaultOwnerDrawingAccountId,
  isEligibleOfficeOverheadAccount,
} from "@/lib/own-carrier";
import {
  getUnearnedRevenueAccountId,
  getGrossBiltyReceivableAccountId,
  getUnclaimedGrossBiltyReceivableAmountForCollection,
  getUnclaimedGrossBiltyReceivableAmountForCollectionBatch,
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
  // EXPENSE_OFFICE/EXPENSE_CREDIT collapse into EXPENSE_CASH here -
  // Drafts trade the detailed office-account/vendor payment-source
  // picker for speed, baking that information into `description`
  // text instead (see this function's own doc comment).
  lineType: "EXPENSE_CASH" | "DRIVER_SALARY" | "OWNER_DRAWING" | "OFFICE_OVERHEAD";
  category: string | null;
  description: string | null;
  isDiesel: boolean;
  pumpPartyId: string | null;
  pumpPartyName: string | null;
  // OFFICE_OVERHEAD only - carried forward as a convenience (no safe
  // default account exists for it, unlike OWNER_DRAWING) - still
  // shown/reselectable in the Drafts row, never silently reused
  // without being visible.
  expenseAccountId: string | null;
  expenseAccountName: string | null;
}

/**
 * "Previous slip expenses as blank drafts" - the carrier's own most
 * recent OTHER Trip's recurring expense/salary/owner/office lines
 * (EXPENSE_CASH/EXPENSE_OFFICE/EXPENSE_CREDIT/DRIVER_SALARY/
 * OWNER_DRAWING/OFFICE_OVERHEAD only - COLLECTION/CASH_FROM_OFFICE/
 * DEPOSIT_TO_OFFICE are one-off cash movements, never a recurring
 * pattern worth re-offering), as pure templates: every field EXCEPT
 * amount/liters/ratePerLiter, which the UI leaves blank for the user
 * to fill. A pure read - this never creates anything; the resulting
 * draft rows this feeds are UI-only state (localStorage) until each
 * is actually saved through the normal lines POST/PATCH endpoints, so
 * they can never create a JournalEntry by themselves.
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
    where: {
      tripId: previousTrip.id,
      isDeleted: false,
      lineType: { in: ["EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY", "OWNER_DRAWING", "OFFICE_OVERHEAD"] },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: {
      vendorParty: { select: { partyName: true } },
      officeAccount: { select: { accountName: true } },
      expenseAccount: { select: { accountName: true } },
      employee: { select: { name: true } },
      pumpParty: { select: { partyName: true } },
    },
  });

  const templates: CarrierTripLineTemplate[] = lines.map((l) => {
    if (l.lineType === "OWNER_DRAWING" || l.lineType === "DRIVER_SALARY") {
      return {
        lineType: l.lineType,
        category: null,
        description: l.description || (l.lineType === "DRIVER_SALARY" ? "Salary" : "Owner personal expense"),
        isDiesel: false,
        pumpPartyId: null,
        pumpPartyName: null,
        expenseAccountId: null,
        expenseAccountName: null,
      };
    }
    if (l.lineType === "OFFICE_OVERHEAD") {
      return {
        lineType: "OFFICE_OVERHEAD",
        category: null,
        description: l.description || (l.expenseAccount ? `Office expense (${l.expenseAccount.accountName})` : "Office expense"),
        isDiesel: false,
        pumpPartyId: null,
        pumpPartyName: null,
        expenseAccountId: l.expenseAccountId,
        expenseAccountName: l.expenseAccount?.accountName || null,
      };
    }
    // EXPENSE_CASH / EXPENSE_OFFICE / EXPENSE_CREDIT - collapsed into
    // one simplified EXPENSE_CASH template, per this function's own
    // doc comment.
    const descriptionSuffix =
      l.lineType === "EXPENSE_OFFICE" && l.officeAccount
        ? ` (Office - ${l.officeAccount.accountName})`
        : l.lineType === "EXPENSE_CREDIT" && l.vendorParty
          ? ` (Udhaar - ${l.vendorParty.partyName})`
          : "";
    return {
      lineType: "EXPENSE_CASH",
      category: l.category,
      description: (l.description || categoryLabel(l.category)) + descriptionSuffix,
      isDiesel: l.isDiesel,
      pumpPartyId: l.pumpPartyId,
      pumpPartyName: l.pumpParty?.partyName || null,
      expenseAccountId: null,
      expenseAccountName: null,
    };
  });

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
 * the only real validation, unchanged).
 *   - CHALLAN: the SAME ledger-true "still genuinely unclaimed in
 *     Gross" figure getBiltyCollectionState's own Trip Wasooli
 *     resolution reads (getUnclaimedGrossBiltyReceivableAmountForCollectionBatch,
 *     summed across every Bilty on the Challan) - NOT "sum(toPay)
 *     minus this module's own COLLECTION rows", which only ever saw
 *     Trip Wasooli receipts and stayed wrongly nonzero once a Bilty
 *     was instead cleared via Daily Posting or a Settlement Payment
 *     (the exact Challan 6406-shows-Cleared-but-Trip-51-shows-
 *     Outstanding-46,000 production discrepancy). This is now the
 *     SAME number app/api/challan/[id]/route.ts's own `toPayLedger`
 *     exposes for the Challan page's own To-Pay card - one ledger-
 *     true source for both, never two independently-maintained ones.
 *   - PHONCH: its own total (deliveryCharges + otherExpense + claim,
 *     the same figure the Phonch model's own total already is) minus
 *     every COLLECTION ever posted against it (unchanged - Phonch has
 *     no equivalent Gross-suspense Collection concept to read from).
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
  if (documentType === "CHALLAN") {
    const bilties = await tx.challanBilty.findMany({ where: { challanId: documentId }, select: { biltyId: true } });
    const biltyIds = bilties.map((b) => b.biltyId);
    if (biltyIds.length === 0) return 0;
    const unclaimedByBiltyId = await getUnclaimedGrossBiltyReceivableAmountForCollectionBatch(tx, biltyIds);
    return round2([...unclaimedByBiltyId.values()].reduce((s, v) => s + v, 0));
  }

  const collectedAgg = await tx.carrierTripLine.aggregate({
    where: { lineType: "COLLECTION", documentType, documentId, isDeleted: false },
    _sum: { amount: true },
  });
  const collected = round2(Number(collectedAgg._sum.amount || 0));

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
 * carrier's own "Trip in Progress" clearing account / Cr Driver Cash -
 * every expense/salary line debits the SAME clearing account now
 * (never Carrier Profit directly - see this module's own header
 * comment), so `category` is what distinguishes a Diesel purchase
 * from a Toll payment, never an account picker. Trip CLOSE moves the
 * Trip's own total out of Trip in Progress into Carrier Profit in one
 * entry - never before then, so an open Trip's own expenses never
 * show in P&L. */
export async function postExpenseCashLine(tx: Tx, input: PostExpenseInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  const category = assertValidExpenseCategory(input.category);

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || categoryLabel(category);

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: tripInProgressAccountId, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "EXPENSE_CASH", date: input.date, description, amount: input.amount, category, ...dieselLineData(input) }
  );
}

/** OUT - trip expense (e.g. Diesel paid via an office account) charged
 * directly to an office Cash/Bank account. Dr Trip in Progress / Cr
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

  const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || `${categoryLabel(category)} (Office Account - ${officeAccount.accountName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: tripInProgressAccountId, debit: input.amount, credit: 0 },
        { accountId: input.officeAccountId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "EXPENSE_OFFICE", date: input.date, description, amount: input.amount, category, officeAccountId: input.officeAccountId, ...dieselLineData(input) }
  );
}

/** OUT - trip expense, Udhaar (credit) to a Vendor Party. Dr Trip in Progress / Cr Vendor. Never touches Driver Cash. */
export async function postExpenseCreditLine(tx: Tx, input: PostExpenseCreditInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  const category = assertValidExpenseCategory(input.category);

  const vendorParty = await tx.party.findUnique({ where: { id: input.vendorPartyId }, include: { account: true } });
  if (!vendorParty || !vendorParty.isActive || !vendorParty.account) {
    throw new CarrierTripError("INVALID_VENDOR", "Selected vendor party was not found or is inactive.");
  }

  const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || `${categoryLabel(category)} (Udhaar - ${vendorParty.partyName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: tripInProgressAccountId, debit: input.amount, credit: 0 },
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
 * employee-account posting): Dr this carrier's own "Trip in Progress"
 * clearing account / Cr Driver Cash. No "employee must have a linked
 * account" requirement any more - the Employee row only needs to
 * exist and not be binned, since salary no longer touches that
 * employee's own account at all. category is always "SALARY" - not
 * user-supplied, since DRIVER_SALARY is its own distinct lineType
 * already. */
export async function postDriverSalaryLine(tx: Tx, input: PostSalaryInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const employee = await tx.employee.findUnique({ where: { id: input.employeeId } });
  if (!employee || employee.isDeleted) {
    throw new CarrierTripError("INVALID_EMPLOYEE", "Selected employee was not found.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, trip.carrierId);
  const description = input.description?.trim() || `Salary paid to ${employee.name}`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: tripInProgressAccountId, debit: input.amount, credit: 0 },
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

export interface PostOwnerDrawingInput extends PostSimpleInput {
  /** Optional - defaults to the system "Owner Drawings - Naeem Shb"
   * account when omitted (see getOrCreateDefaultOwnerDrawingAccountId).
   * When given explicitly, must be an ACTIVE OWNER_DRAWING-category
   * Account. */
  expenseAccountId?: string | null;
}

/** OUT - the Owner's own personal expense, taken from Driver Cash but
 * NEVER a cost of running the trip. Dr a selected OWNER_DRAWING-
 * category Account (default: the system "Owner Drawings - Naeem Shb"
 * account) / Cr Driver Cash. Deliberately never debits Trip in
 * Progress - see this module's own TRIP CLOSE header comment and
 * cashDelta's doc comment for the full exclusion rationale. */
export async function postOwnerDrawingLine(tx: Tx, input: PostOwnerDrawingInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  let ownerAccountId = input.expenseAccountId || null;
  if (ownerAccountId) {
    const account = await tx.account.findUnique({ where: { id: ownerAccountId } });
    if (!account || !account.isActive || account.category !== "OWNER_DRAWING") {
      throw new CarrierTripError("INVALID_ACCOUNT", "Selected account is not an active Owner Drawings account.");
    }
  } else {
    ownerAccountId = await getOrCreateDefaultOwnerDrawingAccountId(tx);
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || "Owner personal expense";

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: ownerAccountId, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "OWNER_DRAWING", date: input.date, description, amount: input.amount, expenseAccountId: ownerAccountId }
  );
}

export interface PostOfficeOverheadInput extends PostSimpleInput {
  expenseAccountId: string;
}

/** OUT - a genuine office overhead expense (Kitchen, Office Repair,
 * Utility, ...), taken from Driver Cash but NOT a cost of running
 * THIS trip. Dr a selected, non-carrier EXPENSE-type Account (always
 * explicitly chosen - no safe default exists) / Cr Driver Cash. Never
 * confused with EXPENSE_OFFICE, which is the OPPOSITE direction (a
 * CARRIER expense merely paid VIA an office account, still debiting
 * Trip in Progress). Deliberately never debits Trip in Progress - see
 * this module's own TRIP CLOSE header comment and cashDelta's doc
 * comment for the full exclusion rationale. */
export async function postOfficeOverheadLine(tx: Tx, input: PostOfficeOverheadInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  if (!input.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office expense account is required.");

  const account = await tx.account.findUnique({ where: { id: input.expenseAccountId } });
  if (!account || !isEligibleOfficeOverheadAccount(account)) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected account is not an active, non-carrier Expense account.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || `Office expense (${account.accountName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: account.id, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "OFFICE_OVERHEAD", date: input.date, description, amount: input.amount, expenseAccountId: account.id }
  );
}

export const TRIP_LINE_TYPES = ["COLLECTION", "CASH_FROM_OFFICE", "EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY", "DEPOSIT_TO_OFFICE", "OWNER_DRAWING", "OFFICE_OVERHEAD"] as const;
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
    case "OWNER_DRAWING":
      return postOwnerDrawingLine(tx, { ...base, expenseAccountId: (rawInput.expenseAccountId as string) || null });
    case "OFFICE_OVERHEAD":
      if (!rawInput.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office expense account is required.");
      return postOfficeOverheadLine(tx, { ...base, expenseAccountId: rawInput.expenseAccountId as string });
    default:
      throw new CarrierTripError("INVALID_LINE_TYPE", "Invalid line type.");
  }
}

function dieselFieldsForEdit(rawInput: Record<string, unknown>): Pick<Prisma.CarrierTripLineUncheckedUpdateInput, "isDiesel" | "liters" | "ratePerLiter" | "pumpPartyId"> {
  if (!rawInput.isDiesel) return { isDiesel: false, liters: null, ratePerLiter: null, pumpPartyId: null };
  return {
    isDiesel: true,
    liters: rawInput.liters != null ? Number(rawInput.liters) : null,
    ratePerLiter: rawInput.ratePerLiter != null ? Number(rawInput.ratePerLiter) : null,
    pumpPartyId: (rawInput.pumpPartyId as string) || null,
  };
}

type JournalLineRow = { id: string; accountId: string; debit: Prisma.Decimal | number; credit: Prisma.Decimal | number; description: string | null; sourceType: string | null; sourceId: string | null; sourceNumber: string | null };

/** Picks the OTHER line of a 2-line entry - every Trip line is
 * exactly a Dr/Cr pair, so once one side is identified by its known
 * account id, the remaining line is unambiguous regardless of
 * creation order. */
function otherLine(lines: JournalLineRow[], excludeId: string): JournalLineRow {
  const found = lines.find((l) => l.id !== excludeId);
  if (!found) throw new CarrierTripError("CORRUPT_ENTRY", "This line's own JournalEntry does not have exactly two lines - data inconsistency, contact support.");
  return found;
}

function findLineByAccount(lines: JournalLineRow[], accountId: string): JournalLineRow | undefined {
  return lines.find((l) => l.accountId === accountId);
}

/**
 * Edits a Trip line truly IN PLACE: the SAME JournalEntry/JournalLine
 * rows are updated (amount, account, description, date, diesel
 * fields) - never a reversal + a brand-new entry. The lineType itself
 * is NOT editable this way (switching types is a delete-and-recreate
 * the UI does explicitly, never an implicit side effect of an edit),
 * and for COLLECTION, the linked document (documentType/documentId/
 * biltyId) is likewise fixed - only its resolved counterAccountId,
 * amount, description and date can change. Blocked once the owning
 * Trip is CLOSED (reopen it first) - same guard as every other write
 * here. Returns the updated CarrierTripLine row; callers that need an
 * Audit Log diff build it themselves from the row they already have
 * before calling this (see diffFields in lib/audit-log.ts) - this
 * function performs no audit writes of its own, consistent with every
 * other mutator in this module.
 */
export async function editCarrierTripLine(
  tx: Tx,
  input: {
    lineId: string;
    editedById: string;
    date: Date;
    description: string | null;
    amount: number;
    rawInput: Record<string, unknown>;
  }
) {
  const existing = await tx.carrierTripLine.findUnique({
    where: { id: input.lineId },
    include: {
      journalEntry: { include: { lines: true } },
      trip: { include: { carrier: { include: { driverCashAccount: true } } } },
    },
  });
  if (!existing || existing.isDeleted) {
    throw new CarrierTripError("LINE_NOT_FOUND", "This line was not found or has been deleted.");
  }
  if (existing.journalEntry.isDeleted) {
    throw new CarrierTripError("LINE_NOT_FOUND", "This line was not found or has been deleted.");
  }
  if (existing.trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before editing a line.");
  }
  if (input.amount <= 0) {
    throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");
  }
  await assertLineDateValid(tx, existing.tripId, input.date, input.rawInput);

  const driverCashId = existing.trip.carrier.driverCashAccount?.id;
  if (!driverCashId) {
    throw new CarrierTripError("NO_DRIVER_CASH_ACCOUNT", "This carrier has no Driver Cash account - data inconsistency, contact support.");
  }
  const entryLines = existing.journalEntry.lines;
  const amount = input.amount;

  type LineUpdate = { id: string; accountId: string; debit: number; credit: number; sourceType?: string | null; sourceId?: string | null; sourceNumber?: string | null };
  let description: string;
  let carrierTripLineData: Record<string, unknown> = {};
  let lineUpdates: LineUpdate[];

  switch (existing.lineType as TripLineType) {
    case "EXPENSE_CASH": {
      if (!input.rawInput.category) throw new CarrierTripError("MISSING_CATEGORY", "Expense category is required.");
      const category = assertValidExpenseCategory(input.rawInput.category as string);
      const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, existing.trip.carrierId);
      const tipLine = findLineByAccount(entryLines, tripInProgressAccountId) || entryLines[0];
      const cashLine = otherLine(entryLines, tipLine.id);
      description = input.description?.trim() || categoryLabel(category);
      carrierTripLineData = { category, ...dieselFieldsForEdit(input.rawInput) };
      lineUpdates = [
        { id: tipLine.id, accountId: tripInProgressAccountId, debit: amount, credit: 0 },
        { id: cashLine.id, accountId: driverCashId, debit: 0, credit: amount },
      ];
      break;
    }
    case "EXPENSE_OFFICE": {
      if (!input.rawInput.category) throw new CarrierTripError("MISSING_CATEGORY", "Expense category is required.");
      if (!input.rawInput.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
      const category = assertValidExpenseCategory(input.rawInput.category as string);
      const officeAccountId = input.rawInput.officeAccountId as string;
      const officeAccount = await tx.account.findUnique({ where: { id: officeAccountId } });
      if (!officeAccount || !officeAccount.isActive) {
        throw new CarrierTripError("INVALID_ACCOUNT", "Selected office account was not found or is inactive.");
      }
      const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, existing.trip.carrierId);
      const tipLine = findLineByAccount(entryLines, tripInProgressAccountId) || entryLines[0];
      const officeLine = otherLine(entryLines, tipLine.id);
      description = input.description?.trim() || `${categoryLabel(category)} (Office Account - ${officeAccount.accountName})`;
      carrierTripLineData = { category, officeAccountId, ...dieselFieldsForEdit(input.rawInput) };
      lineUpdates = [
        { id: tipLine.id, accountId: tripInProgressAccountId, debit: amount, credit: 0 },
        { id: officeLine.id, accountId: officeAccountId, debit: 0, credit: amount },
      ];
      break;
    }
    case "EXPENSE_CREDIT": {
      if (!input.rawInput.category) throw new CarrierTripError("MISSING_CATEGORY", "Expense category is required.");
      if (!input.rawInput.vendorPartyId) throw new CarrierTripError("MISSING_VENDOR", "Vendor party is required for a credit expense.");
      const category = assertValidExpenseCategory(input.rawInput.category as string);
      const vendorPartyId = input.rawInput.vendorPartyId as string;
      const vendorParty = await tx.party.findUnique({ where: { id: vendorPartyId }, include: { account: true } });
      if (!vendorParty || !vendorParty.isActive || !vendorParty.account) {
        throw new CarrierTripError("INVALID_VENDOR", "Selected vendor party was not found or is inactive.");
      }
      const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, existing.trip.carrierId);
      const tipLine = findLineByAccount(entryLines, tripInProgressAccountId) || entryLines[0];
      const vendorLine = otherLine(entryLines, tipLine.id);
      description = input.description?.trim() || `${categoryLabel(category)} (Udhaar - ${vendorParty.partyName})`;
      carrierTripLineData = { category, vendorPartyId, ...dieselFieldsForEdit(input.rawInput) };
      lineUpdates = [
        { id: tipLine.id, accountId: tripInProgressAccountId, debit: amount, credit: 0 },
        { id: vendorLine.id, accountId: vendorParty.account.id, debit: 0, credit: amount },
      ];
      break;
    }
    case "DRIVER_SALARY": {
      if (!input.rawInput.employeeId) throw new CarrierTripError("MISSING_EMPLOYEE", "Employee is required for a salary line.");
      const employeeId = input.rawInput.employeeId as string;
      const employee = await tx.employee.findUnique({ where: { id: employeeId } });
      if (!employee || employee.isDeleted) {
        throw new CarrierTripError("INVALID_EMPLOYEE", "Selected employee was not found.");
      }
      const tripInProgressAccountId = await getOrCreateTripInProgressAccountId(tx, existing.trip.carrierId);
      const tipLine = findLineByAccount(entryLines, tripInProgressAccountId) || entryLines[0];
      const cashLine = otherLine(entryLines, tipLine.id);
      description = input.description?.trim() || `Salary paid to ${employee.name}`;
      carrierTripLineData = { employeeId, category: "SALARY" };
      lineUpdates = [
        { id: tipLine.id, accountId: tripInProgressAccountId, debit: amount, credit: 0 },
        { id: cashLine.id, accountId: driverCashId, debit: 0, credit: amount },
      ];
      break;
    }
    case "OWNER_DRAWING": {
      let ownerAccountId = (input.rawInput.expenseAccountId as string) || null;
      if (ownerAccountId) {
        const account = await tx.account.findUnique({ where: { id: ownerAccountId } });
        if (!account || !account.isActive || account.category !== "OWNER_DRAWING") {
          throw new CarrierTripError("INVALID_ACCOUNT", "Selected account is not an active Owner Drawings account.");
        }
      } else {
        ownerAccountId = await getOrCreateDefaultOwnerDrawingAccountId(tx);
      }
      const cashLine = findLineByAccount(entryLines, driverCashId) || entryLines[0];
      const ownerLine = otherLine(entryLines, cashLine.id);
      description = input.description?.trim() || "Owner personal expense";
      carrierTripLineData = { expenseAccountId: ownerAccountId };
      lineUpdates = [
        { id: ownerLine.id, accountId: ownerAccountId, debit: amount, credit: 0 },
        { id: cashLine.id, accountId: driverCashId, debit: 0, credit: amount },
      ];
      break;
    }
    case "OFFICE_OVERHEAD": {
      if (!input.rawInput.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office expense account is required.");
      const expenseAccountId = input.rawInput.expenseAccountId as string;
      const account = await tx.account.findUnique({ where: { id: expenseAccountId } });
      if (!account || !isEligibleOfficeOverheadAccount(account)) {
        throw new CarrierTripError("INVALID_ACCOUNT", "Selected account is not an active, non-carrier Expense account.");
      }
      const cashLine = findLineByAccount(entryLines, driverCashId) || entryLines[0];
      const officeOverheadLine = otherLine(entryLines, cashLine.id);
      description = input.description?.trim() || `Office expense (${account.accountName})`;
      carrierTripLineData = { expenseAccountId };
      lineUpdates = [
        { id: officeOverheadLine.id, accountId: expenseAccountId, debit: amount, credit: 0 },
        { id: cashLine.id, accountId: driverCashId, debit: 0, credit: amount },
      ];
      break;
    }
    case "CASH_FROM_OFFICE":
    case "DEPOSIT_TO_OFFICE": {
      if (!input.rawInput.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
      const officeAccountId = input.rawInput.officeAccountId as string;
      const officeAccount = await tx.account.findUnique({ where: { id: officeAccountId } });
      if (!officeAccount || !officeAccount.isActive) {
        throw new CarrierTripError("INVALID_ACCOUNT", "Selected office account was not found or is inactive.");
      }
      const cashLine = findLineByAccount(entryLines, driverCashId) || entryLines[0];
      const officeLine = otherLine(entryLines, cashLine.id);
      carrierTripLineData = { officeAccountId };
      if (existing.lineType === "CASH_FROM_OFFICE") {
        description = input.description?.trim() || "Cash from office";
        lineUpdates = [
          { id: cashLine.id, accountId: driverCashId, debit: amount, credit: 0 },
          { id: officeLine.id, accountId: officeAccountId, debit: 0, credit: amount },
        ];
      } else {
        description = input.description?.trim() || `Deposit to ${officeAccount.accountName}`;
        lineUpdates = [
          { id: officeLine.id, accountId: officeAccountId, debit: amount, credit: 0 },
          { id: cashLine.id, accountId: driverCashId, debit: 0, credit: amount },
        ];
      }
      break;
    }
    case "COLLECTION": {
      if (existing.documentType !== (input.rawInput.documentType as string | undefined || existing.documentType) || existing.documentId !== (input.rawInput.documentId as string | undefined || existing.documentId)) {
        throw new CarrierTripError("DOCUMENT_NOT_EDITABLE", "A Collection line's linked document cannot be changed by editing - delete and re-create it against the new document instead.");
      }
      const cashLine = findLineByAccount(entryLines, driverCashId) || entryLines[0];
      const partyLine = otherLine(entryLines, cashLine.id);
      // The per-Bilty branch (see postCollectionLine) never stores its
      // own biltyId on CarrierTripLine - it is only ever recoverable
      // from the party line's own sourceType:"BILTY"/sourceId tag.
      const biltyId = partyLine.sourceType === "BILTY" ? partyLine.sourceId : null;
      const counterAccountId = (input.rawInput.counterAccountId as string) || partyLine.accountId;
      if (counterAccountId !== partyLine.accountId) {
        // Explicitly reassigned to a different party/account - re-check
        // eligibility the exact same way creation does.
        const eligible =
          existing.documentType === "CHALLAN" && biltyId
            ? await getBiltyLegitimatePartyAccountIds(biltyId, "DEBIT")
            : existing.documentType === "CHALLAN"
              ? await getChallanEligiblePartyAccountIds(existing.documentId!, "DEBIT")
              : existing.documentType === "PRIVATE_PHONCH"
                ? await getPrivatePhonchEligiblePartyAccountIds(existing.documentId!, "DEBIT")
                : await getPhonchEligiblePartyAccountIds(existing.documentId!);
        if (!eligible.has(counterAccountId)) {
          throw new CarrierTripError("INVALID_COUNTER_ACCOUNT", "Selected account is not a valid Receivable party for this document.");
        }
      }
      // Re-validate the over-collection ceiling only for the INCREASE
      // over this line's own current amount - every assert*NotExceeded
      // check below is ledger-true over ALL live lines, which already
      // includes this line's own current contribution; a reduction (or
      // an unchanged amount) can never newly exceed anything.
      const currentAmount = round2(Number(existing.amount));
      const increase = round2(amount - currentAmount);
      if (increase > 0.009) {
        if (existing.documentType === "CHALLAN" && biltyId) {
          const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { toPay: true } });
          const toPay = round2(Number(bilty?.toPay || 0));
          const outstandingExcludingThis = round2((await getUnclaimedGrossBiltyReceivableAmountForCollection(tx, biltyId)) + currentAmount);
          if (round2(amount) > outstandingExcludingThis + 0.009) {
            throw new CarrierTripError("OVER_COLLECTION", `This receipt of Rs. ${round2(amount).toLocaleString()} would exceed the remaining outstanding amount (Rs. ${Math.max(0, Math.min(toPay, outstandingExcludingThis)).toLocaleString()}).`);
          }
        } else if (existing.documentType === "PHONCH") {
          await assertPhonchReceiptNotExceeded(tx, existing.documentId!, counterAccountId, increase, "DEBIT");
        } else if (existing.documentType === "PRIVATE_PHONCH") {
          await assertPrivatePhonchPaymentNotExceeded(tx, existing.documentId!, counterAccountId, increase, "DEBIT");
        }
      }
      description = input.description?.trim() || partyLine.description || existing.description || "Collection";
      lineUpdates = [
        { id: cashLine.id, accountId: driverCashId, debit: amount, credit: 0, sourceType: cashLine.sourceType, sourceId: cashLine.sourceId, sourceNumber: cashLine.sourceNumber },
        { id: partyLine.id, accountId: counterAccountId, debit: 0, credit: amount, sourceType: partyLine.sourceType, sourceId: partyLine.sourceId, sourceNumber: partyLine.sourceNumber },
      ];
      break;
    }
    default:
      throw new CarrierTripError("INVALID_LINE_TYPE", "Invalid line type.");
  }

  await tx.journalEntry.update({
    where: { id: existing.journalEntryId },
    data: { entryDate: input.date, description },
  });
  for (const lineUpdate of lineUpdates) {
    await tx.journalLine.update({
      where: { id: lineUpdate.id },
      data: {
        accountId: lineUpdate.accountId,
        debit: lineUpdate.debit,
        credit: lineUpdate.credit,
        description,
        ...(lineUpdate.sourceType !== undefined ? { sourceType: lineUpdate.sourceType } : {}),
        ...(lineUpdate.sourceId !== undefined ? { sourceId: lineUpdate.sourceId } : {}),
        ...(lineUpdate.sourceNumber !== undefined ? { sourceNumber: lineUpdate.sourceNumber } : {}),
      },
    });
  }

  return tx.carrierTripLine.update({
    where: { id: input.lineId },
    data: { date: input.date, description, amount, ...carrierTripLineData },
  });
}

/**
 * Deletes a Trip line into the SAME accounting Bin every other
 * document-level write in this codebase uses - soft-deletes this
 * line's own JournalEntry (isDeleted/deletedAt/deletedById), which
 * excludes it from every ledger/balance/P&L query (they all filter
 * `journalEntry.isDeleted: false`), plus the CarrierTripLine row
 * itself in parallel (kept in sync the same way Payslip keeps its own
 * isDeleted in step with its PAYROLL_SALARY JournalEntry - see
 * app/api/bin/route.ts's own comment on that precedent). Replaces the
 * old append-only "post an opposite-signed compensating entry, keep
 * the original live forever" design (reverseCarrierTripLine) - that
 * design is what produced the historical CARRIER_TRIP_LINE_REVERSAL
 * pairs scripts/cleanup-carrier-trip-line-reversal-pairs.ts now cleans
 * up. Restore is restoreCarrierTripLine below. Blocked once the
 * owning Trip is CLOSED (reopen it first).
 */
export async function deleteCarrierTripLine(tx: Tx, input: { lineId: string; deletedById: string; reason?: string }) {
  const line = await tx.carrierTripLine.findUnique({
    where: { id: input.lineId },
    include: { journalEntry: true, trip: true },
  });
  if (!line || line.isDeleted) {
    throw new CarrierTripError("LINE_NOT_FOUND", "This line was not found or is already deleted.");
  }
  if (line.trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before deleting a line.");
  }

  const deletedAt = new Date();
  await tx.journalEntry.update({
    where: { id: line.journalEntryId },
    data: { isDeleted: true, deletedAt, deletedById: input.deletedById },
  });

  return tx.carrierTripLine.update({
    where: { id: input.lineId },
    data: { isDeleted: true, deletedAt, deletedById: input.deletedById },
  });
}

/** Restores a Bin'd Trip line - flips BOTH CarrierTripLine.isDeleted
 * and its JournalEntry.isDeleted back, in step (never the generic
 * /api/accounting-transactions/[id]/restore route, which only knows
 * about the JournalEntry side - same reasoning as Payslip's own
 * dedicated restore route). Blocked once the owning Trip is CLOSED
 * (reopen it first) - restoring a line onto a closed Trip would stage
 * a change Close's own totals never accounted for. Also refuses a
 * line whose own JournalEntry has a live-or-Bin'd
 * CARRIER_TRIP_LINE_REVERSAL pointing at it - that shape only ever
 * comes from a PRE-this-feature legacy edit/delete
 * (scripts/cleanup-carrier-trip-line-reversal-pairs.ts's own target),
 * never from deleteCarrierTripLine (which creates no reversal at
 * all), so restoring just this one side would resurrect the original
 * entry WITHOUT the reversal that was keeping it net zero - an
 * imbalance. Such a pair is permanently retired; it is never meant to
 * be restored through this path. */
export async function restoreCarrierTripLine(tx: Tx, input: { lineId: string; restoredById: string }) {
  const line = await tx.carrierTripLine.findUnique({
    where: { id: input.lineId },
    include: { trip: true },
  });
  if (!line || !line.isDeleted) {
    throw new CarrierTripError("LINE_NOT_FOUND", "This line was not found or is not in the Bin.");
  }
  if (line.trip.status !== "OPEN") {
    throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed - reopen it before restoring a line.");
  }
  const reversalExists = await tx.journalEntry.findFirst({ where: { reversesEntryId: line.journalEntryId }, select: { id: true } });
  if (reversalExists) {
    throw new CarrierTripError("LEGACY_REVERSAL_PAIR", "This line was retired by the historical reversal-pair cleanup, not deleted directly - it cannot be restored through this path.");
  }

  await tx.journalEntry.update({
    where: { id: line.journalEntryId },
    data: { isDeleted: false, deletedAt: null, deletedById: null },
  });

  return tx.carrierTripLine.update({
    where: { id: input.lineId },
    data: { isDeleted: false, deletedAt: null, deletedById: null },
  });
}

// ============================================================
// TRIP CLOSE INCOME RECOGNITION + EXPENSE CLEARING - see
// Challan.ownCarrierId's own schema doc comment for the income-
// deferral rationale. An own-carrier Challan's Bilty rent sits
// untouched in Unearned Revenue from booking all the way through
// dispatch; a Trip's own expense/diesel/salary lines sit in "Trip in
// Progress" (never Carrier Profit directly - see postExpenseCashLine's
// own doc comment) for as long as the Trip stays OPEN. Closing the
// Trip is the ONE moment both get resolved into Carrier Profit, in
// EXACTLY TWO JournalEntries (never one per linked Challan, never one
// per expense line):
//
//   Entry A ("...Carrier Rent"), referenceType CARRIER_TRIP_CLOSE,
//   referenceId = the TRIP's own id (never a Challan's - a Trip can
//   close several Challans at once, so this entry's own lines, not
//   its referenceId, carry each Challan's own sourceType:"CHALLAN"/
//   sourceId tag): Dr Unearned Revenue / Cr Booking Income, per
//   contributing Challan (Bilty Rent minus that Challan's own Carrier
//   Rent), PLUS one combined Cr Carrier Profit line for every
//   contributing Challan's Carrier Rent summed together. A Challan
//   with zero Bilty Rent, or already recognized (see
//   getChallanCloseRecognitionNet), contributes nothing and is left
//   out of this entry entirely - exactly as recognizeBiltyBookingIncome()'s
//   own idempotency already works per-Bilty.
//
//   Entry B ("...Expenses"), referenceType CARRIER_TRIP_CLOSE_EXPENSE,
//   referenceId = the TRIP's own id: Dr Carrier Profit / Cr Trip in
//   Progress, for this Trip's own total EXPENSE_CASH/EXPENSE_OFFICE/
//   EXPENSE_CREDIT/DRIVER_SALARY amount (read straight off
//   CarrierTripLine.tripId/lineType/amount - the SAME figure
//   getTripProfitReport's own totalCarrierExpense already is, not a
//   second calculation).
//
// Either entry is simply never created when it would have nothing to
// post (no Challan contributes / zero trip expense) - "exactly two"
// is the common case, not an invariant enforced by fabricating a
// zero-line entry.
//
// Reopen soft-deletes whichever of the two is currently live straight
// into the Bin (see softDeleteLiveCloseEntry's own doc comment) -
// never a reversal entry any more, never a per-Challan loop. Re-close
// afterward posts entirely fresh Entry A/Entry B.
// ============================================================

export const CARRIER_TRIP_CLOSE_REFERENCE_TYPE = "CARRIER_TRIP_CLOSE";
export const CARRIER_TRIP_CLOSE_EXPENSE_REFERENCE_TYPE = "CARRIER_TRIP_CLOSE_EXPENSE";
// Both REVERSAL referenceTypes below are write-path DEAD since Reopen
// moved to soft-delete (above) - kept only so
// getChallanCloseRecognitionNet's own read still nets correctly
// against any HISTORICAL Trip that was reopened under the old
// reversal-based design before this change shipped. Never produced by
// any code going forward.
export const CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE = "CARRIER_TRIP_CLOSE_REVERSAL";
export const CARRIER_TRIP_CLOSE_EXPENSE_REVERSAL_REFERENCE_TYPE = "CARRIER_TRIP_CLOSE_EXPENSE_REVERSAL";

/** Ledger-true net (debit - credit) on Unearned Revenue for this ONE
 * Challan's own sourceType:"CHALLAN"/sourceId tag, across every live
 * CARRIER_TRIP_CLOSE/CARRIER_TRIP_CLOSE_REVERSAL JournalLine - works
 * identically whether this Challan's own recognition lines live
 * inside a solo entry or a combined multi-Challan one, since the tag
 * is per-LINE, never per-entry. Positive = currently recognized
 * (Entry A's own Dr Unearned Revenue line for this Challan is still
 * live, uncanceled by a later reversal's Cr); zero = not recognized
 * (never happened, or happened and was since reversed). Replaces the
 * old "count recognize entries minus count reversal entries" idiom,
 * which assumed exactly one entry per Challan and broke once several
 * Challans' own recognition lines could share a single combined
 * entry.
 */
async function getChallanCloseRecognitionNet(tx: Tx, challanId: string): Promise<number> {
  const unearnedRevenueAccountId = await getUnearnedRevenueAccountId(tx);
  const lines = await tx.journalLine.findMany({
    where: {
      accountId: unearnedRevenueAccountId,
      sourceType: "CHALLAN",
      sourceId: challanId,
      journalEntry: {
        referenceType: { in: [CARRIER_TRIP_CLOSE_REFERENCE_TYPE, CARRIER_TRIP_CLOSE_REVERSAL_REFERENCE_TYPE] },
        isDeleted: false,
      },
    },
    select: { debit: true, credit: true },
  });
  return round2(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
}

/** True if this own-carrier Challan's income is CURRENTLY recognized
 * (i.e. some Trip holding it has been closed, and not since reopened
 * without a later re-close) - read by app/api/challan/[id]/route.ts
 * and the Challan list to show "Income pending (Trip slip not
 * closed)" before this is true. */
export async function isCarrierTripChallanIncomeRecognized(tx: Tx, challanId: string): Promise<boolean> {
  return (await getChallanCloseRecognitionNet(tx, challanId)) > 0.009;
}

async function getActiveBookingIncomeAccountId(tx: Tx): Promise<string> {
  const account = await tx.account.findFirst({ where: { category: "BOOKING_INCOME", isActive: true }, select: { id: true } });
  if (!account) {
    throw new CarrierTripError("MISSING_BOOKING_INCOME_ACCOUNT", "Required account is not configured. Please configure a BOOKING_INCOME account.");
  }
  return account.id;
}

/** The one currently-LIVE (never reversed) JournalEntry of a given
 * referenceType/referenceId, if any - at most one is ever live at
 * once for CARRIER_TRIP_CLOSE/CARRIER_TRIP_CLOSE_EXPENSE scoped to a
 * single Trip (Close/Reopen are mutually exclusive states), but a
 * Trip that has been through more than one close/reopen cycle can
 * have several HISTORICAL entries of the same referenceType/
 * referenceId - this returns only the one without an existing
 * reversal pointing at it. */
async function findLiveCloseEntry(tx: Tx, referenceType: string, referenceId: string) {
  const entries = await tx.journalEntry.findMany({
    where: { referenceType, referenceId, isDeleted: false },
    include: { lines: true },
    orderBy: { createdAt: "asc" },
  });
  if (entries.length === 0) return null;
  const reversedIds = new Set(
    (
      await tx.journalEntry.findMany({
        where: { reversesEntryId: { in: entries.map((e) => e.id) }, isDeleted: false },
        select: { reversesEntryId: true },
      })
    ).map((e) => e.reversesEntryId)
  );
  return entries.find((e) => !reversedIds.has(e.id)) ?? null;
}

/** Soft-deletes one live close-side entry found by findLiveCloseEntry
 * directly into the Bin - never a reversal entry (that was this
 * function's own previous design; see the git history of this file
 * for the old reverseLiveCloseEntry it replaces). A Trip's own
 * CARRIER_TRIP_CLOSE/CARRIER_TRIP_CLOSE_EXPENSE entries are never
 * read/attributed-to by anything outside this Trip's own Reopen/
 * Re-close cycle (unlike, say, a Settlement Payment's own
 * establishment entry, which other documents can separately
 * reference) - there is nothing a reversal pair would protect here
 * that a plain soft-delete doesn't already give for free: every
 * reader already filters `journalEntry.isDeleted: false` (e.g.
 * getChallanCloseRecognitionNet), so the deleted entry simply stops
 * counting, with no reversal-pair clutter left behind. A no-op
 * (returns false) if none is currently live - e.g. Entry B never
 * posted because the Trip had zero expense. */
async function softDeleteLiveCloseEntry(
  tx: Tx,
  input: { referenceType: string; tripId: string; deletedById: string }
): Promise<boolean> {
  const entry = await findLiveCloseEntry(tx, input.referenceType, input.tripId);
  if (!entry) return false;

  await tx.journalEntry.update({
    where: { id: entry.id },
    data: { isDeleted: true, deletedAt: new Date(), deletedById: input.deletedById },
  });

  return true;
}

/**
 * Builds and posts Entry A ("...Carrier Rent") for every currently
 * ACTIVE, not-yet-recognized, nonzero-Bilty-Rent CHALLAN link on this
 * Trip, combined into ONE JournalEntry - see this section's own
 * header comment for the exact shape. A no-op (posts nothing) if no
 * link contributes anything.
 */
/** "Trip 51 (Karachi - Dera Ismail Khan - Abdul Hakeem)" when the
 * Trip's own `route` (user-typed, the cities entered on the Trip) is
 * set, else plain "Trip 51" - shared by both Close entries' own
 * descriptions below so Reopen's own "reversing: ..." text (which
 * just echoes the live entry's own description back) picks it up
 * automatically, with no separate fix needed there. */
function tripLabel(tripNo: string, route: string | null): string {
  return route ? `Trip ${tripNo} (${route})` : `Trip ${tripNo}`;
}

async function recognizeCarrierTripIncome(
  tx: Tx,
  input: { tripId: string; tripNo: string; route: string | null; carrierId: string; entryDate: Date; createdById: string }
): Promise<boolean> {
  const links = await tx.carrierTripDocument.findMany({
    where: { tripId: input.tripId, documentType: "CHALLAN", unlinkedAt: null },
  });
  if (links.length === 0) return false;

  const challans = await tx.challan.findMany({
    where: { id: { in: links.map((l) => l.documentId) }, ownCarrierId: input.carrierId },
    select: { id: true, challanNo: true, bilties: { select: { bilty: { select: { total: true } } } } },
  });
  const challanById = new Map(challans.map((c) => [c.id, c]));

  type Contribution = { challanId: string; challanNo: string; biltyRentTotal: number; carrierRentAmount: number; bookingIncomeAmount: number };
  const contributions: Contribution[] = [];

  for (const link of links) {
    const challan = challanById.get(link.documentId);
    if (!challan) continue;
    if ((await getChallanCloseRecognitionNet(tx, challan.id)) > 0.009) continue;

    const biltyRentTotal = round2(challan.bilties.reduce((s, b) => s + Number(b.bilty.total), 0));
    if (biltyRentTotal <= 0) continue;

    const carrierRentAmount = round2(Math.max(0, Number(link.carrierRentAmount)));
    contributions.push({
      challanId: challan.id,
      challanNo: challan.challanNo,
      biltyRentTotal,
      carrierRentAmount,
      bookingIncomeAmount: round2(biltyRentTotal - carrierRentAmount),
    });
  }

  if (contributions.length === 0) return false;

  const [unearnedRevenueAccountId, bookingIncomeAccountId, carrierProfitAccountId] = await Promise.all([
    getUnearnedRevenueAccountId(tx),
    getActiveBookingIncomeAccountId(tx),
    getOrCreateCarrierProfitAccountId(tx, input.carrierId),
  ]);

  const challanNos = contributions.map((c) => c.challanNo).join(", ");
  const description = `${tripLabel(input.tripNo, input.route)} – Challan ${challanNos} – Carrier Rent`;

  const lines: { accountId: string; debit: number; credit: number; sourceType: string; sourceId: string; sourceNumber: string }[] = [];
  let carrierRentTotal = 0;

  for (const c of contributions) {
    lines.push({ accountId: unearnedRevenueAccountId, debit: c.biltyRentTotal, credit: 0, sourceType: "CHALLAN", sourceId: c.challanId, sourceNumber: c.challanNo });
    if (c.bookingIncomeAmount >= 0) {
      lines.push({ accountId: bookingIncomeAccountId, debit: 0, credit: c.bookingIncomeAmount, sourceType: "CHALLAN", sourceId: c.challanId, sourceNumber: c.challanNo });
    } else {
      lines.push({ accountId: bookingIncomeAccountId, debit: -c.bookingIncomeAmount, credit: 0, sourceType: "CHALLAN", sourceId: c.challanId, sourceNumber: c.challanNo });
    }
    carrierRentTotal = round2(carrierRentTotal + c.carrierRentAmount);
  }

  if (carrierRentTotal > 0) {
    // One COMBINED line for every contributing Challan's own Carrier
    // Rent, summed - never one per Challan (see this section's own
    // header comment) - tagged to the Trip itself, since it is not
    // any single Challan's own amount any more.
    lines.push({ accountId: carrierProfitAccountId, debit: 0, credit: carrierRentTotal, sourceType: "CARRIER_TRIP", sourceId: input.tripId, sourceNumber: input.tripNo });
  }

  await tx.journalEntry.create({
    data: {
      entryDate: input.entryDate,
      referenceType: CARRIER_TRIP_CLOSE_REFERENCE_TYPE,
      referenceId: input.tripId,
      description,
      createdById: input.createdById,
      lines: { create: lines.map((l) => ({ ...l, description })) },
    },
  });

  return true;
}

/**
 * Builds and posts Entry B ("...Expenses") - Dr Carrier Profit / Cr
 * Trip in Progress for this Trip's own total expense/diesel/salary
 * amount (CarrierTripLine.tripId-scoped, the same figure
 * getTripProfitReport's own totalCarrierExpense already is). A no-op
 * if that total is 0.
 */
async function recognizeCarrierTripExpenseClearing(
  tx: Tx,
  input: { tripId: string; tripNo: string; route: string | null; carrierId: string; entryDate: Date; createdById: string }
): Promise<boolean> {
  const expenseLines = await tx.carrierTripLine.findMany({
    where: { tripId: input.tripId, isDeleted: false, lineType: { in: ["EXPENSE_CASH", "EXPENSE_OFFICE", "EXPENSE_CREDIT", "DRIVER_SALARY"] } },
    select: { amount: true },
  });
  const expenseTotal = round2(expenseLines.reduce((s, l) => s + Number(l.amount), 0));
  if (expenseTotal <= 0) return false;

  const links = await tx.carrierTripDocument.findMany({
    where: { tripId: input.tripId, documentType: "CHALLAN", unlinkedAt: null },
  });
  const challans = links.length
    ? await tx.challan.findMany({ where: { id: { in: links.map((l) => l.documentId) } }, select: { challanNo: true }, orderBy: { challanNo: "asc" } })
    : [];
  const challanNos = challans.map((c) => c.challanNo).join(", ");

  const [carrierProfitAccountId, tripInProgressAccountId] = await Promise.all([
    getOrCreateCarrierProfitAccountId(tx, input.carrierId),
    getOrCreateTripInProgressAccountId(tx, input.carrierId),
  ]);

  const description = challanNos
    ? `${tripLabel(input.tripNo, input.route)} – Challan ${challanNos} – Expenses`
    : `${tripLabel(input.tripNo, input.route)} – Expenses`;

  await tx.journalEntry.create({
    data: {
      entryDate: input.entryDate,
      referenceType: CARRIER_TRIP_CLOSE_EXPENSE_REFERENCE_TYPE,
      referenceId: input.tripId,
      description,
      createdById: input.createdById,
      lines: {
        create: [
          { accountId: carrierProfitAccountId, debit: expenseTotal, credit: 0, description, sourceType: "CARRIER_TRIP", sourceId: input.tripId, sourceNumber: input.tripNo },
          { accountId: tripInProgressAccountId, debit: 0, credit: expenseTotal, description, sourceType: "CARRIER_TRIP", sourceId: input.tripId, sourceNumber: input.tripNo },
        ],
      },
    },
  });

  return true;
}

/**
 * Orchestrates Trip CLOSE: sets status CLOSED (auto-filling dateTo
 * with today if the user never set one - Close never blocks on a
 * missing end date), then posts Entry A (Carrier Rent, every
 * contributing linked Challan combined) and Entry B (Expenses, this
 * Trip's own total), both dated the Trip's own end date - see this
 * section's own header comment. Either is simply skipped when it
 * would have nothing to post.
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

  await recognizeCarrierTripIncome(tx, { tripId: input.tripId, tripNo: trip.tripNo, route: trip.route, carrierId: trip.carrierId, entryDate: dateTo, createdById: input.updatedById });
  await recognizeCarrierTripExpenseClearing(tx, { tripId: input.tripId, tripNo: trip.tripNo, route: trip.route, carrierId: trip.carrierId, entryDate: dateTo, createdById: input.updatedById });

  return updated;
}

/**
 * Orchestrates Trip REOPEN: soft-deletes whichever of Entry A/Entry B
 * is currently live straight into the Bin (safe no-op for either
 * that was never posted - e.g. zero trip expense) - never a reversal
 * entry (see softDeleteLiveCloseEntry's own doc comment for why) -
 * then sets status back to OPEN. Re-closing afterward
 * (closeCarrierTrip) posts entirely fresh Entry A/Entry B, dated the
 * Trip's own (possibly since-edited) dateTo.
 */
export async function reopenCarrierTrip(tx: Tx, input: { tripId: string; updatedById: string; reason?: string }) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status === "OPEN") {
    throw new CarrierTripError("ALREADY_OPEN", "This Trip is already open.");
  }

  await softDeleteLiveCloseEntry(tx, {
    referenceType: CARRIER_TRIP_CLOSE_REFERENCE_TYPE,
    tripId: input.tripId,
    deletedById: input.updatedById,
  });
  await softDeleteLiveCloseEntry(tx, {
    referenceType: CARRIER_TRIP_CLOSE_EXPENSE_REFERENCE_TYPE,
    tripId: input.tripId,
    deletedById: input.updatedById,
  });

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
  // OWNER_DRAWING/OFFICE_OVERHEAD only - the selected Account to Dr
  // (see CarrierTripLine.expenseAccountId's own schema doc comment).
  expenseAccountId: string | null;
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
  // OWNER_DRAWING/OFFICE_OVERHEAD always Cr Driver Cash directly
  // (never Udhaar/an office account) - a real cash effect exactly
  // like EXPENSE_CASH, just excluded from Trip in Progress/Carrier
  // Profit/the Profit Report/Entry B (see this module's own TRIP
  // CLOSE header comment).
  if (lineType === "EXPENSE_CASH" || lineType === "DRIVER_SALARY" || lineType === "DEPOSIT_TO_OFFICE" || lineType === "OWNER_DRAWING" || lineType === "OFFICE_OVERHEAD") return -amount;
  return 0; // EXPENSE_CREDIT / EXPENSE_OFFICE
}

/** Driver Cash's own ledger-true balance AS OF the moment just before
 * `dateFrom` - the sum (debit - credit) of EVERY JournalLine ever
 * posted to this account (any source: an earlier Trip's own lines,
 * Daily Posting, a direct Journal Entry, the account's own opening-
 * balance entry) whose JournalEntry.entryDate is strictly before
 * `dateFrom` - EXCEPT this SAME Trip's own lines (and their own
 * reversals). This is the account's own "opening balance" (there is
 * no separate Account.openingBalance column - an opening balance is
 * itself just an early JournalLine, already included here) plus
 * every earlier line, nothing more and nothing less.
 *
 * The THIS-trip exclusion matters because a line can legitimately be
 * dated before its own Trip's dateFrom (a backdated entry, or a Trip
 * whose own start date was edited forward after lines already
 * existed) - getTripCashBook's own `lines` query is NOT date-filtered
 * (it shows every one of THIS Trip's own lines regardless of date),
 * so such a line is already counted once, there, as this Trip's own
 * IN/OUT. Counting it a SECOND time here, folded into Previous
 * Balance, would double-count it. Every OTHER Trip's own lines dated
 * before `dateFrom` are correctly still included - this exclusion is
 * scoped to `tripId` alone, never to the CARRIER_TRIP_LINE
 * referenceType in general.
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
async function getTripOpeningBalance(tx: Tx, tripId: string, dateFrom: Date, driverCashAccountId: string): Promise<number> {
  const result = await tx.journalLine.aggregate({
    where: {
      accountId: driverCashAccountId,
      journalEntry: {
        isDeleted: false,
        entryDate: { lt: dateFrom },
        NOT: { referenceType: { in: TRIP_LINE_REFERENCE_TYPES }, referenceId: tripId },
      },
    },
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

  const openingBalance = await getTripOpeningBalance(tx, tripId, trip.dateFrom, driverCashAccountId);

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
          expenseAccountId: l.expenseAccountId,
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
          expenseAccountId: null,
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
  const previousBalance = driverCashAccountId ? await getTripOpeningBalance(tx, tripId, trip.dateFrom, driverCashAccountId) : 0;

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
  /** This carrier's own "Trip in Progress" clearing account's own net
   * ledger balance (debit - credit, the ASSET convention) - every
   * currently-OPEN Trip's own expense/diesel/salary total, sitting
   * here until each Trip closes and moves it into Carrier Profit in
   * one entry (see lib/carrier-trip.ts's own module comment). 0 once
   * every Trip is closed - this account never carries a balance
   * across a closed Trip. */
  tripInProgress: number;
}

export async function getCarrierPageSummary(tx: Tx, carrierId: string): Promise<CarrierPageSummary> {
  const carrier = await tx.ownCarrier.findUnique({
    where: { id: carrierId },
    include: { driverCashAccount: true, ownCarrierIncomeAccount: true, tripInProgressAccount: true },
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

  let tripInProgress = 0;
  if (carrier.tripInProgressAccount) {
    const agg = await tx.journalLine.aggregate({
      where: { accountId: carrier.tripInProgressAccount.id, journalEntry: { isDeleted: false } },
      _sum: { debit: true, credit: true },
    });
    tripInProgress = round2(Number(agg._sum.debit || 0) - Number(agg._sum.credit || 0));
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

  return { driverCashBalance, vendorsPayable, totalVendorsPayable, challanReceivable, carrierProfit, tripInProgress };
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
