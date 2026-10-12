import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  BIN_REASON_TOO_OLD,
  BIN_REASON_SETTLED_DOCUMENT,
  BIN_REASON_OPENING_BALANCE,
  isOlderThanBinThreshold,
  isLinkedToSettledDocument,
} from "@/lib/cash-bank-bin-policy";
import { isOpeningBalanceReferenceType } from "@/lib/account-opening-balance";
import {
  DAILY_POSTING_SOURCE_TYPES,
  DailyPostingValidationError,
  resolveDailyPostingLine,
  type DailyPostingSourceType,
} from "@/lib/daily-posting-validation";
import {
  assertPaidVerificationNotExceeded,
  BiltyPaidVerificationError,
} from "@/lib/bilty-paid-verification";
import {
  assertPhonchReceiptNotExceeded,
  PhonchAccountingError,
} from "@/lib/phonch-accounting";
import {
  assertPrivatePhonchPaymentNotExceeded,
  PrivatePhonchAccountingError,
} from "@/lib/private-phonch-accounting";
import { BillAccountingError } from "@/lib/bill-accounting";
import { getAllocatedAmountForPayment } from "@/lib/payment-allocation";
import { auditUpdate, auditDelete, actorFromUser, requestContext, diffFields } from "@/lib/audit-log";
import { updateDailyPostingEntry, type DailyPostingLineInput } from "@/lib/daily-posting-edit";
import { toISODate } from "@/lib/date-range";

function isValidDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

