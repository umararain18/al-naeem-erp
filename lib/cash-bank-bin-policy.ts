import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// CASH/BANK BIN POLICY (operational safety only)
//
// SUPER_ADMIN may always bin a Cash/Bank transaction when the
// existing accountingTransactions.bin permission allows it -
// unchanged.
//
// MANAGER may only bin RECENT, operationally-unfinalized
// transactions:
//  - older than BIN_AGE_THRESHOLD_DAYS -> blocked
//  - linked (via JournalLine.sourceType/sourceId) to a Challan, or
//    to a Bilty whose active Challan, is already settled -> blocked,
//    regardless of age (a settlement makes the posting financially
//    final even if it was posted moments ago)
//
// This never creates, deletes, or reverses any JournalEntry/Line,
// and never touches P&L/Trial Balance/Party Ledger - it only gates
// whether the EXISTING soft-delete (Bin) action is allowed to run.
// ============================================================

export const BIN_AGE_THRESHOLD_DAYS = 30;

export const BIN_REASON_TOO_OLD =
  "Older financial transactions can only be moved to Bin by Super Admin.";

export const BIN_REASON_SETTLED_DOCUMENT =
  "This transaction is linked to a settled financial document and can only be moved to Bin by Super Admin.";

export function isOlderThanBinThreshold(entryDate: Date): boolean {
  const ageMs = Date.now() - entryDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > BIN_AGE_THRESHOLD_DAYS;
}

type Tx = PrismaClient | Prisma.TransactionClient;

/** Of the given Challan ids, returns the subset that are settled. */
export async function findSettledChallanIds(
  tx: Tx,
  challanIds: string[]
): Promise<Set<string>> {
  if (challanIds.length === 0) return new Set();
  const rows = await tx.challan.findMany({
    where: { id: { in: challanIds }, isSettled: true },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Of the given Bilty ids, returns the subset that belong to an
 * active (not deleted) Challan that is settled - a Bilty has no
 * isSettled flag of its own, so this mirrors the same "active
 * Challan" lookup used elsewhere in the codebase.
 */
export async function findSettledBiltyIds(
  tx: Tx,
  biltyIds: string[]
): Promise<Set<string>> {
  if (biltyIds.length === 0) return new Set();
  const rows = await tx.challanBilty.findMany({
    where: {
      biltyId: { in: biltyIds },
      challan: { isDeleted: false, isSettled: true },
    },
    select: { biltyId: true },
  });
  return new Set(rows.map((r) => r.biltyId));
}

export interface SourceRef {
  sourceType: string | null;
  sourceId: string | null;
}

/**
 * Whether ANY of the given source references (a JournalEntry's own
 * lines) point to an already-settled Challan or Bilty.
 */
export async function isLinkedToSettledDocument(
  tx: Tx,
  sources: SourceRef[]
): Promise<boolean> {
  const challanIds = new Set<string>();
  const biltyIds = new Set<string>();

  for (const s of sources) {
    if (s.sourceType === "CHALLAN" && s.sourceId) challanIds.add(s.sourceId);
    if (s.sourceType === "BILTY" && s.sourceId) biltyIds.add(s.sourceId);
  }

  const [settledChallanIds, settledBiltyIds] = await Promise.all([
    findSettledChallanIds(tx, [...challanIds]),
    findSettledBiltyIds(tx, [...biltyIds]),
  ]);

  return settledChallanIds.size > 0 || settledBiltyIds.size > 0;
}
