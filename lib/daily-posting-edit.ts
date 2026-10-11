import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DAILY_POSTING_SOURCE_TYPES,
  DailyPostingValidationError,
  resolveDailyPostingLine,
  type DailyPostingSourceType,
} from "@/lib/daily-posting-validation";
import { assertPaidVerificationNotExceeded } from "@/lib/bilty-paid-verification";
import { assertPhonchReceiptNotExceeded } from "@/lib/phonch-accounting";
import { assertPrivatePhonchPaymentNotExceeded } from "@/lib/private-phonch-accounting";
import { assertBillReceiptNotExceeded } from "@/lib/bill-accounting";
import { getAllocatedAmountForPayment } from "@/lib/payment-allocation";
import { auditUpdate, actorFromUser, diffFields, type AuditActor } from "@/lib/audit-log";
import type { Permission } from "@/lib/permissions";

type Tx = PrismaClient | Prisma.TransactionClient;

// ============================================================
// SHARED CORE - edits ONE complete Daily Posting JournalEntry in
// place. Extracted unchanged from app/api/daily-posting/[id]/route.ts
// (PATCH) so that BOTH the single-entry PATCH route AND the day-wise
// batch "Save Day" route (app/api/daily-posting/day/route.ts) call
// the EXACT same validation/resolution/write logic - never two
// parallel implementations of the same accounting rules. The caller
// is responsible for: auth/permission checks, parsing/validating the
// request shape into DailyPostingLineInput[], and wrapping ONE or
// SEVERAL calls to this function in its own prisma.$transaction (this
// function never opens its own transaction - it always runs inside
// the caller's `tx`, which is what lets "Save Day" commit several
// entries atomically and roll back all of them together on any single
// failure).
// ============================================================

export interface DailyPostingLineInput {
  // Present only for an EXISTING counter line being kept/edited -
  // absent for a brand-new line added in edit mode. Never trusted
  // blindly: re-verified below that it actually belongs to THIS
  // entry before anything is touched.
  id?: string;
  counterAccountId?: string;
  description: string;
  amount: number;
  direction: "DEBIT" | "CREDIT";
  sourceType: string;
  sourceId?: string;
  sourceNumber?: string;
}

export interface UpdateDailyPostingEntryInput {
  tx: Tx;
  id: string;
  date: string;
  lines: DailyPostingLineInput[];
  currentUser: { userId: string; username: string; role: string };
  hasPermission: (permission: Permission) => boolean;
  requestCtx: { ipAddress: string | null; userAgent: string | null };
}

function isValidDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

