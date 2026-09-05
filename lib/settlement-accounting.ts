import { Decimal } from "@prisma/client/runtime/library";

// ============================================================
// FLEXIBLE FINAL SETTLEMENT - RECLASSIFICATION ONLY
//
// Recognition timing: Booking Income (and Booking Agent Commission
// expense) is recognized once, in full, when the Bilty is created;
// Carrier Rent expense is recognized once, in full, when the
// Challan is dispatched (see app/api/bilty/route.ts and
// app/api/challan/route.ts). At that point the responsible PARTY
// for each amount is not yet known, so the offsetting side of each
// of those entries is a gross/suspense clearing account (see
// lib/gross-accounts.ts), not a party.
//
// Settlement's only job is to reclassify each gross clearing
// balance into whichever real party the settlement screen says is
// actually responsible - it must NEVER touch Booking Income,
// Carrier Rent expense, or Commission expense again, or those
// amounts would be double-counted in P&L.
//
// The business reality: for a given Challan, each of the three
// financial components - Bilty Rent/Collection, Carrier Rent,
// and Booking Agent Commission - can independently end up "with"
// a different real-world party (the Clearing Agent, the
// Transporter/Driver, or some other third party). There is no
// fixed CASE A/B pairing.
//
// This module reclassifies each component directly into whichever
// party account the settlement screen says is responsible, and
// derives the net outstanding position per party from the
// resulting lines - rather than hard-coding two scenarios and
// reclassifying afterwards. The old CASE A/B behavior is a special
// case that falls out naturally: selecting the Clearing Agent for
// both Collection and Carrier Rent reproduces CASE A's net effect
// on the Clearing Agent's account; selecting the Transporter for
// Collection and "ANC" (direct payable to the Transporter) for
// Carrier Rent reproduces CASE B's net effect on the Transporter's
// account. See buildSettlementEntries() below.
//
// Invariants preserved:
//  - No Cash/Bank lines are ever created here (Daily Posting owns
//    actual money movement).
//  - No Income/Expense account is ever touched here (Bilty/Challan
//    creation already recognized those, exactly once).
//  - Every debit has a matching credit (balanced entry).
//  - Commission is reclassified as exactly one pair per Bilty.
//  - Verified advances (Daily-Posting-backed only, never
//    Bilty.advance) reduce the outstanding balance per party.
// ============================================================

export type CollectionResponsibility =
  | "CLEARING_AGENT"
  | "TRANSPORTER"
  | "THIRD_PARTY";

export type CarrierRentResponsibility =
  | "CLEARING_AGENT"
  | "ANC"
  | "THIRD_PARTY";

export type CommissionResponsibility =
  | "CLEARING_AGENT"
  | "TRANSPORTER"
  | "THIRD_PARTY";

export interface BiltySettlementInput {
  biltyId: string;
  biltyNo: string;
  amount: number | string | Decimal;

  // Who is responsible for / holds this Bilty's customer collection.
  // Must already be resolved to a real, active PARTY account id.
  collectionResponsibility: CollectionResponsibility;
  collectionPartyAccountId: string | null;

  agentCommission: number | string | Decimal;
  // Only required when agentCommission > 0.
  commissionResponsibility?: CommissionResponsibility | null;
  commissionPartyAccountId?: string | null;
}

export interface SettlementInput {
  challanId: string;
  challanNo: string;
  carrierRent: number | string | Decimal;

  // Only required when carrierRent > 0.
  carrierRentResponsibility: CarrierRentResponsibility;
  carrierRentPartyAccountId?: string | null;

  bilties: BiltySettlementInput[];

  // Gross/suspense clearing accounts (see lib/gross-accounts.ts).
  // Settlement reclassifies balances out of these into the real
  // responsible party - it never touches Income/Expense accounts.
  accounts: {
    grossBiltyReceivableId: string;
    grossCarrierRentPayableId: string;
    grossCommissionPayableId: string;
  };

  // Verified advances, keyed by PARTY account id. Each value must be
  // sourced from actual DAILY_POSTING JournalLines only - never from
  // Bilty.advance - and is netted against that same party's position.
  verifiedAdvanceByAccountId: Record<string, number>;
}

export interface JournalLineSpec {
  accountId: string;
  debit: number;
  credit: number;
  description: string;
  sourceType: string;
  sourceId: string;
  sourceNumber: string;
}

export interface JournalEntrySpec {
  entryDate: Date;
  referenceType: string;
  referenceId: string;
  description: string;
  lines: JournalLineSpec[];
}

