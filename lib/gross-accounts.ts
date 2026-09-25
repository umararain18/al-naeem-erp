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
  accountType: "ASSET" | "LIABILITY" | "INCOME" | "EXPENSE",
  category: "RECEIVABLE" | "TRANSPORTER_PAYABLE" | "OTHER_LIABILITY" | "DELIVERY_INCOME" | "OTHER_INCOME" | "CARRIER_RENT",
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
// GROSS BILTY RECEIVABLE - GENUINELY UNCLAIMED PAID-SIDE BALANCE
//
// Shared by lib/document-party-resolution.ts (resolving whether Gross
// Bilty Receivable is an eligible auto-resolve/manual destination at
// all) and lib/bilty-paid-verification.ts (capping how much a Daily
// Posting receipt may claim through it) - a single source of truth so
// the two can never disagree. Never more than Bilty.advance (the
// Paid amount) - the To-Pay portion is Settlement's business alone,
// per the LOCKED rule - and never more than what is actually still
// sitting in the account for this specific Bilty
// (JournalLine.sourceType="BILTY"/sourceId=biltyId), so it naturally
// shrinks to 0 once a real receipt or reclassification consumes it.
// ============================================================

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
  const net = lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0);

  // Never more than the Bilty's own Paid amount - a positive net here
  // before Settlement ever runs also includes the To-Pay portion,
  // which must never be claimed through this path.
  return Math.max(0, Math.min(advance, net));
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
