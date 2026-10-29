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
import { getDriverCashBalance } from "@/lib/own-carrier";

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

async function assertDocumentExists(tx: Tx, documentType: CarrierTripDocumentType, documentId: string): Promise<{ label: string }> {
  if (documentType === "CHALLAN") {
    const challan = await tx.challan.findUnique({ where: { id: documentId }, select: { challanNo: true, isDeleted: true } });
    if (!challan || challan.isDeleted) throw new CarrierTripError("DOCUMENT_NOT_FOUND", "Challan not found.");
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
  const { label } = await assertDocumentExists(tx, input.documentType, input.documentId);

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
}

/** EXPENSE_CREDIT never moves Driver Cash (it's a Udhaar to a Vendor,
 * not a cash event) - shown in the Out column for visibility, same as
 * the approved UI sketch, but excluded from the running balance. */
function cashDelta(lineType: string, amount: number): number {
  if (lineType === "COLLECTION" || lineType === "CASH_FROM_OFFICE") return amount;
  if (lineType === "EXPENSE_CASH" || lineType === "DRIVER_SALARY" || lineType === "DEPOSIT_TO_OFFICE") return -amount;
  return 0; // EXPENSE_CREDIT
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

  // Opening balance = Driver Cash's own CURRENT ledger balance (one
  // continuous account across every Trip - see
  // CarrierTripStatus/openCarrierWithAccount's own doc comments)
  // minus THIS Trip's own total cash effect - never a separately
  // stored snapshot that could drift from the real ledger.
  const currentBalance = await getDriverCashBalance(tx, driverCashAccountId);
  const thisTripNetCashEffect = round2(lines.reduce((s, l) => s + cashDelta(l.lineType, Number(l.amount)), 0));
  const openingBalance = round2(currentBalance - thisTripNetCashEffect);

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
      out: delta < 0 || l.lineType === "EXPENSE_CREDIT" ? amount : 0,
      balance,
      documentType: l.documentType,
      documentId: l.documentId,
    };
  });

  return { openingBalance, rows, closingBalance: balance };
}

export interface TripProfitReport {
  income: { documentType: string; documentId: string; label: string; amount: number }[];
  totalIncome: number;
  expenses: { lineId: string; description: string; amount: number }[];
  totalExpenses: number;
  netProfit: number;
}

/**
 * Income side = each linked document's own earning figure for an
 * own-carrier trip: a Challan's own carrierRent (what ANC would
 * otherwise have paid an EXTERNAL transporter - see this module's
 * own header comment); a Phonch's own vehicle-level Delivery Charges;
 * a Private Phonch's own vehicle-level Net Rent (totalRent -
 * deliveryCharges). Deliberately a simple, direct read of each
 * document's own already-existing fields - never a second settlement
 * calculation - adequate for a profit ESTIMATE; the authoritative
 * accounting for each document is unchanged and lives entirely in
 * its own existing module.
 *
 * Expense side = this Trip's own EXPENSE_CASH + EXPENSE_CREDIT +
 * DRIVER_SALARY lines (every real cost of running the trip,
 * regardless of whether Driver Cash or a Vendor Udhaar paid it).
 * CASH_FROM_OFFICE/DEPOSIT_TO_OFFICE/COLLECTION are pure cash
 * movements, never expenses.
 */
export async function getTripProfitReport(tx: Tx, tripId: string): Promise<TripProfitReport> {
  await getTripOrThrow(tx, tripId);

  const [documents, lines] = await Promise.all([
    tx.carrierTripDocument.findMany({ where: { tripId, unlinkedAt: null } }),
    tx.carrierTripLine.findMany({
      where: { tripId, isDeleted: false, lineType: { in: ["EXPENSE_CASH", "EXPENSE_CREDIT", "DRIVER_SALARY"] } },
    }),
  ]);

  const income: TripProfitReport["income"] = [];
  for (const doc of documents) {
    if (doc.documentType === "CHALLAN") {
      const challan = await tx.challan.findUnique({ where: { id: doc.documentId }, select: { challanNo: true, carrierRent: true } });
      if (challan) income.push({ documentType: "CHALLAN", documentId: doc.documentId, label: `Challan ${challan.challanNo}`, amount: round2(Number(challan.carrierRent)) });
    } else if (doc.documentType === "PHONCH") {
      const phonch = await tx.phonch.findUnique({
        where: { id: doc.documentId },
        select: { phonchNo: true, vehicles: { select: { deliveryCharges: true } } },
      });
      if (phonch) {
        const amount = round2(phonch.vehicles.reduce((s, v) => s + Number(v.deliveryCharges), 0));
        income.push({ documentType: "PHONCH", documentId: doc.documentId, label: `Phonch ${phonch.phonchNo}`, amount });
      }
    } else {
      const privatePhonch = await tx.privatePhonch.findUnique({
        where: { id: doc.documentId },
        select: { phonchNo: true, vehicles: { select: { totalRent: true, deliveryCharges: true } } },
      });
      if (privatePhonch) {
        const amount = round2(privatePhonch.vehicles.reduce((s, v) => s + (Number(v.totalRent) - Number(v.deliveryCharges)), 0));
        income.push({ documentType: "PRIVATE_PHONCH", documentId: doc.documentId, label: `Private Phonch ${privatePhonch.phonchNo}`, amount });
      }
    }
  }

  const expenses = lines.map((l) => ({ lineId: l.id, description: l.description || l.lineType, amount: round2(Number(l.amount)) }));

  const totalIncome = round2(income.reduce((s, i) => s + i.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, e) => s + e.amount, 0));

  return { income, totalIncome, expenses, totalExpenses, netProfit: round2(totalIncome - totalExpenses) };
}