export interface SettlementValidationError {
  field: string;
  message: string;
}

export interface SettlementResult {
  entries: JournalEntrySpec[];
  totals: {
    totalDebit: number;
    totalCredit: number;
  };
  errors: SettlementValidationError[];
  isValid: boolean;
  outstandingReceivable: number;
  outstandingPayable: number;
}

function toNumber(value: number | string | Decimal): number {
  if (typeof value === "number") return value;
  if (value instanceof Decimal) return value.toNumber();
  return new Decimal(value).toNumber();
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function responsibilityLabel(
  responsibility: string | null | undefined
): string {
  switch (responsibility) {
    case "CLEARING_AGENT":
      return "Clearing Agent";
    case "TRANSPORTER":
      return "Transporter/Driver";
    case "ANC":
      return "ANC direct";
    case "THIRD_PARTY":
      return "Third Party";
    default:
      return "Unspecified";
  }
}

export function buildSettlementEntries(
  input: SettlementInput
): SettlementResult {
  const errors: SettlementValidationError[] = [];
  const lines: JournalLineSpec[] = [];

  // Net (debit - credit) per PARTY account, scoped to this
  // settlement's own lines only.
  const partyNet = new Map<string, number>();

  const carrierRent = toNumber(input.carrierRent);
  const totalAmount = input.bilties.reduce(
    (sum, b) => sum + toNumber(b.amount),
    0
  );

  if (input.bilties.length === 0) {
    errors.push({ field: "bilties", message: "At least one bilty is required" });
  }

  if (carrierRent < 0) {
    errors.push({ field: "carrierRent", message: "Carrier rent cannot be negative" });
  }

  if (carrierRent > 0 && !input.carrierRentPartyAccountId) {
    errors.push({
      field: "carrierRentPartyAccountId",
      message: "A responsible party account is required for Carrier Rent.",
    });
  }

  for (const bilty of input.bilties) {
    const amount = toNumber(bilty.amount);
    const commission = toNumber(bilty.agentCommission);

    if (amount > 0 && !bilty.collectionPartyAccountId) {
      errors.push({
        field: `bilty:${bilty.biltyNo}.collection`,
        message: `A responsible party account is required for Bilty ${bilty.biltyNo}'s collection.`,
      });
    }

    if (commission > 0 && !bilty.commissionPartyAccountId) {
      errors.push({
        field: `bilty:${bilty.biltyNo}.commission`,
        message: `A responsible party account is required for Bilty ${bilty.biltyNo}'s commission.`,
      });
    }
  }

  if (errors.length > 0) {
    return {
      entries: [],
      totals: { totalDebit: 0, totalCredit: 0 },
      errors,
      isValid: false,
      outstandingReceivable: 0,
      outstandingPayable: 0,
    };
  }

  function debitParty(accountId: string, amount: number) {
    partyNet.set(accountId, (partyNet.get(accountId) || 0) + amount);
  }

  function creditParty(accountId: string, amount: number) {
    partyNet.set(accountId, (partyNet.get(accountId) || 0) - amount);
  }

  let remainingRent = carrierRent;

  for (let i = 0; i < input.bilties.length; i++) {
    const bilty = input.bilties[i];
    const amount = toNumber(bilty.amount);
    const commission = toNumber(bilty.agentCommission);

    let allocatedRent = 0;
    if (i === input.bilties.length - 1) {
      allocatedRent = remainingRent;
    } else if (totalAmount > 0) {
      allocatedRent = Number((carrierRent * (amount / totalAmount)).toFixed(2));
      remainingRent = Number((remainingRent - allocatedRent).toFixed(2));
    }

    // A. Bilty Rent / Customer Collection.
    // Reclassification only: Dr [responsible party]  Cr Gross Bilty
    // Receivable. Booking Income was already recognized once, at
    // Bilty creation - this does NOT touch it again.
    if (amount > 0 && bilty.collectionPartyAccountId) {
      const description = `Settlement - ${input.challanNo} - Bilty ${bilty.biltyNo} - Collection reclassified to ${responsibilityLabel(bilty.collectionResponsibility)}`;

      lines.push({
        accountId: bilty.collectionPartyAccountId,
        debit: amount,
        credit: 0,
        description,
        sourceType: "BILTY",
        sourceId: bilty.biltyId,
        sourceNumber: bilty.biltyNo,
      });
      lines.push({
        accountId: input.accounts.grossBiltyReceivableId,
        debit: 0,
        credit: amount,
        description,
        sourceType: "BILTY",
        sourceId: bilty.biltyId,
        sourceNumber: bilty.biltyNo,
      });

      debitParty(bilty.collectionPartyAccountId, amount);
    }

    // B. Carrier Rent (allocated pro-rata across bilties, same as
    // the amount split always was).
    // Reclassification only: Dr Gross Carrier Rent Payable  Cr
    // [responsible party]. Carrier Rent expense was already
    // recognized once, at Challan dispatch - this does NOT touch
    // it again.
    if (allocatedRent > 0 && input.carrierRentPartyAccountId) {
      const description = `Settlement - ${input.challanNo} - Bilty ${bilty.biltyNo} - Carrier Rent reclassified to ${responsibilityLabel(input.carrierRentResponsibility)}`;

      lines.push({
        accountId: input.accounts.grossCarrierRentPayableId,
        debit: allocatedRent,
        credit: 0,
        description,
        sourceType: "BILTY",
        sourceId: bilty.biltyId,
        sourceNumber: bilty.biltyNo,
      });
      lines.push({
        accountId: input.carrierRentPartyAccountId,
        debit: 0,
        credit: allocatedRent,
        description,
        sourceType: "BILTY",
        sourceId: bilty.biltyId,
        sourceNumber: bilty.biltyNo,
      });

      creditParty(input.carrierRentPartyAccountId, allocatedRent);
    }

    // C. Booking Agent Commission - exactly ONE reclassification
    // pair per bilty.
    // Reclassification only: Dr Gross Commission Payable  Cr
    // [responsible party]. Commission expense was already
    // recognized once, at Bilty creation - this does NOT touch it
    // again.
    if (commission > 0 && bilty.commissionPartyAccountId) {
      const description = `Settlement - ${input.challanNo} - Bilty ${bilty.biltyNo} - Commission reclassified to ${responsibilityLabel(bilty.commissionResponsibility)}`;

      lines.push({
        accountId: input.accounts.grossCommissionPayableId,
        debit: commission,
        credit: 0,
        description,
        sourceType: "BILTY",
        sourceId: bilty.biltyId,
        sourceNumber: bilty.biltyNo,
      });
      lines.push({
        accountId: bilty.commissionPartyAccountId,
        debit: 0,
        credit: commission,
        description,
        sourceType: "BILTY",
        sourceId: bilty.biltyId,
        sourceNumber: bilty.biltyNo,
      });

      creditParty(bilty.commissionPartyAccountId, commission);
    }
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    errors.push({
      field: "balance",
      message: `Settlement entries are not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
    });
    return {
      entries: [],
      totals: { totalDebit, totalCredit },
      errors,
      isValid: false,
      outstandingReceivable: 0,
      outstandingPayable: 0,
    };
  }

  if (lines.length === 0) {
    errors.push({
      field: "lines",
      message: "No accounting amounts to settle for this challan.",
    });
    return {
      entries: [],
      totals: { totalDebit: 0, totalCredit: 0 },
      errors,
      isValid: false,
      outstandingReceivable: 0,
      outstandingPayable: 0,
    };
  }

  // Aggregate each party's net position (debit - credit) within this
  // settlement, net of their own verified (Daily-Posting-backed)
  // advance, into a single outstanding-receivable / outstanding-payable
  // total for the Challan. A positive net means that party owes ANC
  // (receivable); a negative net means ANC owes that party (payable).
  let outstandingReceivable = 0;
  let outstandingPayable = 0;

  for (const [accountId, net] of partyNet.entries()) {
    const verified = Math.max(0, input.verifiedAdvanceByAccountId[accountId] || 0);

    if (net > 0) {
      outstandingReceivable += Math.max(0, net - verified);
    } else if (net < 0) {
      outstandingPayable += Math.max(0, -net - verified);
    }
  }

  outstandingReceivable = round2(outstandingReceivable);
  outstandingPayable = round2(outstandingPayable);

  const entry: JournalEntrySpec = {
    entryDate: new Date(),
    referenceType: "SETTLEMENT",
    referenceId: input.challanId,
    description: `Settlement - ${input.challanNo}`,
    lines,
  };

  return {
    entries: [entry],
    totals: { totalDebit, totalCredit },
    errors,
    isValid: errors.length === 0,
    outstandingReceivable,
    outstandingPayable,
  };
}
