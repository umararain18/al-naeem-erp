import type { Prisma, PrismaClient } from "@prisma/client";

// ============================================================
// GROSS / SUSPENSE SYSTEM ACCOUNTS
//
// ANC's corrected recognition timing:
//  - Bilty creation recognizes the FULL Booking Income (and, if
//    present, the FULL Booking Agent Commission expense) against
//    a gross clearing account, because the responsible PARTY for
//    each is not yet known at that point.
//  - Challan creation recognizes the FULL Carrier Rent expense
//    against a gross clearing account, for the same reason.
//  - Final Settlement never touches Income/Expense again - it
//    only reclassifies each gross clearing balance into whichever
//    real PARTY account was selected as responsible, which is
//    what actually produces the post-settlement receivable/
//    payable position.
//
// These three accounts fit the existing AccountType/AccountCategory
// enum combinations already validated by the Accounts API - no
// Prisma schema change is required. They are created once, lazily,
// exactly like the existing "Opening Balance Equity" system account
// (see app/api/parties/route.ts) and reused afterwards by
// accountCode.
// ============================================================

type Tx = PrismaClient | Prisma.TransactionClient;

async function getOrCreateSystemAccount(
  tx: Tx,
  accountCode: string,
  accountName: string,
  accountType: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE" | "EQUITY",
  category: "RECEIVABLE" | "TRANSPORTER_PAYABLE" | "OTHER_LIABILITY" | "DELIVERY_INCOME" | "OTHER_INCOME" | "CARRIER_RENT" | "OTHER_EQUITY",
  description: string,
  parentId?: string
): Promise<string> {
  const existing = await tx.account.findFirst({
    where: { accountCode, isSystem: true },
    select: { id: true },
  });

  if (existing) return existing.id;

  const created = await tx.account.create({
    data: {
      accountName,
      accountCode,
      accountType,
      category,
      description,
      isSystem: true,
      isActive: true,
      ...(parentId ? { parentId } : {}),
    },
    select: { id: true },
  });

  return created.id;
}

// ============================================================
// OPENING BALANCE EQUITY - the same system account Party's own
// opening-balance posting (app/api/parties/route.ts /
// app/api/parties/[id]/route.ts) finds-or-creates by accountCode
// "OPENING-BALANCE", exposed here as a shared getter so the Account
// Opening Balance feature (app/api/accounts/route.ts /
// app/api/accounts/[id]/route.ts) resolves the exact same account
// without duplicating the find-or-create logic. Party's own files
// are untouched - they keep their existing inline lookup.
// ============================================================

export async function getOpeningBalanceEquityAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "OPENING-BALANCE",
    "Opening Balance Equity",
    "EQUITY",
    "OTHER_EQUITY",
    "System account used for opening balances"
  );
}

export async function getGrossBiltyReceivableAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "GROSS-BILTY-RECEIVABLE",
    "Gross Bilty Receivable (Unallocated)",
    "ASSET",
    "RECEIVABLE",
    "System clearing account: full Bilty rent is recognized here at booking time, before Settlement determines the actual responsible party."
  );
}

export async function getGrossCarrierRentPayableAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "GROSS-CARRIER-RENT-PAYABLE",
    "Gross Carrier Rent Payable (Unallocated)",
    "LIABILITY",
    "TRANSPORTER_PAYABLE",
    "System clearing account: full Carrier Rent expense is recognized here at Challan dispatch time, before Settlement determines the actual responsible party."
  );
}

export async function getGrossCommissionPayableAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "GROSS-COMMISSION-PAYABLE",
    "Gross Booking Agent Commission Payable (Unallocated)",
    "LIABILITY",
    "OTHER_LIABILITY",
    "System clearing account: full Booking Agent Commission expense is recognized here at Bilty booking time, before Settlement determines the actual responsible party."
  );
}

// ============================================================
// SHOWROOM PHONCH / DELIVERY income accounts
//
// Not clearing/suspense accounts (Phonch never reclassifies later,
// unlike the three above) - these are the actual, final income
// accounts the Phonch's Transporter Debit is matched against at
// creation time. "Showroom Delivery Income" is deliberately a child
// of the existing "Delivery Income" account (business decision:
// Delivery Charges and Other Expense recovery both post here);
// Claim recovery is kept on its own separate account. Resolved by
// accountCode, exactly like the gross accounts above, so this never
// collides with the parent "Delivery Income" account even though
// they share the same category.
// ============================================================

// ============================================================
// GROSS BILTY RECEIVABLE - GENUINELY UNCLAIMED BALANCE
//
// Shared by lib/document-party-resolution.ts (resolving whether Gross
// Bilty Receivable is an eligible auto-resolve/manual destination at
// all, for EITHER the Paid or the Collection/To-Pay component) and
// lib/bilty-paid-verification.ts (capping how much a Daily Posting
// receipt may claim through it) - a single source of truth so the
// two can never disagree. Every variant below reads the exact same
// underlying ledger fact - what is actually still sitting in the
// account for this specific Bilty (JournalLine.sourceType="BILTY"/
// sourceId=biltyId) - capped differently depending on which
// component is asking, so it naturally shrinks to 0 once a real
// receipt or Settlement reclassification consumes it.
// ============================================================

