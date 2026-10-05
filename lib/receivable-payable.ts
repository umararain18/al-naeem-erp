import { prisma } from "@/lib/prisma";

// ============================================================
// Shared Receivable/Payable calculation - single source of truth
// for GET /api/dashboard, GET /api/reports/receivable, and GET
// /api/reports/payable.
//
// Semantics (pre-existing, confirmed by direct comparison of the two
// report routes before this file existed): Receivable/Payable is a
// CLOSING OUTSTANDING BALANCE, computed by summing every JournalLine
// ever posted against each active Party's own Account - never a
// "transactions during a period" total. `asOfExclusive` generalizes
// this to an arbitrary point in time (the Dashboard's selected period
// end) by adding an optional `entryDate < asOfExclusive` filter;
// calling it with no argument reproduces the exact original
// all-JournalLines-ever behavior of both report routes unchanged.
//
// BUSINESS-WIDE RECEIVABLE (forensic audit, see the session's own
// "Business-Wide Receivable & Payable Gap Audit") - one explicit,
// hardcoded system account is ALSO included below:
//
//   BILL-WALKIN-RECEIVABLE ("Bill Book - Walk-in Customers
//   (Unallocated)") - a PERMANENT receivable for real, named walk-in
//   Bill clients who simply have no Party record (see model Bill's
//   own doc comment in prisma/schema.prisma). It has no owning Party,
//   so the Party-iteration loop above can never reach it on its own -
//   this is a genuine reporting gap, not a design choice, confirmed
//   by the forensic audit.
//
// Two structurally similar system accounts are DELIBERATELY NOT
// included, and must never be added without a fresh, explicit audit:
//
//   GROSS-BILTY-RECEIVABLE and GROSS-CARRIER-RENT-PAYABLE /
//   GROSS-COMMISSION-PAYABLE are TEMPORARY pre-Settlement clearing
//   balances (Bilty/Challan's full rent/commission is booked there at
//   creation, then reclassified to the real responsible Party at
//   Final Settlement) - including them would double-count against
//   whatever they get reclassified into, and the audit found an
//   unresolved residual on the Carrier Rent/Commission accounts that
//   requires a separate settlement-correction investigation before
//   any of it could safely be added.
//
// Never add an account here merely because its category is
// RECEIVABLE/PAYABLE - each inclusion is a single, explicit,
// accountCode-keyed lookup, validated against the exact metadata this
// audit confirmed, so a future renamed/repurposed account can never be
// silently swept in.
// ============================================================

const BILL_WALKIN_RECEIVABLE_ACCOUNT_CODE = "BILL-WALKIN-RECEIVABLE";

export interface PartyBalanceRow {
  partyId: string | null;
  partyName: string;
  accountId: string;
  accountName: string;
  accountCode: string | null;
  totalDebit: number;
  totalCredit: number;
  balance: number; // always positive within its own list (receivable or payable)
  // Most recent JournalLine entryDate contributing to this balance (as
  // of the same `asOfExclusive` bound), or null if the account has no
  // activity at all. Computed for free from the same query this
  // function already runs - added for Dashboard Phase 2's Ageing
  // buckets (see bucketAgeing() below); Phase 1 callers that don't
  // read this field are entirely unaffected.
  lastActivityDate: Date | null;
  // true only for the explicit BILL-WALKIN-RECEIVABLE row below - lets
  // a consumer (e.g. the Receivable report page) render it without a
  // Party Ledger link, since partyId is null. Always false for every
  // real Party row.
  isSystemAccount: boolean;
  // The owning Party's own isActive flag - true for the walk-in system
  // row (not subject to deactivation the same way a Party is). An
  // inactive Party only ever appears in this list at all when its
  // balance is genuinely non-zero - see getReceivablePayable() below -
  // so a consumer can label it (e.g. "(Inactive)") rather than needing
  // a second lookup.
  isActive: boolean;
  // The owning Party's own phone number, for the Receivable/Payable
  // search box (Dashboard-adjacent feature) - null for the walk-in
  // system row (no Party) and for a real Party with no phone on file,
  // never invented.
  phone: string | null;
}

export interface ReceivablePayableResult {
  receivable: PartyBalanceRow[];
  payable: PartyBalanceRow[];
  totalReceivable: number;
  totalPayable: number;
}

