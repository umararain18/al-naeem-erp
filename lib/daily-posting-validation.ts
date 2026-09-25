import type { Prisma, PrismaClient } from "@prisma/client";
import {
  getBiltyLegitimatePartyAccountIds,
  getChallanEligiblePartyAccountIds,
  getPrivatePhonchEligiblePartyAccountIds,
  resolveDocumentPartyAccount,
} from "@/lib/document-party-resolution";
import { getGrossBiltyReceivableAccountId } from "@/lib/gross-accounts";

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
  | "PRIVATE_PHONCH"
  | "BILTY"
  | "BILL"
  | "PARTY"
  | "ACCOUNT"
  | "DIRECT";

export const DAILY_POSTING_SOURCE_TYPES: DailyPostingSourceType[] = [
  "CHALLAN",
  "PHONCH",
  "PRIVATE_PHONCH",
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
    input.sourceType !== "PHONCH" &&
    input.sourceType !== "PRIVATE_PHONCH" &&
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
  sourceType: "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH",
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

  if (sourceType === "PHONCH") {
    const phonch = await tx.phonch.findFirst({
      where: { id: sourceId, isDeleted: false },
      select: { phonchNo: true },
    });
    if (!phonch) {
      throw new DailyPostingValidationError("Selected Phonch was not found");
    }
    return { canonicalNumber: phonch.phonchNo };
  }

  if (sourceType === "PRIVATE_PHONCH") {
    const privatePhonch = await tx.privatePhonch.findFirst({
      where: { id: sourceId, isDeleted: false },
      select: { phonchNo: true },
    });
    if (!privatePhonch) {
      throw new DailyPostingValidationError("Selected Private Phonch was not found");
    }
    return { canonicalNumber: privatePhonch.phonchNo };
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
  sourceNumberForMessage: string | undefined,
  // Only consulted for CHALLAN - see resolveChallanParty() in
  // lib/document-party-resolution.ts.
  direction?: "DEBIT" | "CREDIT"
): Promise<{ counterAccountId: string; wasManuallySupplied: boolean }> {
  if (manualCounterAccountId) {
    return { counterAccountId: manualCounterAccountId, wasManuallySupplied: true };
  }

  // validateDailyPostingLineShape already guarantees only CHALLAN/BILTY/
  // PHONCH/PRIVATE_PHONCH lines can reach here without a counterAccountId.
  const resolved = await resolveDocumentPartyAccount(
    sourceType as "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH",
    sourceId!,
    direction
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
// A no-op for CHALLAN (see assertCounterAccountLegitimateForChallan()
// below, its own separate guard) and for auto-resolved lines
// (wasManuallySupplied === false).
// ------------------------------------------------------------
export async function assertCounterAccountLegitimateForBilty(
  sourceType: DailyPostingSourceType,
  sourceId: string | undefined,
  counterAccountId: string,
  wasManuallySupplied: boolean,
  // Only consulted for the Gross Bilty Receivable exception - see
  // getBiltyLegitimatePartyAccountIds().
  direction?: "DEBIT" | "CREDIT"
): Promise<void> {
  if (sourceType !== "BILTY" || !wasManuallySupplied || !sourceId) return;

  const legitimateAccountIds = await getBiltyLegitimatePartyAccountIds(sourceId, direction);

  if (!legitimateAccountIds.has(counterAccountId)) {
    throw new DailyPostingValidationError(
      legitimateAccountIds.size > 0
        ? "The selected Counter Account does not match this Bilty's established responsible Party. Select the correct Party, or leave Counter Account blank to auto-resolve."
        : "This Bilty has no established or identifiable responsible Party (no valid Consignor/Consignee/Clearing Agent account, no Collection or Paid responsibility). Please verify the Bilty's parties before posting against it."
    );
  }
}

// ------------------------------------------------------------
// STEP 4b - hard-reject a manually-supplied Counter Account that
// mismatches this Challan's eligible Receivable/Payable parties for
// the given direction, per the LOCKED rule in lib/document-party-
// resolution.ts's resolveChallanParty(). A random Transporter/
// Clearing Agent account must never be accepted merely because it
// exists on the Challan - it must be an actual outstanding
// Receivable (RECEIPT/DEBIT) or Payable (PAYMENT/CREDIT) party. A
// no-op for non-CHALLAN sources, auto-resolved lines
// (wasManuallySupplied === false), and a Challan with no eligible
// party for this direction yet (empty set - preserves the existing,
// pre-this-feature manual-entry behavior for that case).
// ------------------------------------------------------------
export async function assertCounterAccountLegitimateForChallan(
  sourceType: DailyPostingSourceType,
  sourceId: string | undefined,
  counterAccountId: string,
  wasManuallySupplied: boolean,
  direction: "DEBIT" | "CREDIT" | undefined
): Promise<void> {
  if (sourceType !== "CHALLAN" || !wasManuallySupplied || !sourceId || !direction) return;

  const eligibleAccountIds = await getChallanEligiblePartyAccountIds(sourceId, direction);

  if (eligibleAccountIds.size > 0 && !eligibleAccountIds.has(counterAccountId)) {
    throw new DailyPostingValidationError(
      `The selected Counter Account is not an outstanding ${
        direction === "DEBIT" ? "Receivable" : "Payable"
      } party for this Challan. Select one of the eligible parties, or leave Counter Account blank to auto-resolve.`
    );
  }
}

// ------------------------------------------------------------
// STEP 4c - hard-reject a manually-supplied Counter Account that
// mismatches this Private Phonch's eligible payable/deposit parties
// for the given direction, per the LOCKED rule in lib/document-party-
// resolution.ts's resolvePrivatePhonchParty(). A no-op for non-
// PRIVATE_PHONCH sources, auto-resolved lines (wasManuallySupplied
// === false), and a Private Phonch with no eligible party for this
// direction yet (empty set - preserves the pre-this-feature manual-
// entry behavior for that case). Mirrors
// assertCounterAccountLegitimateForChallan() exactly.
// ------------------------------------------------------------
export async function assertCounterAccountLegitimateForPrivatePhonch(
  sourceType: DailyPostingSourceType,
  sourceId: string | undefined,
  counterAccountId: string,
  wasManuallySupplied: boolean,
  direction: "DEBIT" | "CREDIT" | undefined
): Promise<void> {
  if (sourceType !== "PRIVATE_PHONCH" || !wasManuallySupplied || !sourceId || !direction) return;

  const eligibleAccountIds = await getPrivatePhonchEligiblePartyAccountIds(sourceId, direction);

  if (eligibleAccountIds.size > 0 && !eligibleAccountIds.has(counterAccountId)) {
    throw new DailyPostingValidationError(
      `The selected Counter Account is not an outstanding ${
        direction === "DEBIT" ? "deposit-eligible Clearing Agent" : "payable"
      } party for this Private Phonch. Select one of the eligible parties, or leave Counter Account blank to auto-resolve.`
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
export async function assertPartyCashBankRestriction(
  tx: Tx,
  sourceType: DailyPostingSourceType,
  mainCategory: string,
  counterCategory: string,
  // Only consulted for the narrow Gross Bilty Receivable exception
  // below - the exact account id and the line's direction.
  counterAccountId?: string,
  direction?: "DEBIT" | "CREDIT"
): Promise<void> {
  if (sourceType !== "CHALLAN" && sourceType !== "BILTY" && sourceType !== "PHONCH" && sourceType !== "PRIVATE_PHONCH") return;

  const isCashBank = (cat: string) => cat === "CASH" || cat === "BANK";
  const valid =
    (mainCategory === "PARTY" && isCashBank(counterCategory)) ||
    (counterCategory === "PARTY" && isCashBank(mainCategory));

  if (valid) return;

  // Narrow exception: BILTY + RECEIPT + the exact existing Gross
  // Bilty Receivable system account (Main must be CASH/BANK) is the
  // ONLY non-PARTY destination this restriction ever admits - see
  // resolveUnclaimedGrossBiltyReceivable() in
  // lib/document-party-resolution.ts. Eligibility for this SPECIFIC
  // Bilty was already proven by the legitimacy guard above (Step 4) -
  // this only re-checks that the resolved account IS that exact
  // system account, never any other RECEIVABLE/ASSET account.
  if (sourceType === "BILTY" && direction === "DEBIT" && isCashBank(mainCategory) && counterAccountId) {
    const grossBiltyReceivableId = await getGrossBiltyReceivableAccountId(tx);
    if (counterAccountId === grossBiltyReceivableId) return;
  }

  throw new DailyPostingValidationError(
    "Challan/Bilty-linked posting must move money only between a PARTY account and a CASH/BANK account."
  );
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
  // The line's DEBIT/CREDIT direction against the Main account - only
  // consulted for a CHALLAN source (see resolveChallanParty() in
  // lib/document-party-resolution.ts).
  direction?: "DEBIT" | "CREDIT";
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
  const { tx, mainAccountId, mainCategory, sourceType, sourceId, sourceNumber, counterAccountId, direction } = params;

  validateDailyPostingLineShape({ sourceType, sourceId, sourceNumber, counterAccountId });

  let canonicalNumber: string | null = sourceNumber || null;
  if ((sourceType === "CHALLAN" || sourceType === "BILTY" || sourceType === "PHONCH" || sourceType === "PRIVATE_PHONCH") && sourceId) {
    const doc = await verifyDailyPostingDocument(tx, sourceType, sourceId);
    canonicalNumber = doc.canonicalNumber;
  }

  const { counterAccountId: resolvedCounterId, wasManuallySupplied } =
    await resolveCounterAccountForDailyPostingLine(
      sourceType,
      sourceId,
      counterAccountId,
      canonicalNumber || undefined,
      direction
    );

  if (resolvedCounterId === mainAccountId) {
    throw new DailyPostingValidationError("Main account cannot be its own counter account");
  }

  await assertCounterAccountLegitimateForBilty(sourceType, sourceId, resolvedCounterId, wasManuallySupplied, direction);
  await assertCounterAccountLegitimateForChallan(sourceType, sourceId, resolvedCounterId, wasManuallySupplied, direction);
  await assertCounterAccountLegitimateForPrivatePhonch(sourceType, sourceId, resolvedCounterId, wasManuallySupplied, direction);

  const counterAccount = await assertCounterAccountValidAndActive(tx, resolvedCounterId, mainAccountId);

  await assertPartyCashBankRestriction(tx, sourceType, mainCategory, counterAccount.category, resolvedCounterId, direction);

  return {
    counterAccountId: resolvedCounterId,
    counterAccount,
    sourceType,
    sourceId:
      (sourceType === "CHALLAN" || sourceType === "BILTY" || sourceType === "PHONCH" || sourceType === "PRIVATE_PHONCH")
        ? sourceId || null
        : null,
    sourceNumber: canonicalNumber,
  };
}
