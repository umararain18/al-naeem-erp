import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// MANUAL JOURNAL ENTRY - SHARED VALIDATION
//
// Used by BOTH create (POST /api/journal-entries) and edit
// (PATCH /api/journal-entries/[id]) so there is exactly one
// implementation of the business rules, never two. Mirrors the same
// "single shared validation module" approach already used for Daily
// Posting Edit (lib/daily-posting-validation.ts) this session.
//
// A Manual Journal Entry (JournalEntry.referenceType ===
// "MANUAL_JOURNAL") is intentionally independent of every
// operational document (Bilty/Challan) - v1 never sets
// JournalLine.sourceType/sourceId/sourceNumber on its own lines
// (approved decision #12). It may touch ANY active account,
// including CASH/BANK and PARTY accounts - Trial Balance/P&L/
// Receivable/Payable/Party Ledger/General Ledger all already compute
// purely from JournalLine.debit/credit grouped by account, with zero
// referenceType/sourceType filtering (verified directly in each
// report's own route during the Phase 1 diagnostic) - so a correctly
// balanced Manual Journal Entry affects them all automatically, with
// no special-casing required here.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

const EPS = 0.01;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export class ManualJournalValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualJournalValidationError";
    this.status = status;
  }
}

export interface ManualJournalLineInput {
  accountId: string;
  description: string;
  debit: number;
  credit: number;
}

export interface ResolvedManualJournalLine {
  accountId: string;
  description: string;
  debit: number;
  credit: number;
  accountName: string;
  category: string;
}

// ------------------------------------------------------------
// STEP 1 - shape validation (no DB). Applied per line, with a
// 1-based line number in every message so the UI can point at the
// exact row.
// ------------------------------------------------------------
export function validateManualJournalLineShape(
  line: ManualJournalLineInput,
  lineNumber: number
): void {
  if (!line.accountId || !line.accountId.trim()) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: Account is required.`);
  }

  if (!line.description || !line.description.trim()) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: Description is required.`);
  }

  const debit = round2(Number(line.debit) || 0);
  const credit = round2(Number(line.credit) || 0);

  if (debit < 0 || credit < 0) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: Debit and Credit cannot be negative.`);
  }

  if (debit > 0 && credit > 0) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: A line cannot have both Debit and Credit.`);
  }

  if (debit === 0 && credit === 0) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: Enter either Debit or Credit - a line cannot have neither.`);
  }
}

// ------------------------------------------------------------
// STEP 2 - verify the account is real, active, and (when it is a
// PARTY-category account) belongs to a real, active Party. Never
// trusts the client's accountName/category - always re-derived from
// the database, matching the "never trust client-supplied document
// data" discipline already established for Daily Posting.
// ------------------------------------------------------------
export async function verifyManualJournalAccount(
  tx: Tx,
  accountId: string,
  lineNumber: number
): Promise<{ accountName: string; category: string }> {
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: {
      accountName: true,
      category: true,
      isActive: true,
      partyId: true,
      party: { select: { isActive: true } },
    },
  });

  if (!account) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: Selected account was not found.`);
  }

  if (!account.isActive) {
    throw new ManualJournalValidationError(`Line ${lineNumber}: Account "${account.accountName}" is inactive.`);
  }

  if (account.category === "PARTY") {
    if (!account.partyId || !account.party) {
      throw new ManualJournalValidationError(
        `Line ${lineNumber}: Account "${account.accountName}" is a Party account with no linked Party.`
      );
    }
    if (!account.party.isActive) {
      throw new ManualJournalValidationError(
        `Line ${lineNumber}: The Party linked to account "${account.accountName}" is inactive.`
      );
    }
  }

  return { accountName: account.accountName, category: account.category };
}

// ------------------------------------------------------------
// ORCHESTRATOR - validates and resolves ONE line. Returns the
// normalized line (rounded amounts, real account name/category).
// ------------------------------------------------------------
export async function resolveManualJournalLine(
  tx: Tx,
  line: ManualJournalLineInput,
  lineNumber: number
): Promise<ResolvedManualJournalLine> {
  validateManualJournalLineShape(line, lineNumber);

  const { accountName, category } = await verifyManualJournalAccount(tx, line.accountId, lineNumber);

  return {
    accountId: line.accountId,
    description: line.description.trim(),
    debit: round2(Number(line.debit) || 0),
    credit: round2(Number(line.credit) || 0),
    accountName,
    category,
  };
}

// ------------------------------------------------------------
// WHOLE-ENTRY VALIDATION - at least 2 lines, every line resolved,
// total debit === total credit. Returns the fully resolved lines;
// throws on the first failure (never partially validates).
// ------------------------------------------------------------
export async function resolveManualJournalEntry(
  tx: Tx,
  lines: ManualJournalLineInput[]
): Promise<{ resolvedLines: ResolvedManualJournalLine[]; totalDebit: number; totalCredit: number }> {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ManualJournalValidationError("A Journal Entry requires at least 2 lines.");
  }

  const resolvedLines: ResolvedManualJournalLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    resolvedLines.push(await resolveManualJournalLine(tx, lines[i], i + 1));
  }

  const totalDebit = round2(resolvedLines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredit = round2(resolvedLines.reduce((sum, l) => sum + l.credit, 0));

  if (Math.abs(totalDebit - totalCredit) > EPS) {
    throw new ManualJournalValidationError(
      `Journal Entry is not balanced. Total Debit (${totalDebit}) must equal Total Credit (${totalCredit}).`
    );
  }

  return { resolvedLines, totalDebit, totalCredit };
}

export function isValidEntryDate(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}