export async function getReceivablePayable(
  asOfExclusive?: Date | null
): Promise<ReceivablePayableResult> {
  // Every party with an account, active or not - an inactive party can
  // still hold a real, non-zero outstanding balance (deactivated
  // without being settled/reversed first). Excluding it here would
  // silently drop it from both reports and from the Dashboard's
  // totals/Ageing buckets below, exactly like Trial Balance's own
  // isActive-account bug. The balance>0/balance<0 checks further down
  // already skip any party - active or inactive - with nothing owed
  // either way, so a zero-balance inactive party still never appears.
  const parties = await prisma.party.findMany({
    where: {
      account: { isNot: null },
    },
    select: {
      id: true,
      partyName: true,
      phone: true,
      isActive: true,
      account: {
        select: { id: true, accountName: true, accountCode: true },
      },
    },
    orderBy: { partyName: "asc" },
  });

  const accountIds = parties
    .map((p) => p.account?.id)
    .filter((id): id is string => Boolean(id));

  const totalsByAccount = new Map<string, { debit: number; credit: number }>();
  const lastActivityByAccount = new Map<string, Date>();

  if (accountIds.length > 0) {
    const lines = await prisma.journalLine.findMany({
      where: {
        accountId: { in: accountIds },
        journalEntry: {
          is: {
            isDeleted: false,
            ...(asOfExclusive ? { entryDate: { lt: asOfExclusive } } : {}),
          },
        },
      },
      select: { accountId: true, debit: true, credit: true, journalEntry: { select: { entryDate: true } } },
    });

    for (const line of lines) {
      const current = totalsByAccount.get(line.accountId) || { debit: 0, credit: 0 };
      current.debit += Number(line.debit);
      current.credit += Number(line.credit);
      totalsByAccount.set(line.accountId, current);

      const entryDate = line.journalEntry.entryDate;
      const existingLatest = lastActivityByAccount.get(line.accountId);
      if (!existingLatest || entryDate > existingLatest) {
        lastActivityByAccount.set(line.accountId, entryDate);
      }
    }
  }

  const receivable: PartyBalanceRow[] = [];
  const payable: PartyBalanceRow[] = [];

  for (const party of parties) {
    if (!party.account) continue;
    const totals = totalsByAccount.get(party.account.id) || { debit: 0, credit: 0 };
    const balance = totals.debit - totals.credit;

    const lastActivityDate = lastActivityByAccount.get(party.account.id) || null;

    if (balance > 0) {
      receivable.push({
        partyId: party.id,
        partyName: party.partyName,
        accountId: party.account.id,
        accountName: party.account.accountName,
        accountCode: party.account.accountCode,
        totalDebit: totals.debit,
        totalCredit: totals.credit,
        balance,
        lastActivityDate,
        isSystemAccount: false,
        isActive: party.isActive,
        phone: party.phone,
      });
    } else if (balance < 0) {
      payable.push({
        partyId: party.id,
        partyName: party.partyName,
        accountId: party.account.id,
        accountName: party.account.accountName,
        accountCode: party.account.accountCode,
        totalDebit: totals.debit,
        totalCredit: totals.credit,
        balance: Math.abs(balance),
        lastActivityDate,
        isSystemAccount: false,
        isActive: party.isActive,
        phone: party.phone,
      });
    }
  }

  // ---- BILL-WALKIN-RECEIVABLE - see this file's own header comment.
  // Exact accountCode lookup only, validated against every piece of
  // metadata the forensic audit confirmed. Never falls back to a
  // name/category match, never creates the account (a read/report
  // helper must never mutate), and never crashes the caller: a missing
  // account (no walk-in Bill has ever been created yet - the same
  // legitimate "nothing yet" state findBillWalkInReceivableAccountId()
  // itself returns null for) is silently omitted, while an account
  // that EXISTS but fails validation is logged as a diagnostic and
  // also omitted - bad/inconsistent data is never surfaced as if it
  // were a normal receivable.
  const walkinAccount = await prisma.account.findUnique({
    where: { accountCode: BILL_WALKIN_RECEIVABLE_ACCOUNT_CODE },
    select: { id: true, accountName: true, accountCode: true, category: true, partyId: true, isActive: true, isSystem: true },
  });

  if (walkinAccount) {
    const isValid =
      walkinAccount.isActive &&
      walkinAccount.isSystem &&
      walkinAccount.category === "RECEIVABLE" &&
      walkinAccount.partyId === null;

    if (!isValid) {
      console.error(
        `getReceivablePayable: account ${BILL_WALKIN_RECEIVABLE_ACCOUNT_CODE} exists but failed validation ` +
          `(isActive=${walkinAccount.isActive}, isSystem=${walkinAccount.isSystem}, category=${walkinAccount.category}, partyId=${walkinAccount.partyId}) - ` +
          `omitting it from Business-wide Receivable rather than trusting inconsistent metadata.`
      );
    } else {
      const walkinLines = await prisma.journalLine.findMany({
        where: {
          accountId: walkinAccount.id,
          journalEntry: {
            is: {
              isDeleted: false,
              ...(asOfExclusive ? { entryDate: { lt: asOfExclusive } } : {}),
            },
          },
        },
        select: { debit: true, credit: true, journalEntry: { select: { entryDate: true } } },
      });

      const walkinDebit = walkinLines.reduce((sum, l) => sum + Number(l.debit), 0);
      const walkinCredit = walkinLines.reduce((sum, l) => sum + Number(l.credit), 0);
      const walkinBalance = walkinDebit - walkinCredit;
      const walkinLastActivity = walkinLines.reduce<Date | null>((latest, l) => {
        const d = l.journalEntry.entryDate;
        return !latest || d > latest ? d : latest;
      }, null);

      // Economically this account is a Receivable ONLY - never invent
      // a Payable interpretation for it even if its balance were ever
      // negative (e.g. an over-receipt data inconsistency); simply
      // omit it in that case rather than misclassify it.
      if (walkinBalance > 0) {
        receivable.push({
          partyId: null,
          partyName: walkinAccount.accountName,
          accountId: walkinAccount.id,
          accountName: walkinAccount.accountName,
          accountCode: walkinAccount.accountCode,
          totalDebit: walkinDebit,
          totalCredit: walkinCredit,
          balance: walkinBalance,
          lastActivityDate: walkinLastActivity,
          isSystemAccount: true,
          isActive: true,
          phone: null,
        });
      }
    }
  }

  receivable.sort((a, b) => b.balance - a.balance);
  payable.sort((a, b) => b.balance - a.balance);

  return {
    receivable,
    payable,
    totalReceivable: receivable.reduce((sum, r) => sum + r.balance, 0),
    totalPayable: payable.reduce((sum, p) => sum + p.balance, 0),
  };
}