export async function updateDailyPostingEntry({
  tx,
  id,
  date,
  lines,
  currentUser,
  hasPermission,
  requestCtx,
}: UpdateDailyPostingEntryInput) {
  if (!isValidDate(date)) {
    throw new DailyPostingValidationError("Invalid date");
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new DailyPostingValidationError("At least one line is required - to remove the last remaining line, Bin the whole transaction instead.");
  }

  const entry = await tx.journalEntry.findUnique({
    where: { id },
    include: { lines: { include: { account: true } } },
  });

  if (!entry) {
    throw new DailyPostingValidationError("Transaction not found", 404);
  }
  if (entry.referenceType !== "DAILY_POSTING") {
    throw new DailyPostingValidationError("This is not a Daily Posting transaction and cannot be edited here.");
  }
  if (entry.isDeleted) {
    throw new DailyPostingValidationError("Binned transactions cannot be edited. Restore the transaction first.");
  }

  // Identify the Main account via the entry's own referenceId - set
  // once at Create time to the user-selected Main Account (see
  // buildLinePair() in app/api/daily-posting/route.ts:
  // referenceId: data.accountId) and never touched by any edit since,
  // because the Main Account identity itself is never changeable
  // through this endpoint. This is the ONLY reliable signal: counting
  // distinct Cash/Bank-category accounts can NOT tell "the selected
  // Main Account" apart from "a Cash/Bank counter account" - a
  // legitimate transfer (e.g. Office Cash -> Umar Bank) has exactly
  // that shape, two distinct Cash/Bank accounts in one entry, and
  // must remain editable like any other Daily Posting transaction.
  const mainAccountId = entry.referenceId;
  const mainLine = mainAccountId ? entry.lines.find((l) => l.accountId === mainAccountId) : undefined;
  if (!mainAccountId || !mainLine) {
    throw new DailyPostingValidationError(
      "This transaction's Main Account could not be reliably identified (missing or stale reference) and cannot be edited here. Use Bin to remove it if needed."
    );
  }
  if (mainLine.account.category !== "CASH" && mainLine.account.category !== "BANK") {
    throw new DailyPostingValidationError(
      "This transaction's recorded Main Account is not a Cash/Bank account and cannot be edited here. Use Bin to remove it if needed."
    );
  }
  const mainAccount = mainLine.account;

  const existingCounterLines = entry.lines.filter((l) => l.accountId !== mainAccountId);
  const existingCounterLineById = new Map(existingCounterLines.map((l) => [l.id, l]));

  // Every submitted line carrying an `id` must actually belong to
  // this entry's own counter lines - never trust a client-supplied id
  // blindly (would otherwise let one transaction's edit silently
  // touch another's JournalLine).
  for (const line of lines) {
    if (line.id && !existingCounterLineById.has(line.id)) {
      throw new DailyPostingValidationError("One or more lines do not belong to this transaction.");
    }
  }

  const submittedIds = new Set(lines.filter((l) => l.id).map((l) => l.id as string));
  const removedLines = existingCounterLines.filter((l) => !submittedIds.has(l.id));

  // --------------------------------------------------------------
  // REMOVED LINES - blocked when any PaymentAllocation exists, exactly
  // mirroring PATCH /api/cash-book/[id]'s own "Gap A" guard (never
  // silently orphan an allocation that references this line).
  // --------------------------------------------------------------
  for (const removed of removedLines) {
    const allocated = await getAllocatedAmountForPayment(tx, removed.id);
    if (allocated > 0.009) {
      throw new DailyPostingValidationError(
        `Cannot remove the line for "${removed.description || removed.account.accountName}" - Rs. ${allocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
      );
    }
  }

  // --------------------------------------------------------------
  // RESOLVE EVERY SUBMITTED LINE - ONE uniform pipeline for both a
  // brand-new line and an existing one. Counter Account is NOT locked
  // on an existing line: resolveDailyPostingLine() treats whatever the
  // user submits as a manually-supplied Counter Account and
  // re-validates it exactly as Create does (existence/active,
  // Bilty/Challan/Private Phonch legitimacy against the document's own
  // eligible parties, PARTY<->CASH/BANK restriction) - a change that
  // would violate any of those rules is rejected with the same clear
  // message Create itself gives, never silently coerced. The
  // PaymentAllocation-safety guard for an account change on an
  // already-allocated line lives below, in CEILING CHECKS, once every
  // line's final Counter Account is known.
  // --------------------------------------------------------------
  const resolvedLines: {
    id: string | null;
    counterAccountId: string;
    description: string;
    amount: number;
    direction: "DEBIT" | "CREDIT";
    sourceType: DailyPostingSourceType;
    sourceId: string | null;
    sourceNumber: string | null;
  }[] = [];

  for (const line of lines) {
    const requestedSourceType = line.sourceType.trim();
    if (!DAILY_POSTING_SOURCE_TYPES.includes(requestedSourceType as DailyPostingSourceType)) {
      throw new DailyPostingValidationError(`Invalid document type for line "${line.description}"`);
    }
    if (requestedSourceType === "CHALLAN" && !hasPermission("challan.view")) {
      throw new DailyPostingValidationError("Forbidden", 403);
    }
    if (requestedSourceType === "BILTY" && !hasPermission("bilty.view")) {
      throw new DailyPostingValidationError("Forbidden", 403);
    }

    const existing = line.id ? existingCounterLineById.get(line.id) : undefined;
    const finalSourceType = requestedSourceType as DailyPostingSourceType;

    const resolved = await resolveDailyPostingLine({
      tx,
      mainAccountId,
      mainCategory: mainAccount.category,
      sourceType: finalSourceType,
      sourceId: line.sourceId,
      sourceNumber: line.sourceNumber,
      counterAccountId: line.counterAccountId,
      direction: line.direction,
    });

    resolvedLines.push({
      id: existing?.id || null,
      counterAccountId: resolved.counterAccountId,
      description: line.description.trim(),
      amount: line.amount,
      direction: line.direction,
      sourceType: resolved.sourceType,
      sourceId: resolved.sourceId,
      sourceNumber: resolved.sourceNumber,
    });
  }

  // --------------------------------------------------------------
  // CEILING CHECKS - same guards the simple-edit PATCH already runs
  // per line, this entry's own prior contribution always excluded via
  // excludeJournalEntryId so editing in place never double-counts
  // against itself.
  // --------------------------------------------------------------
  for (const line of resolvedLines) {
    if (line.sourceType === "BILTY" && line.sourceId) {
      await assertPaidVerificationNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
    }
    if (line.sourceType === "PHONCH" && line.sourceId) {
      await assertPhonchReceiptNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
    }
    if (line.sourceType === "PRIVATE_PHONCH" && line.sourceId) {
      await assertPrivatePhonchPaymentNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
    }
    if (line.sourceType === "BILL" && line.sourceId) {
      await assertBillReceiptNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction, entry.id);
    }
    // PAYMENT ALLOCATION SAFETY - an existing line that already has a
    // PaymentAllocation against it can neither be reduced below the
    // allocated amount nor have its Counter Account changed, in either
    // case because doing so would silently misrepresent which Party
    // the allocation was actually made against.
    if (line.id) {
      const existingLine = existingCounterLineById.get(line.id)!;
      if (existingLine.account.category === "PARTY") {
        const allocated = await getAllocatedAmountForPayment(tx, line.id);
        if (allocated > 0.009 && line.counterAccountId !== existingLine.accountId) {
          throw new DailyPostingValidationError(
            `Cannot change the Counter Account for "${line.description}" - Rs. ${allocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
          );
        }
        if (allocated > line.amount + 0.009) {
          throw new DailyPostingValidationError(
            `Cannot reduce "${line.description}" to ${line.amount} - ${allocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
          );
        }
      }
    }
  }

  // --------------------------------------------------------------
  // WRITE - counter lines are updated/created/deleted individually
  // (never deleted-and-recreated wholesale). The Main Account side is
  // fully rebuilt every save - safe because it is derived and never
  // referenced by PaymentAllocation or anything else by line id - but
  // rebuilt as ONE paired leg PER counter line, mirroring
  // buildLinePair() in app/api/daily-posting/route.ts (Create)
  // exactly: same description/sourceType/sourceId/sourceNumber as its
  // counter line, same mainDebit/mainCredit-from-direction formula.
  // This keeps Edit/Save Day producing the identical entry shape
  // Create does, so e.g. Cash Book's per-account ledger still shows
  // one row per counter line instead of a single collapsed net line.
  // --------------------------------------------------------------
  for (const removed of removedLines) {
    await tx.journalLine.delete({ where: { id: removed.id } });
  }

  for (const line of resolvedLines) {
    const counterDebit = line.direction === "CREDIT" ? line.amount : 0;
    const counterCredit = line.direction === "DEBIT" ? line.amount : 0;
    if (line.id) {
      await tx.journalLine.update({
        where: { id: line.id },
        data: {
          accountId: line.counterAccountId,
          description: line.description,
          debit: counterDebit,
          credit: counterCredit,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          sourceNumber: line.sourceNumber,
        },
      });
    } else {
      await tx.journalLine.create({
        data: {
          journalEntryId: entry.id,
          accountId: line.counterAccountId,
          description: line.description,
          debit: counterDebit,
          credit: counterCredit,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          sourceNumber: line.sourceNumber,
        },
      });
    }
  }

  await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id, accountId: mainAccountId } });
  await tx.journalLine.createMany({
    data: resolvedLines.map((line) => ({
      journalEntryId: entry.id,
      accountId: mainAccountId,
      description: line.description,
      debit: line.direction === "DEBIT" ? line.amount : 0,
      credit: line.direction === "CREDIT" ? line.amount : 0,
      sourceType: line.sourceType,
      sourceId: line.sourceId,
      sourceNumber: line.sourceNumber,
    })),
  });

  const updatedEntry = await tx.journalEntry.update({
    where: { id: entry.id },
    data: {
      entryDate: new Date(`${date}T00:00:00`),
    },
    include: { lines: { include: { account: true } } },
  });

  const changedFields = diffFields(
    { date: entry.entryDate, lineCount: entry.lines.length },
    { date: updatedEntry.entryDate, lineCount: resolvedLines.length * 2 },
    ["date", "lineCount"]
  );
  const actor: AuditActor = actorFromUser(currentUser);
  await auditUpdate(tx, {
    actor,
    module: "CASH_BOOK",
    entityType: "JournalEntry",
    entityId: entry.id,
    documentNo: mainAccount.accountName,
    description: `Edited Daily Posting transaction on ${mainAccount.accountName} (${resolvedLines.length} counter line${resolvedLines.length === 1 ? "" : "s"}, ${removedLines.length} removed)`,
    changedFields,
    ipAddress: requestCtx.ipAddress,
    userAgent: requestCtx.userAgent,
  });

  return updatedEntry;
}
