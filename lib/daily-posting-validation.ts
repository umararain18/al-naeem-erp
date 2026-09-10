import type { Prisma, PrismaClient } from "@prisma/client";
import { getBiltyLegitimatePartyAccountIds, resolveDocumentPartyAccount } from "@/lib/document-party-resolution";

// ============================================================
// SHARED DAILY POSTING LINE VALIDATION
//
// Extracted from app/api/daily-posting/route.ts's (Create) per-line
// validation so that Daily Posting EDIT (app/api/cash-book/[id]/
// route.ts) can enforce the exact same business rules against the
// FINAL edited state, instead of a weaker/duplicated implementation.
// Every check, message, and precedence order below is copied
// unchanged from Create - this file does not invent, relax, or
// reinterpret any rule. Create itself has been refactored to call
// these same functions (see app/api/daily-posting/route.ts), so
// there is exactly one implementation of each rule, not two.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

export type DailyPostingSourceType =
  | "CHALLAN"
  | "PHONCH"
  | "BILTY"
  | "BILL"
  | "PARTY"
  | "ACCOUNT"
  | "DIRECT";

export const DAILY_POSTING_SOURCE_TYPES: DailyPostingSourceType[] = [
  "CHALLAN",
  "PHONCH",
  "BILTY",
  "BILL",
  "PARTY",
  "ACCOUNT",
  "DIRECT",
];

export class DailyPostingValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DailyPostingValidationError";
    this.status = status;
  }
}

// ------------------------------------------------------------
// STEP 1 - shape validation (no DB). Mirrors the "VALIDATE LINES"
// loop in POST /api/daily-posting exactly.
// ------------------------------------------------------------
export function validateDailyPostingLineShape(input: {
  sourceType?: string;
  sourceId?: string;
  sourceNumber?: string;
  counterAccountId?: string;
}): void {
  if (input.sourceType && input.sourceType !== "DIRECT" && !input.sourceId) {
    throw new DailyPostingValidationError("Source ID is required for document-linked entries");
  }

  if (input.sourceType && input.sourceType !== "DIRECT" && !input.sourceNumber) {
    throw new DailyPostingValidationError("Document number is required for document-linked entries");
  }

  if (
    input.sourceType !== "CHALLAN" &&
    input.sourceType !== "BILTY" &&
    !input.counterAccountId
  ) {
    throw new DailyPostingValidationError("Counter account is required");
  }
}

// ------------------------------------------------------------
// STEP 2 - verify the Challan/Bilty actually exists (never trust
// the client's sourceId) and return its CANONICAL number. Mirrors
// the "PER-ENTRY CHALLAN / BILTY DOCUMENT LOOKUP" section.
// ------------------------------------------------------------
export async function verifyDailyPostingDocument(
  tx: Tx,
  sourceType: "CHALLAN" | "BILTY",
  sourceId: string
): Promise<{ canonicalNumber: string }> {
  if (sourceType === "CHALLAN") {
    const challan = await tx.challan.findFirst({
      where: { id: sourceId, isDeleted: false },
      select: { challanNo: true },
    });
    if (!challan) {
      throw new DailyPostingValidationError("Selected Challan was not found");
    }
    return { canonicalNumber: challan.challanNo };
  }

  const bilty = await tx.bilty.findFirst({
    where: { id: sourceId, isDeleted: false },
    select: { biltyNo: true },
  });
  if (!bilty) {
    throw new DailyPostingValidationError("Selected Bilty was not found");
  }
  return { canonicalNumber: bilty.biltyNo };
}

// ------------------------------------------------------------
// STEP 3 - auto-resolve the Counter Account from the document when
// none was manually supplied. Mirrors "AUTO-RESOLVE COUNTER ACCOUNT
// FROM THE DOCUMENT".
// ------------------------------------------------------------
export async function resolveCounterAccountForDailyPostingLine(
  sourceType: DailyPostingSourceType,
  sourceId: string | undefined,
  manualCounterAccountId: string | undefined,
  sourceNumberForMessage: string | undefined
): Promise<{ counterAccountId: string; wasManuallySupplied: boolean }> {
  if (manualCounterAccountId) {
    return { counterAccountId: manualCounterAccountId, wasManuallySupplied: true };
  }

  // validateDailyPostingLineShape already guarantees only CHALLAN/BILTY
  // lines can reach here without a counterAccountId.
  const resolved = await resolveDocumentPartyAccount(
    sourceType as "CHALLAN" | "BILTY",
    sourceId!
  );

  if (!resolved) {
    throw new DailyPostingValidationError(
      `Unable to auto-resolve a party account for ${sourceType} ${sourceNumberForMessage || sourceId}. Please select a Counter Account manually.`
    );
  }

  return { counterAccountId: resolved.accountId, wasManuallySupplied: false };
}