// ============================================================
// AGEING (Dashboard Phase 2) - an intentionally LIMITED approximation,
// not true invoice-level ageing.
//
// The ERP's Receivable/Payable is a NET CLOSING BALANCE per Party
// account (see this file's own header comment) with no per-invoice
// allocation for the general Party ledger (PaymentAllocation only
// covers Bilty/Challan Collection, not the general ledger this
// balance is drawn from). There is therefore no reliable way to know
// WHICH specific past transaction(s) still make up today's
// outstanding balance, so a true "this Rs. 40,000 is from an invoice
// 45 days old" ageing cannot be safely derived - fabricating one would
// violate this project's explicit "no invented accounting data" rule.
//
// What CAN be derived reliably, from data this module already reads:
// how many days it has been since each party's account last had ANY
// JournalLine activity (`lastActivityDate` above) as of the selected
// period end. A balance attached to an account with no recent activity
// is a genuinely useful staleness signal for management even though it
// is not strict per-invoice ageing - this is clearly labeled as such
// everywhere it is displayed.
// ============================================================

export const AGEING_BUCKET_LABELS = ["Current", "1-30 Days", "31-60 Days", "61-90 Days", "90+ Days"] as const;
export type AgeingBucketLabel = (typeof AGEING_BUCKET_LABELS)[number];

/** Current = activity on the as-of date itself (0 days stale). */
export function ageingBucketForDays(daysSinceActivity: number): AgeingBucketLabel {
  if (daysSinceActivity <= 0) return "Current";
  if (daysSinceActivity <= 30) return "1-30 Days";
  if (daysSinceActivity <= 60) return "31-60 Days";
  if (daysSinceActivity <= 90) return "61-90 Days";
  return "90+ Days";
}

export interface AgeingBucketSummary {
  bucket: AgeingBucketLabel;
  amount: number;
  partyCount: number;
}

/**
 * Buckets an already-computed receivable/payable row list by days
 * since last activity, as of `asOf`. A row with no `lastActivityDate`
 * at all (should not normally happen for a nonzero balance, since a
 * balance requires at least one JournalLine) falls into "90+ Days" -
 * the conservative/safe direction, never "Current".
 */
export function bucketAgeing(rows: PartyBalanceRow[], asOf: Date): AgeingBucketSummary[] {
  const totals = new Map<AgeingBucketLabel, { amount: number; partyCount: number }>();
  for (const label of AGEING_BUCKET_LABELS) totals.set(label, { amount: 0, partyCount: 0 });

  for (const row of rows) {
    const days = row.lastActivityDate
      ? Math.floor((asOf.getTime() - row.lastActivityDate.getTime()) / 86400000)
      : Infinity;
    const bucket = ageingBucketForDays(days);
    const current = totals.get(bucket)!;
    current.amount += row.balance;
    current.partyCount += 1;
  }

  return AGEING_BUCKET_LABELS.map((label) => ({ bucket: label, ...totals.get(label)! }));
}