export async function PATCH(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    // ============================================================
    // AUTHENTICATION
    // ============================================================

    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    // ============================================================
    // PERMISSION
    // ============================================================

    if (!hasPermission(currentUser, "accounts.edit")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    // ============================================================
    // JOURNAL LINE ID
    // ============================================================

    const { id } = await context.params;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction ID is required",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // REQUEST BODY
    // ============================================================

    const body = await request.json();

    const {
      date,
      document,
      documentNo,
      // Only meaningful for a BILTY/CHALLAN Daily Posting line - the real
      // database id of the document the user selected via
      // DocumentSearchSelect (never trusted blindly; re-verified below by
      // resolveDailyPostingLine -> verifyDailyPostingDocument, exactly
      // like a brand-new Daily Posting submission). Absent/ignored for
      // every other row.
      sourceId: requestedSourceId,
      description,
      debit,
      credit,
    } = body;

    // ============================================================
    // BASIC VALIDATION
    // ============================================================

    if (!date || typeof date !== "string") {
      return NextResponse.json(
        {
          success: false,
          message: "Date is required",
        },
        { status: 400 }
      );
    }

    if (!isValidDate(date)) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid date",
        },
        { status: 400 }
      );
    }

    const debitAmount = Number(debit) || 0;
    const creditAmount = Number(credit) || 0;

    if (debitAmount < 0 || creditAmount < 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Debit and credit cannot be negative",
        },
        { status: 400 }
      );
    }

    if (
      (debitAmount > 0 && creditAmount > 0) ||
      (debitAmount === 0 && creditAmount === 0)
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Transaction must contain either debit or credit",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // FIND CURRENT JOURNAL LINE
    // ============================================================

    const currentLine =
      await prisma.journalLine.findUnique({
        where: {
          id,
        },

        include: {
          journalEntry: {
            include: {
              lines: true,
            },
          },

          account: true,
        },
      });

    if (!currentLine) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction not found",
        },
        { status: 404 }
      );
    }

    if (currentLine.journalEntry.isDeleted) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Binned transactions cannot be edited. Restore the transaction first.",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // SAFETY CHECK
    //
    // This API is specifically for Cash Book transactions.
    // ============================================================

    if (
      currentLine.account.category !== "CASH" &&
      currentLine.account.category !== "BANK"
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction does not belong to a Cash/Bank account",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // OPENING BALANCE - never editable here, for anyone, with no
    // Super Admin override (unlike the age/settled-document policy
    // below). Edit only from the Accounts page (or the Party page,
    // for a Party's own opening balance).
    // ============================================================

    if (isOpeningBalanceReferenceType(currentLine.journalEntry.referenceType)) {
      return NextResponse.json(
        {
          success: false,
          message: BIN_REASON_OPENING_BALANCE,
        },
        { status: 400 }
      );
    }

    // ============================================================
    // FIND COUNTER LINE
    //
    // Daily Posting creates a pair:
    //
    // Cash/Bank line
    // +
    // Counter account line
    //
    // We identify the matching line from the same JournalEntry.
    // ============================================================

    const counterLines =
      currentLine.journalEntry.lines.filter(
        (line) => line.id !== currentLine.id
      );

    if (counterLines.length !== 1) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction has an unsupported journal structure. Edit was not applied.",
        },
        { status: 400 }
      );
    }

    const counterLine = counterLines[0];

    // ============================================================
    // DAILY POSTING: FULL BUSINESS VALIDATION, SAME AS CREATE
    //
    // A Daily Posting transaction's Document/Document No. identify a
    // real Bilty/Challan (or DIRECT, meaning no document). Editing it
    // is treated as EXACTLY the same business operation as posting a
    // brand-new Daily Posting line (see lib/daily-posting-validation.ts,
    // extracted from POST /api/daily-posting's own per-line logic) -
    // the only difference is that this ONE existing JournalEntry is
    // replaced in place rather than a new one being created, and its
    // OWN prior contribution is excluded before re-checking guards like
    // the Paid-verification ceiling (lib/bilty-paid-verification.ts).
    // Every other Cash Book row (referenceType e.g. SETTLEMENT, or
    // none) is completely unaffected - its existing free-text
    // document/documentNo behavior below is unchanged.
    // ============================================================

    const isDailyPosting = currentLine.journalEntry.referenceType === "DAILY_POSTING";

    // Manual Journal is v1 "never document-linked" (see
    // lib/manual-journal-validation.ts / app/api/journal-entries/route.ts -
    // its lines are created with sourceType/sourceId/sourceNumber all
    // null, always). The generic branch below otherwise lets the
    // free-text `document`/`documentNo` fields overwrite a line's
    // sourceType/sourceNumber with no validation - fine for the
    // referenceTypes that already have their own free-text document
    // convention (e.g. SETTLEMENT), but it must NOT apply to a Manual
    // Journal line, or Cash Book editing could silently put an
    // arbitrary document type/number onto it. sourceId is never
    // touched by the generic branch already, so only sourceType/
    // sourceNumber need gating here.
    const isManualJournal = currentLine.journalEntry.referenceType === "MANUAL_JOURNAL";

    // ============================================================
    // NEW VALUES
    // ============================================================

    const newDebit = debitAmount;
    const newCredit = creditAmount;

    // Counter account must always be opposite.
    const counterDebit =
      newCredit;

    const counterCredit =
      newDebit;

    if (isDailyPosting) {
      const requestedSourceType =
        typeof document === "string" && document.trim()
          ? document.trim()
          : currentLine.sourceType || "DIRECT";

      if (!DAILY_POSTING_SOURCE_TYPES.includes(requestedSourceType as DailyPostingSourceType)) {
        return NextResponse.json(
          { success: false, message: "Invalid document type" },
          { status: 400 }
        );
      }

      if (requestedSourceType === "CHALLAN" && !hasPermission(currentUser, "challan.view")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }
      if (requestedSourceType === "BILTY" && !hasPermission(currentUser, "bilty.view")) {
        return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
      }

      try {
        const updatedEntry = await prisma.$transaction(
          async (tx) => {
            const finalSourceType: DailyPostingSourceType = requestedSourceType as DailyPostingSourceType;
            let finalSourceId: string | null = currentLine.sourceId;
            let finalSourceNumber: string | null = currentLine.sourceNumber;
            let finalCounterAccountId = counterLine.accountId;

            if (finalSourceType === "DIRECT") {
              finalSourceId = null;
              finalSourceNumber = null;
              // Counter account reassignment is not supported here -
              // same restriction already applied to the Main account.
            } else if (finalSourceType === "CHALLAN" || finalSourceType === "BILTY") {
              const requestedId =
                typeof requestedSourceId === "string" && requestedSourceId.trim()
                  ? requestedSourceId.trim()
                  : undefined;

              const effectiveSourceId =
                requestedId ||
                (finalSourceType === currentLine.sourceType ? currentLine.sourceId || undefined : undefined);

              if (!effectiveSourceId) {
                throw new DailyPostingValidationError("Source ID is required for document-linked entries");
              }

              // Same document (same type + same id) as before this edit?
              // Only then is the EXISTING Counter Account re-validated as
              // a manually-supplied one (never silently re-resolved away
              // from a party that was already fine). A genuinely changed
              // document has no existing Counter Account to fall back to
              // and must auto-resolve, exactly like a brand-new posting
              // with none supplied.
              const documentUnchanged =
                finalSourceType === currentLine.sourceType && effectiveSourceId === currentLine.sourceId;

              const resolved = await resolveDailyPostingLine({
                tx,
                mainAccountId: currentLine.accountId,
                mainCategory: currentLine.account.category,
                sourceType: finalSourceType,
                sourceId: effectiveSourceId,
                sourceNumber: typeof documentNo === "string" ? documentNo.trim() : undefined,
                counterAccountId: documentUnchanged ? counterLine.accountId : undefined,
                direction: newDebit > 0 ? "DEBIT" : "CREDIT",
              });

              finalSourceId = resolved.sourceId;
              finalSourceNumber = resolved.sourceNumber;
              finalCounterAccountId = resolved.counterAccountId;
            } else {
              // PARTY / PHONCH / BILL / ACCOUNT - free text, exactly like
              // Create's own lack of search-based validation for these
              // types. Counter account is not reassigned.
              finalSourceId = null;
              finalSourceNumber =
                typeof documentNo === "string" ? documentNo.trim() || null : currentLine.sourceNumber;
            }

            // PAID VERIFICATION CEILING - the entry's OWN prior
            // contribution is excluded (see
            // lib/bilty-paid-verification.ts's excludeJournalEntryId),
            // so only the NEW amount is checked against the Bilty's
            // truly remaining unverified Paid amount - never additive
            // against the old value being replaced.
            if (finalSourceType === "BILTY" && finalSourceId) {
              const mainDirection: "DEBIT" | "CREDIT" = newDebit > 0 ? "DEBIT" : "CREDIT";
              const mainAmount = newDebit > 0 ? newDebit : newCredit;
              await assertPaidVerificationNotExceeded(
                tx,
                finalSourceId,
                finalCounterAccountId,
                mainAmount,
                mainDirection,
                currentLine.journalEntryId
              );
            }

            // Same ceiling, applied to a Phonch's Total Amount instead
            // of a Bilty's Paid amount - see lib/phonch-accounting.ts's
            // assertPhonchReceiptNotExceeded().
            if (finalSourceType === "PHONCH" && finalSourceId) {
              const mainDirection: "DEBIT" | "CREDIT" = newDebit > 0 ? "DEBIT" : "CREDIT";
              const mainAmount = newDebit > 0 ? newDebit : newCredit;
              await assertPhonchReceiptNotExceeded(
                tx,
                finalSourceId,
                finalCounterAccountId,
                mainAmount,
                mainDirection,
                currentLine.journalEntryId
              );
            }

            // Same ceiling, applied to a Private Phonch's per-party
            // remaining payable instead of a Phonch's Total Amount -
            // see lib/private-phonch-accounting.ts's
            // assertPrivatePhonchPaymentNotExceeded().
            if (finalSourceType === "PRIVATE_PHONCH" && finalSourceId) {
              const mainDirection: "DEBIT" | "CREDIT" = newDebit > 0 ? "DEBIT" : "CREDIT";
              const mainAmount = newDebit > 0 ? newDebit : newCredit;
              await assertPrivatePhonchPaymentNotExceeded(
                tx,
                finalSourceId,
                finalCounterAccountId,
                mainAmount,
                mainDirection,
                currentLine.journalEntryId
              );
            }

            // PAYMENT ALLOCATION CEILING (Gap A) - a PaymentAllocation
            // row can only ever reference the Party-side line of a
            // Daily Posting pair (see lib/payment-allocation.ts's own
            // getPaymentLine() validation), which is exactly
            // counterLine here (currentLine is always the Cash/Bank
            // side - enforced above). Reducing this payment below what
            // is already manually allocated against it would silently
            // leave those PaymentAllocation rows over-committed, with
            // nothing left to reconcile them - reject instead, the
            // same way updateSettlementPaymentAmount() already rejects
            // an over-allocating edit for the separate Settlement
            // Payment mechanism. The counter account's OWN new amount
            // (not the Cash/Bank side's) is what a payment's
            // allocations are measured against - equal in magnitude to
            // the main line's new amount here, but kept separate for
            // clarity and to stay correct if that ever changes.
            if (counterLine.accountId) {
              const counterAccount = await tx.account.findUnique({
                where: { id: counterLine.accountId },
                select: { category: true },
              });
              if (counterAccount?.category === "PARTY") {
                const totalAllocated = await getAllocatedAmountForPayment(tx, counterLine.id);
                const newCounterAmount = counterDebit > 0 ? counterDebit : counterCredit;
                if (totalAllocated > newCounterAmount + 0.009) {
                  throw new DailyPostingValidationError(
                    `Cannot reduce this payment to ${newCounterAmount} - ${totalAllocated} has already been allocated from it to a Bilty/Challan. Remove or reduce the relevant allocation(s) first.`
                  );
                }
              }
            }

            const updatedJournalEntry = await tx.journalEntry.update({
              where: { id: currentLine.journalEntryId },
              data: {
                entryDate: new Date(`${date}T00:00:00`),
                description: description?.trim() || currentLine.journalEntry.description,
              },
            });

            await tx.journalLine.update({
              where: { id: currentLine.id },
              data: {
                description: description?.trim() || null,
                debit: newDebit,
                credit: newCredit,
                sourceType: finalSourceType,
                sourceId: finalSourceId,
                sourceNumber: finalSourceNumber,
              },
            });

            await tx.journalLine.update({
              where: { id: counterLine.id },
              data: {
                accountId: finalCounterAccountId,
                description: description?.trim() || null,
                debit: counterDebit,
                credit: counterCredit,
                sourceType: finalSourceType,
                sourceId: finalSourceId,
                sourceNumber: finalSourceNumber,
              },
            });

            const changedFields = diffFields(
              { amount: Number(currentLine.debit) || Number(currentLine.credit), date: currentLine.journalEntry.entryDate, description: currentLine.description },
              { amount: newDebit || newCredit, date: new Date(`${date}T00:00:00`), description: description?.trim() || null },
              ["amount", "date", "description"]
            );
            if (Object.keys(changedFields).length > 0) {
              const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
              await auditUpdate(tx, {
                actor: actorFromUser(currentUser),
                module: "CASH_BOOK",
                entityType: "JournalLine",
                entityId: currentLine.id,
                documentNo: currentLine.account.accountName,
                description: `Edited Cash Book entry on ${currentLine.account.accountName}: ${summary}`,
                changedFields,
                ...requestContext(request),
              });
            }

            return updatedJournalEntry;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );

        return NextResponse.json({
          success: true,
          message: "Transaction updated successfully",
          journalEntryId: updatedEntry.id,
        });
      } catch (error) {
        if (error instanceof DailyPostingValidationError) {
          return NextResponse.json(
            { success: false, message: error.message },
            { status: error.status }
          );
        }
        if (error instanceof BiltyPaidVerificationError) {
          return NextResponse.json(
            { success: false, code: error.code, message: error.message },
            { status: 400 }
          );
        }
        if (error instanceof PhonchAccountingError) {
          return NextResponse.json(
            { success: false, code: error.code, message: error.message },
            { status: 400 }
          );
        }
        if (error instanceof PrivatePhonchAccountingError) {
          return NextResponse.json(
            { success: false, code: error.code, message: error.message },
            { status: 400 }
          );
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          return NextResponse.json(
            {
              success: false,
              message: "Another Daily Posting change for the same Bilty/Challan happened at the same time. Please retry.",
            },
            { status: 409 }
          );
        }
        throw error;
      }
    }

    // ============================================================
    // UPDATE BOTH SIDES ATOMICALLY (non-Daily-Posting rows only -
    // unchanged free-text Document/Document No. behavior)
    // ============================================================

    const updatedEntry =
      await prisma.$transaction(
        async (tx) => {
          const updatedJournalEntry =
            await tx.journalEntry.update({
              where: {
                id:
                  currentLine.journalEntryId,
              },

              data: {
                entryDate:
                  new Date(`${date}T00:00:00`),

                description:
                  description?.trim() ||
                  currentLine.journalEntry.description,
              },
            });

          await tx.journalLine.update({
            where: {
              id: currentLine.id,
            },

            data: {
              description:
                description?.trim() ||
                null,

              debit: newDebit,

              credit: newCredit,

              sourceType:
                !isManualJournal &&
                typeof document === "string" &&
                document.trim()
                  ? document.trim()
                  : currentLine.sourceType,

              sourceNumber:
                !isManualJournal && typeof documentNo === "string"
                  ? documentNo.trim() || null
                  : currentLine.sourceNumber,
            },
          });

          await tx.journalLine.update({
            where: {
              id: counterLine.id,
            },

            data: {
              description:
                description?.trim() ||
                null,

              debit: counterDebit,

              credit: counterCredit,

              sourceType:
                !isManualJournal &&
                typeof document === "string" &&
                document.trim()
                  ? document.trim()
                  : counterLine.sourceType,

              sourceNumber:
                !isManualJournal && typeof documentNo === "string"
                  ? documentNo.trim() || null
                  : counterLine.sourceNumber,
            },
          });

          const changedFields = diffFields(
            { amount: Number(currentLine.debit) || Number(currentLine.credit), date: currentLine.journalEntry.entryDate, description: currentLine.description },
            { amount: newDebit || newCredit, date: new Date(`${date}T00:00:00`), description: description?.trim() || null },
            ["amount", "date", "description"]
          );
          if (Object.keys(changedFields).length > 0) {
            const summary = Object.entries(changedFields).map(([f, { old, new: nv }]) => `${f} ${old ?? "—"} → ${nv ?? "—"}`).join("; ");
            await auditUpdate(tx, {
              actor: actorFromUser(currentUser),
              module: "CASH_BOOK",
              entityType: "JournalLine",
              entityId: currentLine.id,
              documentNo: currentLine.account.accountName,
              description: `Edited Cash Book entry on ${currentLine.account.accountName}: ${summary}`,
              changedFields,
              ...requestContext(request),
            });
          }

          return updatedJournalEntry;
        }
      );

    // ============================================================
    // SUCCESS
    // ============================================================

    return NextResponse.json({
      success: true,
      message:
        "Transaction updated successfully",
      journalEntryId: updatedEntry.id,
    });
  } catch (error) {
    console.error(
      "Cash Book edit error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to update transaction",
      },
      { status: 500 }
    );
  }
}
export async function DELETE(
  request: NextRequest,
  context: {
    params: Promise<{ id: string }>;
  }
) {
  try {
    // ============================================================
    // AUTHENTICATION
    // ============================================================

    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json(
        {
          success: false,
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    // ============================================================
    // PERMISSION
    // ============================================================

    if (!hasPermission(currentUser, "accountingTransactions.bin")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to move transactions to Bin.",
        },
        { status: 403 }
      );
    }

    // ============================================================
    // GET JOURNAL LINE ID
    // ============================================================

    const { id } = await context.params;

    if (!id) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction ID is required",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // FIND TRANSACTION
    // ============================================================

    const currentLine =
      await prisma.journalLine.findUnique({
        where: {
          id,
        },

        include: {
          journalEntry: {
            include: {
              lines: true,
            },
          },

          account: true,
        },
      });

    if (!currentLine) {
      return NextResponse.json(
        {
          success: false,
          message: "Transaction not found",
        },
        { status: 404 }
      );
    }

    // ============================================================
    // SAFETY CHECK
    // ============================================================

    if (
      currentLine.account.category !== "CASH" &&
      currentLine.account.category !== "BANK"
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction does not belong to a Cash/Bank account.",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // OPENING BALANCE - never movable to Bin here, for anyone, with
    // no Super Admin override. Edit/remove only from the Accounts
    // page (or the Party page, for a Party's own opening balance).
    // ============================================================

    if (isOpeningBalanceReferenceType(currentLine.journalEntry.referenceType)) {
      return NextResponse.json(
        {
          success: false,
          message: BIN_REASON_OPENING_BALANCE,
        },
        { status: 400 }
      );
    }

    // ============================================================
    // ALREADY IN BIN
    // ============================================================

    if (currentLine.journalEntry.isDeleted) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This transaction is already in Bin.",
        },
        { status: 400 }
      );
    }

    // ============================================================
    // AGE / SETTLED-DOCUMENT POLICY (operational safety only)
    //
    // SUPER_ADMIN is unrestricted here - unchanged. A MANAGER may
    // only bin a RECENT transaction that is not tied to an
    // already-settled Challan/Bilty. This is enforced here
    // regardless of what the frontend shows or hides, so a direct
    // API call cannot bypass it.
    // ============================================================

    if (currentUser.role !== "SUPER_ADMIN") {
      if (isOlderThanBinThreshold(currentLine.journalEntry.entryDate)) {
        return NextResponse.json(
          { success: false, message: BIN_REASON_TOO_OLD },
          { status: 403 }
        );
      }

      const linkedToSettled = await isLinkedToSettledDocument(
        prisma,
        currentLine.journalEntry.lines
      );

      if (linkedToSettled) {
        return NextResponse.json(
          { success: false, message: BIN_REASON_SETTLED_DOCUMENT },
          { status: 403 }
        );
      }
    }

    // ============================================================
    // MULTI-LINE DAILY POSTING ROW - remove just THIS counter line's
    // Dr/Cr pair instead of Binning the whole JournalEntry.
    //
    // Since the collapse fix, a Daily Posting entry with N counter
    // lines has N separate Cash/Bank legs - Cash Book shows one row
    // per leg. Binning the WHOLE entry because one row was clicked
    // would wrongly remove every other, unrelated line too. There is
    // no per-line soft-delete (JournalLine has no isDeleted flag, only
    // JournalEntry does), so this path reuses the exact same line-
    // removal mechanism Daily Posting's own "remove line + Save"
    // already uses (updateDailyPostingEntry - same PaymentAllocation
    // safety, same main-leg rebuild) rather than inventing a second,
    // parallel implementation. This is NOT recoverable via Bin - the
    // frontend confirmation for this specific case must say so
    // honestly, unlike the whole-entry Bin below (which is
    // recoverable).
    //
    // A single-counter-line Daily Posting entry (exactly 2 lines
    // total) falls through to the normal whole-entry Bin below
    // instead - removing its only line is equivalent to binning the
    // whole (one-line) entry anyway, and matches Daily Posting's own
    // "last line -> Bin the whole transaction" rule.
    // ============================================================

    const mainAccountId = currentLine.journalEntry.referenceId;
    const counterLines =
      currentLine.journalEntry.referenceType === "DAILY_POSTING" && mainAccountId
        ? currentLine.journalEntry.lines.filter((l) => l.accountId !== mainAccountId)
        : [];

    if (currentLine.journalEntry.referenceType === "DAILY_POSTING" && counterLines.length > 1) {
      // Pair this Cash/Bank line back to the ONE counter line it was
      // created alongside - there is no stored explicit link, so this
      // matches on the same description/sourceType/sourceId/
      // sourceNumber + opposite-direction amount buildLinePair() gives
      // both lines of a pair. If that is not uniquely identifiable
      // (e.g. two counter lines happen to share an identical
      // description and amount), refuse rather than guess wrong.
      const matches = counterLines.filter((l) => {
        const sameDoc =
          l.description === currentLine.description &&
          l.sourceType === currentLine.sourceType &&
          l.sourceId === currentLine.sourceId &&
          l.sourceNumber === currentLine.sourceNumber;
        if (!sameDoc) return false;
        const mainDebit = Number(currentLine.debit);
        const mainCredit = Number(currentLine.credit);
        return (
          (mainDebit > 0 && Number(l.credit) === mainDebit) ||
          (mainCredit > 0 && Number(l.debit) === mainCredit)
        );
      });

      if (matches.length !== 1) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Unable to uniquely identify which line this row pairs with - edit this transaction from Daily Posting instead, where each line can be removed individually.",
          },
          { status: 400 }
        );
      }

      // Removing one line from a multi-line transaction is an edit,
      // not merely a Bin action - require the same permission Daily
      // Posting's own edit endpoint requires, in addition to the
      // accountingTransactions.bin permission already checked above.
      if (!hasPermission(currentUser, "accounts.edit")) {
        return NextResponse.json(
          { success: false, message: "Forbidden" },
          { status: 403 }
        );
      }

      const matched = matches[0];
      const remainingLines: DailyPostingLineInput[] = counterLines
        .filter((l) => l.id !== matched.id)
        .map((l) => ({
          id: l.id,
          counterAccountId: l.accountId,
          description: l.description || "",
          amount: Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit),
          direction: Number(l.debit) > 0 ? "CREDIT" : "DEBIT",
          sourceType: l.sourceType || "DIRECT",
          sourceId: l.sourceId || undefined,
          sourceNumber: l.sourceNumber || undefined,
        }));

      try {
        const updated = await prisma.$transaction(
          (tx) =>
            updateDailyPostingEntry({
              tx,
              id: currentLine.journalEntryId,
              date: toISODate(currentLine.journalEntry.entryDate),
              lines: remainingLines,
              currentUser,
              hasPermission: (permission) => hasPermission(currentUser, permission),
              requestCtx: requestContext(request),
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );

        return NextResponse.json({
          success: true,
          message:
            "Line removed from the transaction. This specific line is not recoverable via Bin - the transaction's other lines are unaffected.",
          journalEntryId: updated.id,
        });
      } catch (error) {
        if (error instanceof DailyPostingValidationError) {
          return NextResponse.json({ success: false, message: error.message }, { status: error.status });
        }
        if (error instanceof BiltyPaidVerificationError) {
          return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
        }
        if (error instanceof PhonchAccountingError) {
          return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
        }
        if (error instanceof PrivatePhonchAccountingError) {
          return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
        }
        if (error instanceof BillAccountingError) {
          return NextResponse.json({ success: false, code: error.code, message: error.message }, { status: 400 });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          return NextResponse.json(
            { success: false, message: "Another change to this transaction happened at the same time. Please retry." },
            { status: 409 }
          );
        }
        throw error;
      }
    }

    // ============================================================
    // SOFT DELETE
    //
    // DO NOT DELETE JOURNAL ENTRY.
    // DO NOT DELETE JOURNAL LINES.
    //
    // Only mark the JournalEntry as deleted.
    // ============================================================

    const deletedEntry =
      await prisma.journalEntry.update({
        where: {
          id: currentLine.journalEntryId,
        },

        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: currentUser.userId,
        },
      });

    await auditDelete(prisma, {
      actor: actorFromUser(currentUser),
      module: "CASH_BOOK",
      entityType: "JournalLine",
      entityId: currentLine.id,
      documentNo: currentLine.account.accountName,
      description: `Moved Cash Book entry on ${currentLine.account.accountName} to Bin (Rs. ${(Number(currentLine.debit) || Number(currentLine.credit)).toLocaleString()})`,
      oldValues: { amount: Number(currentLine.debit) || Number(currentLine.credit), date: currentLine.journalEntry.entryDate, description: currentLine.description },
      ...requestContext(request),
    });

    // ============================================================
    // SUCCESS
    // ============================================================

    return NextResponse.json({
      success: true,
      message:
        "Transaction moved to Bin successfully.",
      journalEntryId: deletedEntry.id,
    });
  } catch (error) {
    console.error(
      "Cash Book soft delete error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Unable to move transaction to Bin.",
      },
      { status: 500 }
    );
  }
}
