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
  accountType: "ASSET" | "LIABILITY",
  category: "RECEIVABLE" | "TRANSPORTER_PAYABLE" | "OTHER_LIABILITY",
  description: string
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
