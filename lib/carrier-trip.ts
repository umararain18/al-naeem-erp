import type { Prisma, PrismaClient } from "@prisma/client";
import {
  resolveDocumentPartyAccount,
  getChallanEligibleParties,
  getChallanEligiblePartyAccountIds,
  getPhonchEligiblePartyAccountIds,
  getPrivatePhonchEligibleParties,
  getPrivatePhonchEligiblePartyAccountIds,
} from "@/lib/document-party-resolution";
import { assertPhonchReceiptNotExceeded } from "@/lib/phonch-accounting";
import { assertPrivatePhonchPaymentNotExceeded } from "@/lib/private-phonch-accounting";
import { getDriverCashBalance, getOrCreateOwnCarrierIncomeAccountId } from "@/lib/own-carrier";
import { getUnearnedRevenueAccountId } from "@/lib/gross-accounts";

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
  /** Required ONLY when resolveDocumentPartyAccount() cannot resolve
   * a single unambiguous party (e.g. a Challan with more than one
   * eligible Receivable party) - validated against that same
   * document's own eligible-party set, never accepted blindly. */
  counterAccountId?: string | null;
  createdById: string;
}

export interface PostSimpleInput {
  tripId: string;
  date: Date;
  description?: string | null;
  amount: number;
  createdById: string;
}

export interface PostExpenseInput extends PostSimpleInput {
  expenseAccountId: string;
}

