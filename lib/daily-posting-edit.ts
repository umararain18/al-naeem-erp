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
import { auditUpdate, auditDelete, actorFromUser, diffFields, type AuditActor } from "@/lib/audit-log";
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

  // A removed line is never destroyed and never blocked by an existing
  // PaymentAllocation - see the WRITE section below, which splits it
  // (reparented, keeping its own id, so any PaymentAllocation.
  // journalLineId pointing at it stays valid) into its own new,
  // immediately-Binned JournalEntry instead of deleting it. Nothing to
  // guard against here.

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
  // A removed line's Dr/Cr pair is split into its own new JournalEntry
  // (same date, same referenceType/referenceId as the original) and
  // that new entry is immediately Binned - never a hard delete. The
  // counter line itself is REPARENTED (its own id preserved, only
  // journalEntryId changes), not deleted-and-recreated, so any
  // PaymentAllocation already pointing at it by id stays valid and
  // automatically stops counting toward any active financial view the
  // moment this entry is Binned (JournalEntry.isDeleted is already the
  // single source of truth every such view filters on - see e.g.
  // fetchAllocationBackedLines() in lib/party-outstanding.ts), then
  // automatically resumes counting if the split entry is later
  // restored. Its own new paired main leg is created fresh, mirroring
  // buildLinePair()'s mainDebit/mainCredit-from-direction formula
  // exactly, the same way every other main leg below is. The original
  // entry's remaining lines are completely unaffected and stay
  // balanced on their own.
  for (const removed of removedLines) {
    const splitEntry = await tx.journalEntry.create({
      data: {
        entryDate: entry.entryDate,
        referenceType: "DAILY_POSTING",
        referenceId: mainAccountId,
        description: removed.description || entry.description,
        createdById: currentUser.userId,
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: currentUser.userId,
      },
    });

    await tx.journalLine.update({
      where: { id: removed.id },
      data: { journalEntryId: splitEntry.id },
    });

    await tx.journalLine.create({
      data: {
        journalEntryId: splitEntry.id,
        accountId: mainAccountId,
        description: removed.description,
        debit: Number(removed.credit) > 0 ? Number(removed.credit) : 0,
        credit: Number(removed.debit) > 0 ? Number(removed.debit) : 0,
        sourceType: removed.sourceType,
        sourceId: removed.sourceId,
        sourceNumber: removed.sourceNumber,
      },
    });

    await auditDelete(tx, {
      actor: actorFromUser(currentUser),
      module: "CASH_BOOK",
      entityType: "JournalLine",
      entityId: removed.id,
      documentNo: mainAccount.accountName,
      description: `Removed line "${removed.description || removed.account.accountName}" (Rs. ${Number(removed.debit) || Number(removed.credit)}) from Daily Posting transaction on ${mainAccount.accountName} (entry ${entry.id}) - moved to Bin as entry ${splitEntry.id}, restorable from there`,
      ipAddress: requestCtx.ipAddress,
      userAgent: requestCtx.userAgent,
    });
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

// ============================================================
// RESTORE-TIME CEILING RE-CHECK - a Bin'd Daily Posting entry's
// document-linked lines (BILTY/PHONCH/PRIVATE_PHONCH/BILL) are already
// excluded from that document's own received/paid total by every
// read path (each filters on JournalEntry.isDeleted: false - see e.g.
// lib/phonch-accounting.ts, lib/bill-accounting.ts,
// lib/bilty-paid-verification.ts). Restoring un-excludes them, so if
// something else was posted against the SAME document while this
// entry sat in Bin, bringing it back could silently push that
// document over its ceiling (an over-receipt/over-payment the normal
// create/edit path would have rejected outright). Called by the
// generic JournalEntry restore route (app/api/accounting-transactions/
// [id]/restore) before it flips isDeleted back - a no-op for anything
// that isn't a DAILY_POSTING entry, or has no document-linked lines.
// ============================================================
export async function assertRestoreDoesNotExceedCeilings(tx: Tx, entryId: string): Promise<void> {
  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    include: { lines: true },
  });
  if (!entry || entry.referenceType !== "DAILY_POSTING" || !entry.referenceId) return;

  const mainAccountId = entry.referenceId;
  for (const line of entry.lines) {
    if (line.accountId === mainAccountId) continue; // the main Cash/Bank leg itself - not the document-linked counter line
    if (!line.sourceId) continue;

    const amount = Number(line.debit) > 0 ? Number(line.debit) : Number(line.credit);
    // direction here must be the MAIN account's own direction (the
    // convention every assert*NotExceeded function expects) - the
    // OPPOSITE sense of this counter line's own debit/credit, exactly
    // mirroring how startEdit()/the WRITE section above convert
    // between the two.
    const direction: "DEBIT" | "CREDIT" = Number(line.debit) > 0 ? "CREDIT" : "DEBIT";

    if (line.sourceType === "BILTY") {
      await assertPaidVerificationNotExceeded(tx, line.sourceId, line.accountId, amount, direction, entry.id);
    } else if (line.sourceType === "PHONCH") {
      await assertPhonchReceiptNotExceeded(tx, line.sourceId, line.accountId, amount, direction, entry.id);
    } else if (line.sourceType === "PRIVATE_PHONCH") {
      await assertPrivatePhonchPaymentNotExceeded(tx, line.sourceId, line.accountId, amount, direction, entry.id);
    } else if (line.sourceType === "BILL") {
      await assertBillReceiptNotExceeded(tx, line.sourceId, line.accountId, amount, direction, entry.id);
    }
  }
}