// ------------------------------------------------------------
// STEP 4 - hard-reject a manually-supplied Counter Account that
// mismatches this Bilty's established responsible Party. Mirrors
// "HARD REJECT: manually-supplied Counter Account mismatching...".
// A no-op for CHALLAN (Create has no equivalent mismatch guard for
// CHALLAN lines - not invented here either) and for auto-resolved
// lines (wasManuallySupplied === false).
// ------------------------------------------------------------
export async function assertCounterAccountLegitimateForBilty(
  sourceType: DailyPostingSourceType,
  sourceId: string | undefined,
  counterAccountId: string,
  wasManuallySupplied: boolean
): Promise<void> {
  if (sourceType !== "BILTY" || !wasManuallySupplied || !sourceId) return;

  const legitimateAccountIds = await getBiltyLegitimatePartyAccountIds(sourceId);

  if (!legitimateAccountIds.has(counterAccountId)) {
    throw new DailyPostingValidationError(
      legitimateAccountIds.size > 0
        ? "The selected Counter Account does not match this Bilty's established responsible Party. Select the correct Party, or leave Counter Account blank to auto-resolve."
        : "This Bilty has no established or identifiable responsible Party (no valid Consignor/Consignee/Clearing Agent account, no Collection or Paid responsibility). Please verify the Bilty's parties before posting against it."
    );
  }
}

// ------------------------------------------------------------
// STEP 5 - Counter Account must exist and be active, and must not
// be the main account itself. Mirrors "COUNTER ACCOUNTS".
// ------------------------------------------------------------
export async function assertCounterAccountValidAndActive(
  tx: Tx,
  counterAccountId: string,
  mainAccountId: string
): Promise<{ accountName: string; category: string }> {
  if (counterAccountId === mainAccountId) {
    throw new DailyPostingValidationError("Main account cannot be its own counter account");
  }

  const account = await tx.account.findUnique({
    where: { id: counterAccountId },
    select: { accountName: true, category: true, isActive: true },
  });

  if (!account) {
    throw new DailyPostingValidationError("One or more counter accounts were not found", 404);
  }

  if (!account.isActive) {
    throw new DailyPostingValidationError(`Account "${account.accountName}" is inactive`);
  }

  return account;
}

// ------------------------------------------------------------
// STEP 6 - a CHALLAN/BILTY-linked line must move money only between
// a PARTY account and a CASH/BANK account. Mirrors "PARTY <-> CASH/
// BANK RESTRICTION".
// ------------------------------------------------------------
export function assertPartyCashBankRestriction(
  sourceType: DailyPostingSourceType,
  mainCategory: string,
  counterCategory: string
): void {
  if (sourceType !== "CHALLAN" && sourceType !== "BILTY") return;

  const isCashBank = (cat: string) => cat === "CASH" || cat === "BANK";
  const valid =
    (mainCategory === "PARTY" && isCashBank(counterCategory)) ||
    (counterCategory === "PARTY" && isCashBank(mainCategory));

  if (!valid) {
    throw new DailyPostingValidationError(
      "Challan/Bilty-linked posting must move money only between a PARTY account and a CASH/BANK account."
    );
  }
}

// ------------------------------------------------------------
// ORCHESTRATOR - runs the full pipeline for ONE Daily Posting line
// in the exact order Create applies it: shape -> document existence
// + canonical number -> counter account resolution -> Bilty
// legitimacy guard -> counter account existence/active -> PARTY<->
// CASH/BANK restriction. Used by both Create (per line, inside its
// existing loop) and Edit (a single line).
// ------------------------------------------------------------
export interface ResolveDailyPostingLineParams {
  tx: Tx;
  mainAccountId: string;
  mainCategory: string;
  sourceType: DailyPostingSourceType;
  sourceId?: string;
  sourceNumber?: string;
  // Present = honor as a manually-supplied Counter Account (re-validated
  // exactly like Create validates one) - undefined = auto-resolve from
  // the document, exactly like Create does when none is supplied.
  counterAccountId?: string;
}

export interface ResolvedDailyPostingLine {
  counterAccountId: string;
  counterAccount: { accountName: string; category: string };
  sourceType: DailyPostingSourceType;
  sourceId: string | null;
  sourceNumber: string | null;
}

export async function resolveDailyPostingLine(
  params: ResolveDailyPostingLineParams
): Promise<ResolvedDailyPostingLine> {
  const { tx, mainAccountId, mainCategory, sourceType, sourceId, sourceNumber, counterAccountId } = params;

  validateDailyPostingLineShape({ sourceType, sourceId, sourceNumber, counterAccountId });

  let canonicalNumber: string | null = sourceNumber || null;
  if ((sourceType === "CHALLAN" || sourceType === "BILTY") && sourceId) {
    const doc = await verifyDailyPostingDocument(tx, sourceType, sourceId);
    canonicalNumber = doc.canonicalNumber;
  }

  const { counterAccountId: resolvedCounterId, wasManuallySupplied } =
    await resolveCounterAccountForDailyPostingLine(
      sourceType,
      sourceId,
      counterAccountId,
      canonicalNumber || undefined
    );

  if (resolvedCounterId === mainAccountId) {
    throw new DailyPostingValidationError("Main account cannot be its own counter account");
  }

  await assertCounterAccountLegitimateForBilty(sourceType, sourceId, resolvedCounterId, wasManuallySupplied);

  const counterAccount = await assertCounterAccountValidAndActive(tx, resolvedCounterId, mainAccountId);

  assertPartyCashBankRestriction(sourceType, mainCategory, counterAccount.category);

  return {
    counterAccountId: resolvedCounterId,
    counterAccount,
    sourceType,
    sourceId: (sourceType === "CHALLAN" || sourceType === "BILTY") ? sourceId || null : null,
    sourceNumber: canonicalNumber,
  };
}