export interface PostExpenseCreditInput extends PostExpenseInput {
  vendorPartyId: string;
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

/** OUT - trip expense paid by the driver from Driver Cash. Dr Expense / Cr Driver Cash. */
export async function postExpenseCashLine(tx: Tx, input: PostExpenseInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const expenseAccount = await tx.account.findUnique({ where: { id: input.expenseAccountId } });
  if (!expenseAccount || !expenseAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected expense account was not found or is inactive.");
  }
  if (expenseAccount.accountType !== "EXPENSE") {
    throw new CarrierTripError("INVALID_ACCOUNT_TYPE", "Selected account must be an Expense account.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || expenseAccount.accountName;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: input.expenseAccountId, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "EXPENSE_CASH", date: input.date, description, amount: input.amount, expenseAccountId: input.expenseAccountId }
  );
}

/** OUT - trip expense (e.g. Diesel paid via an office account) charged
 * directly to an office Cash/Bank account. Dr Expense / Cr office
 * account. Never touches Driver Cash - same "payment source never
 * moves Driver Cash" rule as EXPENSE_CREDIT. */
export async function postExpenseOfficeLine(tx: Tx, input: PostExpenseInput & { officeAccountId: string }) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const expenseAccount = await tx.account.findUnique({ where: { id: input.expenseAccountId } });
  if (!expenseAccount || !expenseAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected expense account was not found or is inactive.");
  }
  if (expenseAccount.accountType !== "EXPENSE") {
    throw new CarrierTripError("INVALID_ACCOUNT_TYPE", "Selected account must be an Expense account.");
  }

  const officeAccount = await tx.account.findUnique({ where: { id: input.officeAccountId } });
  if (!officeAccount || !officeAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected office account was not found or is inactive.");
  }

  const description = input.description?.trim() || `${expenseAccount.accountName} (Office Account - ${officeAccount.accountName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: input.expenseAccountId, debit: input.amount, credit: 0 },
        { accountId: input.officeAccountId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "EXPENSE_OFFICE", date: input.date, description, amount: input.amount, expenseAccountId: input.expenseAccountId, officeAccountId: input.officeAccountId }
  );
}

/** OUT - trip expense, Udhaar (credit) to a Vendor Party. Dr Expense / Cr Vendor. Never touches Driver Cash. */
export async function postExpenseCreditLine(tx: Tx, input: PostExpenseCreditInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const expenseAccount = await tx.account.findUnique({ where: { id: input.expenseAccountId } });
  if (!expenseAccount || !expenseAccount.isActive) {
    throw new CarrierTripError("INVALID_ACCOUNT", "Selected expense account was not found or is inactive.");
  }
  if (expenseAccount.accountType !== "EXPENSE") {
    throw new CarrierTripError("INVALID_ACCOUNT_TYPE", "Selected account must be an Expense account.");
  }

  const vendorParty = await tx.party.findUnique({ where: { id: input.vendorPartyId }, include: { account: true } });
  if (!vendorParty || !vendorParty.isActive || !vendorParty.account) {
    throw new CarrierTripError("INVALID_VENDOR", "Selected vendor party was not found or is inactive.");
  }

  const description = input.description?.trim() || `${expenseAccount.accountName} (Udhaar - ${vendorParty.partyName})`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: input.expenseAccountId, debit: input.amount, credit: 0 },
        { accountId: vendorParty.account.id, debit: 0, credit: input.amount },
      ],
    },
    {
      lineType: "EXPENSE_CREDIT",
      date: input.date,
      description,
      amount: input.amount,
      expenseAccountId: input.expenseAccountId,
      vendorPartyId: input.vendorPartyId,
    }
  );
}

/** OUT - salary paid to an Employee from Driver Cash. Dr Employee / Cr Driver Cash.
 * Reduces that Employee's own payable balance exactly like any other
 * payment to their account - no Payslip link assumed or required. */
export async function postDriverSalaryLine(tx: Tx, input: PostSalaryInput) {
  const trip = await getTripOrThrow(tx, input.tripId);
  if (trip.status !== "OPEN") throw new CarrierTripError("TRIP_CLOSED", "This Trip is closed.");
  if (input.amount <= 0) throw new CarrierTripError("INVALID_AMOUNT", "Amount must be greater than zero.");

  const employee = await tx.employee.findUnique({ where: { id: input.employeeId }, include: { account: true } });
  if (!employee || employee.isDeleted || !employee.account) {
    throw new CarrierTripError("INVALID_EMPLOYEE", "Selected employee was not found or has no linked account.");
  }

  const driverCashId = trip.carrier.driverCashAccount!.id;
  const description = input.description?.trim() || `Salary paid to ${employee.name}`;

  return createTripLineEntry(
    tx,
    trip,
    {
      date: input.date,
      createdById: input.createdById,
      description,
      lines: [
        { accountId: employee.account.id, debit: input.amount, credit: 0 },
        { accountId: driverCashId, debit: 0, credit: input.amount },
      ],
    },
    { lineType: "DRIVER_SALARY", date: input.date, description, amount: input.amount, employeeId: input.employeeId }
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
export async function postTripLineByType(
  tx: Tx,
  lineType: TripLineType,
  base: { tripId: string; date: Date; description: string | null; amount: number; createdById: string },
  rawInput: Record<string, unknown>
) {
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
      if (!rawInput.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Expense account is required.");
      return postExpenseCashLine(tx, { ...base, expenseAccountId: rawInput.expenseAccountId as string });
    case "EXPENSE_OFFICE":
      if (!rawInput.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Expense account is required.");
      if (!rawInput.officeAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Office account is required.");
      return postExpenseOfficeLine(tx, { ...base, expenseAccountId: rawInput.expenseAccountId as string, officeAccountId: rawInput.officeAccountId as string });
    case "EXPENSE_CREDIT":
      if (!rawInput.expenseAccountId) throw new CarrierTripError("MISSING_ACCOUNT", "Expense account is required.");
      if (!rawInput.vendorPartyId) throw new CarrierTripError("MISSING_VENDOR", "Vendor party is required for a credit expense.");
      return postExpenseCreditLine(tx, { ...base, expenseAccountId: rawInput.expenseAccountId as string, vendorPartyId: rawInput.vendorPartyId as string });
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
      entryDate: new Date(),
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
// Booking Income and this carrier's own "Own Carrier Income" by the
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

  const [unearnedRevenueAccountId, bookingIncomeAccountId, ownCarrierIncomeAccountId] = await Promise.all([
    getUnearnedRevenueAccountId(tx),
    getActiveBookingIncomeAccountId(tx),
    getOrCreateOwnCarrierIncomeAccountId(tx, link.trip.carrierId),
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
    lines.push({ accountId: ownCarrierIncomeAccountId, debit: 0, credit: carrierRentAmount, sourceType: "CHALLAN", sourceId: challan.id, sourceNumber: challan.challanNo });
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
  expenseAccountId: string | null;
  officeAccountId: string | null;
  vendorPartyId: string | null;
  employeeId: string | null;
}

/** EXPENSE_CREDIT/EXPENSE_OFFICE never move Driver Cash (neither is a
 * cash event for THIS account - Udhaar to a Vendor, or a direct office
 * account payment) - shown in the Out column for visibility, same as
 * the approved UI sketch, but excluded from the running balance. */
function cashDelta(lineType: string, amount: number): number {
  if (lineType === "COLLECTION" || lineType === "CASH_FROM_OFFICE") return amount;
  if (lineType === "EXPENSE_CASH" || lineType === "DRIVER_SALARY" || lineType === "DEPOSIT_TO_OFFICE") return -amount;
  return 0; // EXPENSE_CREDIT / EXPENSE_OFFICE
}

/** Driver Cash's own CURRENT ledger balance (one continuous account
 * across every Trip) minus THIS Trip's own total cash effect - never
 * a separately stored snapshot. Shared by getTripCashBook (its own
 * "Opening Balance" row) and getTripProfitReport (its own "Previous
 * Balance", carried from whatever the last closed Trip left behind -
 * the SAME number, since Driver Cash never resets between Trips). */
async function getTripOpeningBalance(tx: Tx, tripId: string, driverCashAccountId: string): Promise<number> {
  const lines = await tx.carrierTripLine.findMany({
    where: { tripId, isDeleted: false },
    select: { lineType: true, amount: true },
  });
  const currentBalance = await getDriverCashBalance(tx, driverCashAccountId);
  const thisTripNetCashEffect = round2(lines.reduce((s, l) => s + cashDelta(l.lineType, Number(l.amount)), 0));
  return round2(currentBalance - thisTripNetCashEffect);
}

export async function getTripCashBook(tx: Tx, tripId: string): Promise<{ openingBalance: number; rows: TripCashBookRow[]; closingBalance: number }> {
  const trip = await getTripOrThrow(tx, tripId);
  const driverCashAccountId = trip.carrier.driverCashAccount?.id;
  if (!driverCashAccountId) {
    throw new CarrierTripError("NO_DRIVER_CASH_ACCOUNT", "This carrier has no Driver Cash account - data inconsistency, contact support.");
  }
  const lines = await tx.carrierTripLine.findMany({
    where: { tripId, isDeleted: false },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  const openingBalance = await getTripOpeningBalance(tx, tripId, driverCashAccountId);

  let balance = openingBalance;
  const rows: TripCashBookRow[] = lines.map((l) => {
    const amount = Number(l.amount);
    const delta = cashDelta(l.lineType, amount);
    balance = round2(balance + delta);
    return {
      id: l.id,
      date: l.date.toISOString(),
      lineType: l.lineType,
      description: l.description || l.lineType,
      in: delta > 0 ? amount : l.lineType === "COLLECTION" || l.lineType === "CASH_FROM_OFFICE" ? amount : 0,
      out: delta < 0 || l.lineType === "EXPENSE_CREDIT" || l.lineType === "EXPENSE_OFFICE" ? amount : 0,
      balance,
      documentType: l.documentType,
      documentId: l.documentId,
      expenseAccountId: l.expenseAccountId,
      officeAccountId: l.officeAccountId,
      vendorPartyId: l.vendorPartyId,
      employeeId: l.employeeId,
    };
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
  expenses: { lineId: string; lineType: string; description: string; amount: number }[];
  totalCarrierExpense: number;
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
  const previousBalance = driverCashAccountId ? await getTripOpeningBalance(tx, tripId, driverCashAccountId) : 0;

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

  const expenses = lines.map((l) => ({ lineId: l.id, lineType: l.lineType, description: l.description || l.lineType, amount: round2(Number(l.amount)) }));

  const totalBiltyRent = round2(challanIncome.reduce((s, c) => s + c.biltyRent, 0));
  const totalCarrierRent = round2(challanIncome.reduce((s, c) => s + c.carrierRent, 0));
  const totalBookingIncome = round2(challanIncome.reduce((s, c) => s + c.bookingIncome, 0));
  const totalCarrierExpense = round2(expenses.reduce((s, e) => s + e.amount, 0));

  return {
    previousBalance,
    challanIncome,
    otherIncome,
    totalBiltyRent,
    totalCarrierRent,
    totalBookingIncome,
    expenses,
    totalCarrierExpense,
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