async function getGrossBiltyReceivableNetBalance(
  tx: Tx,
  biltyId: string,
  excludeJournalEntryId?: string
): Promise<number> {
  const grossAccountId = await getGrossBiltyReceivableAccountId(tx);

  const lines = await tx.journalLine.findMany({
    where: {
      accountId: grossAccountId,
      sourceType: "BILTY",
      sourceId: biltyId,
      journalEntry: {
        isDeleted: false,
        ...(excludeJournalEntryId ? { id: { not: excludeJournalEntryId } } : {}),
      },
    },
    select: { debit: true, credit: true },
  });
  return lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0);
}

// Never more than the Bilty's own Paid amount - a positive net here
// before Settlement ever runs also includes the To-Pay portion, which
// this specific getter must never admit (see
// getUnclaimedGrossBiltyReceivableAmountForCollection() below for that
// side). Used to decide whether Gross is a legitimate PAID-component
// destination specifically.
export async function getUnclaimedGrossBiltyReceivableAmount(
  tx: Tx,
  biltyId: string,
  // Excludes this one JournalEntry's own Bilty-tagged Gross lines from
  // the "already claimed" sum - used only when EDITING an existing
  // Daily Posting receipt against the SAME Bilty, so the row's own
  // prior amount is not double-counted against itself before the new
  // amount is checked. Never set by Create.
  excludeJournalEntryId?: string
): Promise<number> {
  const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { advance: true } });
  if (!bilty) return 0;

  const advance = Number(bilty.advance);
  if (advance <= 0) return 0;

  const net = await getGrossBiltyReceivableNetBalance(tx, biltyId, excludeJournalEntryId);
  return Math.max(0, Math.min(advance, net));
}

// The Collection/To-Pay-side counterpart of the getter above - never
// more than the Bilty's own To-Pay amount. Per the LOCKED rule traced
// to app/api/bilty/route.ts's own booking entry ("Dr Gross Bilty
// Receivable / Cr Booking Income" for the FULL total, before any
// Party is known), the To-Pay/Collection portion sits in this exact
// account until a real Settlement reclassification moves it to a
// Party - so a receipt against the Bilty's Collection component is
// just as legitimately claimable through Gross as a Paid-side one,
// whenever no such reclassification has actually happened yet. Used
// to decide whether Gross is a legitimate COLLECTION-component
// destination specifically - deliberately never a guess at the
// Transporter/Clearing Agent merely because they are named on the
// Challan.
export async function getUnclaimedGrossBiltyReceivableAmountForCollection(
  tx: Tx,
  biltyId: string,
  excludeJournalEntryId?: string
): Promise<number> {
  const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { toPay: true } });
  if (!bilty) return 0;

  const toPay = Number(bilty.toPay);
  if (toPay <= 0) return 0;

  const net = await getGrossBiltyReceivableNetBalance(tx, biltyId, excludeJournalEntryId);
  return Math.max(0, Math.min(toPay, net));
}

// The COMBINED ceiling used by the write-time safety check
// (assertPaidVerificationNotExceeded in lib/bilty-paid-verification.ts):
// a Daily Posting receipt credited to Gross Bilty Receivable may
// represent EITHER the Paid or the Collection component (the write
// path has no separate tag distinguishing which), so the only
// ledger-correct limit is the Bilty's own full total, never more than
// what is actually still sitting in the account. This is NOT more
// permissive than the two capped getters above individually - it is
// the same underlying net balance, just not pre-split by component,
// since a single receipt amount cannot be definitively attributed to
// one split or the other at write time.
export async function getUnclaimedGrossBiltyReceivableTotalAmount(
  tx: Tx,
  biltyId: string,
  excludeJournalEntryId?: string
): Promise<number> {
  const bilty = await tx.bilty.findUnique({ where: { id: biltyId }, select: { total: true } });
  if (!bilty) return 0;

  const total = Number(bilty.total);
  const net = await getGrossBiltyReceivableNetBalance(tx, biltyId, excludeJournalEntryId);
  return Math.max(0, Math.min(total, net));
}

export async function getShowroomDeliveryIncomeAccountId(tx: Tx): Promise<string> {
  const parent = await tx.account.findFirst({
    where: { category: "DELIVERY_INCOME", parentId: null },
    select: { id: true },
  });

  return getOrCreateSystemAccount(
    tx,
    "SHOWROOM-DELIVERY-INCOME",
    "Showroom Delivery Income",
    "INCOME",
    "DELIVERY_INCOME",
    "Showroom Phonch Delivery Charges and Other Expense recovery income - sub-account of Delivery Income.",
    parent?.id
  );
}

export async function getClaimRecoveryAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "CLAIM-RECOVERY",
    "Claim Recovery",
    "INCOME",
    "OTHER_INCOME",
    "Showroom Phonch vehicle damage/claim recovery income, charged to the responsible Transporter."
  );
}

// ============================================================
// PRIVATE PHONCH - dedicated Carrier Rent expense / Delivery income
// accounts (never shared with the unrelated Challan-dispatch Carrier
// Rent expense account or Showroom Phonch's own Delivery Income
// account - see model PrivatePhonch's own doc comment in
// prisma/schema.prisma for why these are kept separate).
// ============================================================

export async function getPrivatePhonchCarrierRentExpenseAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "PRIVATE-PHONCH-CARRIER-RENT",
    "Private Phonch Carrier Rent Expense",
    "EXPENSE",
    "CARRIER_RENT",
    "Full Total Rent recognized as an expense at Private Phonch creation, before the Carrier Payable / CA Payable / Delivery Charges split is credited out to the Transporter, Clearing Agent(s), and Private Phonch Delivery Income."
  );
}

// ============================================================
// BILL BOOK - dedicated client billing income account.
//
// NOT the same income as Private Phonch's own "Private Phonch
// Delivery Income" or Showroom Phonch's own "Showroom Delivery
// Income" - those recognize ANC's CARRIER-side income (billed to the
// Transporter). Bill Income recognizes the separate CLIENT-side
// income (billed to the actual paying client) - a genuinely different
// counterparty and, in the normal case, a genuinely different dollar
// amount (the client price, not the carrier cost) - see model Bill's
// own doc comment in prisma/schema.prisma. Classified under the
// existing DELIVERY_INCOME category, grouping it in reports alongside
// Private Phonch/Showroom Phonch's own Delivery Income accounts - no
// new AccountCategory enum value required.
// ============================================================

export async function getBillIncomeAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    "BILL-INCOME",
    "Bill Income",
    "INCOME",
    "DELIVERY_INCOME",
    "Client billing income recognized when a Bill is created - the amount ANC charges the client for Rent/Delivery/Other Expense, independent of Private/Showroom Phonch's own carrier-side accounting with the Transporter."
  );
}

// ============================================================
// BILL BOOK - shared WALK-IN / ONE-TIME CLIENT receivable account.
//
// Used ONLY when a Bill's client is a random/one-time customer with
// no selected existing Party (clientPartyId left null) - a Bill must
// NEVER transparently create a new Party or a new per-client Account
// just because a typed name doesn't match an existing Party (see model
// Bill's own doc comment in prisma/schema.prisma). This ONE shared,
// system-level account absorbs every such Bill's own receivable
// posting instead - the same "found once, reused forever" idiom as
// every other system account in this file. Each walk-in Bill's own
// payment state still resolves correctly and independently, because
// getBillPaymentState() filters by sourceId (the specific Bill's own
// id), never by accountId alone - sharing this account across many
// walk-in Bills never conflates their receipts.
//
// getBillWalkInReceivableAccountId() is write-capable (creates the
// account on first use) and is only ever called from a Bill
// create/edit transaction. findBillWalkInReceivableAccountId() is a
// pure read - used by every read-only path (list/detail/PDF/Daily
// Posting search/reverse Bill links) - and returns null rather than
// creating anything if no walk-in Bill has ever been created yet.
// ============================================================

const BILL_WALKIN_ACCOUNT_CODE = "BILL-WALKIN-RECEIVABLE";

export async function getBillWalkInReceivableAccountId(tx: Tx): Promise<string> {
  return getOrCreateSystemAccount(
    tx,
    BILL_WALKIN_ACCOUNT_CODE,
    "Bill Book - Walk-in Customers (Unallocated)",
    "ASSET",
    "RECEIVABLE",
    "Shared receivable account for one-time/random Bill Book clients who have no selected Party - never a new Party or Account is created per client."
  );
}

export async function findBillWalkInReceivableAccountId(tx: Tx): Promise<string | null> {
  const existing = await tx.account.findFirst({
    where: { accountCode: BILL_WALKIN_ACCOUNT_CODE, isSystem: true },
    select: { id: true },
  });
  return existing?.id ?? null;
}

export async function getPrivatePhonchDeliveryIncomeAccountId(tx: Tx): Promise<string> {
  const parent = await tx.account.findFirst({
    where: { category: "DELIVERY_INCOME", parentId: null },
    select: { id: true },
  });

  return getOrCreateSystemAccount(
    tx,
    "PRIVATE-PHONCH-DELIVERY-INCOME",
    "Private Phonch Delivery Income",
    "INCOME",
    "DELIVERY_INCOME",
    "ANC's own cut of Private Phonch's Total Rent (Total Rent minus Net Rent) - sub-account of Delivery Income, kept separate from Showroom Phonch's own Delivery Income.",
    parent?.id
  );
}
