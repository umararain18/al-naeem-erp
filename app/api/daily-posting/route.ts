import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  getGrossBiltyReceivableAccountId,
  getBillWalkInReceivableAccountId,
  getGrossCommissionPayableAccountId,
  getGrossCarrierRentPayableAccountId,
} from "@/lib/gross-accounts";
import {
  getBiltyLegitimatePartyAccountIds,
  getChallanEligiblePartyAccountIds,
  getPhonchEligiblePartyAccountIds,
  getPrivatePhonchEligiblePartyAccountIds,
  getBillEligiblePartyAccountIds,
  resolveDocumentPartyAccount,
} from "@/lib/document-party-resolution";
import { assertPaidVerificationNotExceeded, BiltyPaidVerificationError } from "@/lib/bilty-paid-verification";
import { assertPhonchReceiptNotExceeded, PhonchAccountingError } from "@/lib/phonch-accounting";
import { assertPrivatePhonchPaymentNotExceeded, PrivatePhonchAccountingError } from "@/lib/private-phonch-accounting";
import { assertBillReceiptNotExceeded, BillAccountingError } from "@/lib/bill-accounting";
import { auditPost, actorFromUser, requestContext } from "@/lib/audit-log";

const lineSchema = z.object({
  // Required for non-document-linked entries; optional for a
  // CHALLAN/BILTY-linked entry, where the responsible party can be
  // auto-resolved from the document itself. See
  // lib/document-party-resolution.ts and the per-line validation
  // below, which enforces this distinction server-side.
  counterAccountId: z
    .string()
    .optional(),

  description: z
    .string()
    .min(1, "Description is required"),

  amount: z
    .number()
    .positive("Amount must be greater than zero"),

  // This describes what happened to the MAIN selected account.
  //
  // DEBIT:
  // Main Account receives money/value.
  //
  // CREDIT:
  // Main Account pays money/value.
  direction: z.enum(["DEBIT", "CREDIT"]),

  // Optional source document
  sourceType: z
    .enum([
      "CHALLAN",
      "PHONCH",
      "PRIVATE_PHONCH",
      "BILTY",
      "BILL",
      "PARTY",
      "ACCOUNT",
      "DIRECT",
    ])
    .optional(),

  sourceId: z.string().optional(),

  sourceNumber: z.string().optional(),
});

const dailyPostingSchema = z.object({
  postingDate: z
    .string()
    .min(1, "Posting date is required"),

  // Main selected account
  accountId: z
    .string()
    .min(1, "Account is required"),

  remarks: z.string().optional(),

  // If true, user selected "Post Anyway"
  // after duplicate-document warning.
  confirmDuplicate: z.boolean().optional(),

  // Optional, client-generated per-submission-attempt token (e.g. a
  // UUID minted once when the form is opened/reset, reused only for
  // a retry of that SAME attempt - never for a new, separate
  // posting). Lets an accidental resubmission of the exact same
  // attempt (double-click, network retry, duplicate tab submission)
  // be recognized and safely no-op'd without a new JournalEntry,
  // while a genuinely new posting (fresh key) against the same
  // Challan/Bilty remains fully allowed. See the CREATE JOURNAL
  // ENTRIES section below for how this is enforced.
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/, "Invalid idempotency key")
    .optional(),

  lines: z
    .array(lineSchema)
    .min(1, "At least one entry is required"),
});


// ============================================================
// GET
// ============================================================

export async function GET(request: NextRequest) {
  try {
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

    if (!hasPermission(currentUser, "accounts.view")) {
      return NextResponse.json(
        {
          success: false,
          message: "Forbidden",
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);

    const date = searchParams.get("date");
    const accountId = searchParams.get("accountId");

    const where: {
      referenceType: string;
      isDeleted: boolean;
      referenceId?: string;
      entryDate?: {
        gte: Date;
        lt: Date;
      };
    } = {
      referenceType: "DAILY_POSTING",
      isDeleted: false,
    };

    if (accountId) {
      where.referenceId = accountId;
    }

    if (date) {
      const start = new Date(`${date}T00:00:00`);

      if (Number.isNaN(start.getTime())) {
        return NextResponse.json(
          {
            success: false,
            message: "Invalid date",
          },
          { status: 400 }
        );
      }

      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      where.entryDate = {
        gte: start,
        lt: end,
      };
    }

    const entries = await prisma.journalEntry.findMany({
      where,

      include: {
        lines: {
          include: {
            account: {
              select: {
                id: true,
                accountName: true,
                accountCode: true,
                accountType: true,
                category: true,

                party: {
                  select: {
                    id: true,
                    partyName: true,
                  },
                },
              },
            },
          },
        },
      },

      orderBy: [
        { entryDate: "desc" },
        { createdAt: "desc" },
      ],
    });

    return NextResponse.json({
      success: true,
      entries,
    });
  } catch (error) {
    console.error("Get daily postings error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Unable to load daily postings",
      },
      { status: 500 }
    );
  }
}


// ============================================================
// POST DAILY POSTING
// ============================================================

export async function POST(request: NextRequest) {
  try {
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

    if (!hasPermission(currentUser, "accounts.create")) {
      return NextResponse.json(
        {
          success: false,
          message:
            "You do not have permission to post accounting entries",
        },
        { status: 403 }
      );
    }

    const body = await request.json();

    const result = dailyPostingSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid daily posting data",
          errors: result.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const data = result.data;

    // ========================================================
    // DATE
    // ========================================================

    const postingDate = new Date(
      `${data.postingDate}T00:00:00`
    );

    if (Number.isNaN(postingDate.getTime())) {
      return NextResponse.json(
        {
          success: false,
          message: "Invalid posting date",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // MAIN ACCOUNT
    // ========================================================

    const mainAccount = await prisma.account.findUnique({
      where: {
        id: data.accountId,
      },

      include: {
        party: true,
      },
    });

    if (!mainAccount) {
      return NextResponse.json(
        {
          success: false,
          message: "Selected account not found",
        },
        { status: 404 }
      );
    }

    if (!mainAccount.isActive) {
      return NextResponse.json(
        {
          success: false,
          message: "Selected account is inactive",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // VALIDATE LINES
    // ========================================================

    // The 5 true document types - a line tagged with one of these can
    // auto-resolve its Counter Account from the document and always
    // requires a real Source ID/Document No. for that lookup. Every
    // other sourceType (PARTY/ACCOUNT) never looks up a document at
    // all (see the CHALLAN/BILTY/PHONCH/PRIVATE_PHONCH/BILL-specific
    // filters/resolution below, none of which ever match these two),
    // so Source ID/Document No. there only ever serves as an optional
    // reference. Kept in sync by hand with the matching
    // DOCUMENT_LINKED_SOURCE_TYPES set in app/daily-posting/page.tsx.
    const DOCUMENT_LINKED_SOURCE_TYPES = new Set([
      "CHALLAN",
      "BILTY",
      "PHONCH",
      "PRIVATE_PHONCH",
      "BILL",
    ]);

    // Early, narrow lookup (display-only category/accountType, never
    // the full validated fetch further below) used solely to decide
    // whether Source ID/Document No. can be skipped for a non-
    // document sourceType (PARTY/ACCOUNT) - see
    // isSourceDocumentExempt() below. A true document-linked line is
    // never affected by this and keeps requiring both exactly as
    // before.
    const earlyCounterAccountIds = Array.from(
      new Set(
        data.lines
          .map((line) => line.counterAccountId)
          .filter((id): id is string => !!id)
      )
    );

    const earlyCounterAccounts =
      earlyCounterAccountIds.length > 0
        ? await prisma.account.findMany({
            where: { id: { in: earlyCounterAccountIds } },
            select: { id: true, category: true, accountType: true },
          })
        : [];

    const earlyAccountById = new Map(
      earlyCounterAccounts.map((account) => [account.id, account])
    );

    // Source ID/Document No. is optional whenever the line's
    // sourceType is NOT one of the true document types above AND the
    // selected Counter Account is Booking Income, Delivery Income
    // (covers Showroom Delivery Income/Private Phonch Delivery
    // Income/Bill Income - all stored under this same category, see
    // lib/gross-accounts.ts) or any Party account - confirmed by the
    // account's own stable category/accountType field, never by its
    // name.
    function isSourceDocumentExempt(
      sourceType: string | undefined,
      counterAccountId: string | undefined
    ): boolean {
      if (!sourceType || DOCUMENT_LINKED_SOURCE_TYPES.has(sourceType)) {
        return false;
      }
      if (!counterAccountId) return false;
      const account = earlyAccountById.get(counterAccountId);
      if (!account) return false;
      return (
        account.category === "BOOKING_INCOME" ||
        account.category === "DELIVERY_INCOME" ||
        account.accountType === "PARTY"
      );
    }

    for (const line of data.lines) {
      // Document-linked entry requires source ID.
      if (
        line.sourceType &&
        line.sourceType !== "DIRECT" &&
        !line.sourceId &&
        !isSourceDocumentExempt(line.sourceType, line.counterAccountId)
      ) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Source ID is required for document-linked entries",
          },
          { status: 400 }
        );
      }

      // If source type exists, source number should normally exist
      // for document searching.
      if (
        line.sourceType &&
        line.sourceType !== "DIRECT" &&
        !line.sourceNumber &&
        !isSourceDocumentExempt(line.sourceType, line.counterAccountId)
      ) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Document number is required for document-linked entries",
          },
          { status: 400 }
        );
      }

      // Counter account remains REQUIRED for every entry that is
      // not linked to a Challan/Bilty/Phonch/Private Phonch/Bill -
      // only those can auto-resolve the responsible party from the
      // document itself (see below).
      if (
        line.sourceType !== "CHALLAN" &&
        line.sourceType !== "BILTY" &&
        line.sourceType !== "PHONCH" &&
        line.sourceType !== "PRIVATE_PHONCH" &&
        line.sourceType !== "BILL" &&
        !line.counterAccountId
      ) {
        return NextResponse.json(
          {
            success: false,
            message: "Counter account is required",
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // PER-ENTRY CHALLAN / BILTY DOCUMENT LOOKUP
    //
    // Each Daily Entry line carries its own sourceType/sourceId
    // (already part of the JournalLine architecture). A line may
    // independently reference a Challan, a Bilty, or nothing
    // (DIRECT) - there is no longer a single document that
    // applies to the whole posting. This lets one Daily Posting
    // contain receipts/payments against several different
    // Challans/Bilties plus direct entries in the same submit.
    //
    // Every CHALLAN/BILTY-tagged line is verified against the real
    // record (never trust the client's sourceId blindly) and
    // resolved here BEFORE counter accounts are validated, because
    // a line with no manually-supplied Counter Account needs its
    // responsible party resolved from the document first.
    // ========================================================

    const indexedLines = data.lines.map((line, index) => ({ line, index }));
    const challanLineEntries = indexedLines.filter(
      ({ line }) => line.sourceType === "CHALLAN"
    );
    const biltyLineEntries = indexedLines.filter(
      ({ line }) => line.sourceType === "BILTY"
    );
    const phonchLineEntries = indexedLines.filter(
      ({ line }) => line.sourceType === "PHONCH"
    );
    const privatePhonchLineEntries = indexedLines.filter(
      ({ line }) => line.sourceType === "PRIVATE_PHONCH"
    );
    const billLineEntries = indexedLines.filter(
      ({ line }) => line.sourceType === "BILL"
    );

    if (challanLineEntries.length > 0 && !hasPermission(currentUser, "challan.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    if (biltyLineEntries.length > 0 && !hasPermission(currentUser, "bilty.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    if (phonchLineEntries.length > 0 && !hasPermission(currentUser, "phonch.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    if (privatePhonchLineEntries.length > 0 && !hasPermission(currentUser, "privatePhonch.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    if (billLineEntries.length > 0 && !hasPermission(currentUser, "bill.view")) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const challanIds = Array.from(
      new Set(challanLineEntries.map(({ line }) => line.sourceId!))
    );
    const biltyIds = Array.from(
      new Set(biltyLineEntries.map(({ line }) => line.sourceId!))
    );
    const phonchIds = Array.from(
      new Set(phonchLineEntries.map(({ line }) => line.sourceId!))
    );
    const privatePhonchIds = Array.from(
      new Set(privatePhonchLineEntries.map(({ line }) => line.sourceId!))
    );
    const billIds = Array.from(
      new Set(billLineEntries.map(({ line }) => line.sourceId!))
    );

    const linkedChallans = challanIds.length > 0
      ? await prisma.challan.findMany({
          where: { id: { in: challanIds }, isDeleted: false },
          select: { id: true, challanNo: true },
        })
      : [];

    const linkedBilties = biltyIds.length > 0
      ? await prisma.bilty.findMany({
          where: { id: { in: biltyIds }, isDeleted: false },
          select: { id: true, biltyNo: true },
        })
      : [];

    const linkedPhonches = phonchIds.length > 0
      ? await prisma.phonch.findMany({
          where: { id: { in: phonchIds }, isDeleted: false },
          select: { id: true, phonchNo: true },
        })
      : [];

    const linkedPrivatePhonches = privatePhonchIds.length > 0
      ? await prisma.privatePhonch.findMany({
          where: { id: { in: privatePhonchIds }, isDeleted: false },
          select: { id: true, phonchNo: true },
        })
      : [];

    const linkedBills = billIds.length > 0
      ? await prisma.bill.findMany({
          where: { id: { in: billIds }, isDeleted: false },
          select: { id: true, billNo: true },
        })
      : [];

    const challanNoById = new Map(linkedChallans.map((c) => [c.id, c.challanNo]));
    const biltyNoById = new Map(linkedBilties.map((b) => [b.id, b.biltyNo]));
    const phonchNoById = new Map(linkedPhonches.map((p) => [p.id, p.phonchNo]));
    const privatePhonchNoById = new Map(linkedPrivatePhonches.map((p) => [p.id, p.phonchNo]));
    const billNoById = new Map(linkedBills.map((b) => [b.id, b.billNo]));

    for (const { line, index } of challanLineEntries) {
      if (!challanNoById.has(line.sourceId!)) {
        return NextResponse.json(
          {
            success: false,
            message: `Selected Challan was not found in entry ${index + 1}`,
          },
          { status: 400 }
        );
      }
    }

    for (const { line, index } of biltyLineEntries) {
      if (!biltyNoById.has(line.sourceId!)) {
        return NextResponse.json(
          {
            success: false,
            message: `Selected Bilty was not found in entry ${index + 1}`,
          },
          { status: 400 }
        );
      }
    }

    for (const { line, index } of phonchLineEntries) {
      if (!phonchNoById.has(line.sourceId!)) {
        return NextResponse.json(
          {
            success: false,
            message: `Selected Phonch was not found in entry ${index + 1}`,
          },
          { status: 400 }
        );
      }
    }

    for (const { line, index } of privatePhonchLineEntries) {
      if (!privatePhonchNoById.has(line.sourceId!)) {
        return NextResponse.json(
          {
            success: false,
            message: `Selected Private Phonch was not found in entry ${index + 1}`,
          },
          { status: 400 }
        );
      }
    }

    for (const { line, index } of billLineEntries) {
      if (!billNoById.has(line.sourceId!)) {
        return NextResponse.json(
          {
            success: false,
            message: `Selected Bill was not found in entry ${index + 1}`,
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // AUTO-RESOLVE COUNTER ACCOUNT FROM THE DOCUMENT
    //
    // A CHALLAN/BILTY-linked line with no manually-supplied Counter
    // Account has the responsible party resolved from the document
    // itself (lib/document-party-resolution.ts). This never guesses
    // when the document doesn't identify a single, unambiguous
    // party - the posting is rejected with a clear message instead,
    // exactly as if the (still required) Counter Account had been
    // left blank before this feature existed.
    //
    // A manually-supplied Counter Account is always honored as-is.
    // ========================================================

    const preparedLines: (typeof data.lines[number] & { counterAccountId: string; wasManuallySupplied: boolean })[] = [];

    for (const { line, index } of indexedLines) {
      if (line.counterAccountId) {
        preparedLines.push({ ...line, counterAccountId: line.counterAccountId, wasManuallySupplied: true });
        continue;
      }

      // VALIDATE LINES (above) already guarantees only CHALLAN/BILTY/
      // PHONCH/PRIVATE_PHONCH/BILL lines can reach here without a
      // counterAccountId.
      const resolved = await resolveDocumentPartyAccount(
        line.sourceType as "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH" | "BILL",
        line.sourceId!,
        line.direction
      );

      if (!resolved) {
        return NextResponse.json(
          {
            success: false,
            message: `Entry ${index + 1}: Unable to auto-resolve a party account for ${line.sourceType} ${line.sourceNumber || line.sourceId}. Please select a Counter Account manually.`,
          },
          { status: 400 }
        );
      }

      preparedLines.push({ ...line, counterAccountId: resolved.accountId, wasManuallySupplied: false });
    }

    for (const line of preparedLines) {
      if (line.counterAccountId === data.accountId) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Main account cannot be its own counter account",
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // HARD REJECT: manually-supplied Counter Account mismatching an
    // established responsible Party for a Bilty-linked line.
    //
    // A Bilty can have TWO independently legitimate money
    // destinations - its Collection/To-Pay responsible party(ies)
    // and its Paid-amount responsible party (Consignor/Consignee,
    // see lib/document-party-resolution.ts). Either is accepted.
    // Only a Counter Account matching NEITHER, when at least one IS
    // established, is rejected - never silently substituted, never
    // merely warned. A Bilty with nothing established yet (no
    // Collection party, no Paid responsibility) is unaffected, exactly
    // as before this feature existed.
    // ========================================================

    for (const { line, index } of preparedLines.map((line, index) => ({ line, index }))) {
      if (line.sourceType !== "BILTY" || !line.wasManuallySupplied || !line.sourceId) continue;

      const legitimateAccountIds = await getBiltyLegitimatePartyAccountIds(line.sourceId, line.direction);
      // A manually-supplied Counter Account must always match SOMETHING
      // legitimate for this Bilty - never accepted merely because
      // nothing else is known yet. An empty set (nothing established,
      // and none of the Bilty's own Consignor/Consignee/Clearing Agent
      // has a valid account either) means there is no safe automatic
      // destination at all, so EVERY manually-supplied account is
      // rejected here, not just a mismatched one - closing the "allow
      // anything because nothing is known" gap the Step 1 audit found.
      if (!legitimateAccountIds.has(line.counterAccountId)) {
        return NextResponse.json(
          {
            success: false,
            message:
              legitimateAccountIds.size > 0
                ? `Entry ${index + 1}: The selected Counter Account does not match this Bilty's established responsible Party. Select the correct Party, or leave Counter Account blank to auto-resolve.`
                : `Entry ${index + 1}: This Bilty has no established or identifiable responsible Party (no valid Consignor/Consignee/Clearing Agent account, no Collection or Paid responsibility). Please verify the Bilty's parties before posting against it.`,
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // HARD REJECT: manually-supplied Counter Account mismatching an
    // eligible Receivable/Payable party for a Challan-linked line.
    //
    // Per the LOCKED rule (lib/document-party-resolution.ts's
    // resolveChallanParty()): a manually-supplied Counter Account for
    // a Challan line must be one of the parties with an outstanding
    // Receivable (RECEIPT/DEBIT) or Payable (PAYMENT/CREDIT) against
    // that Challan - never a Transporter/Clearing Agent account
    // merely because it exists on the document. A Challan with no
    // eligible party for this direction yet (empty set) is
    // unaffected, exactly as before this feature existed.
    // ========================================================

    for (const { line, index } of preparedLines.map((line, index) => ({ line, index }))) {
      if (line.sourceType !== "CHALLAN" || !line.wasManuallySupplied || !line.sourceId) continue;

      const eligibleAccountIds = await getChallanEligiblePartyAccountIds(line.sourceId, line.direction);

      if (eligibleAccountIds.size > 0 && !eligibleAccountIds.has(line.counterAccountId)) {
        return NextResponse.json(
          {
            success: false,
            message: `Entry ${index + 1}: The selected Counter Account is not an outstanding ${
              line.direction === "DEBIT" ? "Receivable" : "Payable"
            } party for this Challan. Select one of the eligible parties, or leave Counter Account blank to auto-resolve.`,
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // HARD REJECT: manually-supplied Counter Account mismatching an
    // eligible payable/deposit party for a Private Phonch-linked
    // line. Per the LOCKED rule (lib/document-party-resolution.ts's
    // resolvePrivatePhonchParty()): a manually-supplied Counter
    // Account for a Private Phonch line must be one of the parties
    // with an outstanding Carrier/CA Payable (CREDIT/PAYMENT) or, for
    // a Clearing Agent deposit (DEBIT/RECEIPT), one of the Clearing
    // Agents actually named on this Private Phonch - never an
    // unrelated Party merely because it was typed in manually. A
    // Private Phonch with no eligible party for this direction yet
    // (empty set) is unaffected.
    // ========================================================

    for (const { line, index } of preparedLines.map((line, index) => ({ line, index }))) {
      if (line.sourceType !== "PRIVATE_PHONCH" || !line.wasManuallySupplied || !line.sourceId) continue;

      const eligibleAccountIds = await getPrivatePhonchEligiblePartyAccountIds(line.sourceId, line.direction);

      if (eligibleAccountIds.size > 0 && !eligibleAccountIds.has(line.counterAccountId)) {
        return NextResponse.json(
          {
            success: false,
            message: `Entry ${index + 1}: The selected Counter Account is not an outstanding ${
              line.direction === "DEBIT" ? "deposit-eligible Clearing Agent" : "payable"
            } party for this Private Phonch. Select one of the eligible parties, or leave Counter Account blank to auto-resolve.`,
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // HARD REJECT: manually-supplied Counter Account mismatching a
    // Showroom Phonch's own Transporter. Per the LOCKED rule
    // (lib/document-party-resolution.ts's resolvePhonchParty(), reused
    // by getPhonchEligiblePartyAccountIds()): a Phonch has exactly one
    // legitimate counterparty, its own Transporter - never an
    // unrelated Party merely because it was typed in manually. Unlike
    // Challan/Private Phonch's "empty set is unaffected" fallback
    // (which exists for their own more flexible multi-party models), a
    // Phonch's Transporter is a required field at creation, so an
    // empty set here (no active Transporter account) means there is no
    // safe destination at all and every manually-supplied account is
    // rejected - the same strict behavior as Bilty's own equivalent
    // guard above.
    // ========================================================

    for (const { line, index } of preparedLines.map((line, index) => ({ line, index }))) {
      if (line.sourceType !== "PHONCH" || !line.wasManuallySupplied || !line.sourceId) continue;

      const eligibleAccountIds = await getPhonchEligiblePartyAccountIds(line.sourceId);

      if (!eligibleAccountIds.has(line.counterAccountId)) {
        return NextResponse.json(
          {
            success: false,
            message: `Entry ${index + 1}: The selected Counter Account is not this Phonch's own Transporter. Select the correct Transporter, or leave Counter Account blank to auto-resolve.`,
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // HARD REJECT: manually-supplied Counter Account mismatching a
    // Bill's own Client Party. Per the LOCKED rule
    // (lib/document-party-resolution.ts's resolveBillParty(), reused
    // by getBillEligiblePartyAccountIds()): a Bill has exactly one
    // legitimate counterparty, its own Client - never an unrelated
    // Party (e.g. a Clearing Agent named on the source Phonch) merely
    // because it was typed in manually. Same strict "reject everything
    // when nothing legitimate exists" behavior as Phonch's own
    // equivalent guard above, since a Bill's Client is a required
    // field at creation.
    // ========================================================

    for (const { line, index } of preparedLines.map((line, index) => ({ line, index }))) {
      if (line.sourceType !== "BILL" || !line.wasManuallySupplied || !line.sourceId) continue;

      const eligibleAccountIds = await getBillEligiblePartyAccountIds(line.sourceId);

      if (!eligibleAccountIds.has(line.counterAccountId)) {
        return NextResponse.json(
          {
            success: false,
            message: `Entry ${index + 1}: The selected Counter Account is not this Bill's own Client. Select the correct Client, or leave Counter Account blank to auto-resolve.`,
          },
          { status: 400 }
        );
      }
    }

    // ========================================================
    // COUNTER ACCOUNTS
    // ========================================================

    const counterAccountIds = Array.from(
      new Set(
        preparedLines.map(
          (line) => line.counterAccountId
        )
      )
    );

    const counterAccounts =
      await prisma.account.findMany({
        where: {
          id: {
            in: counterAccountIds,
          },
        },

        select: {
          id: true,
          accountName: true,
          accountCode: true,
          accountType: true,
          category: true,
          isActive: true,
          party: {
            select: {
              id: true,
              partyName: true,
            },
          },
        },
      });

    if (
      counterAccounts.length !==
      counterAccountIds.length
    ) {
      return NextResponse.json(
        {
          success: false,
          message:
            "One or more counter accounts were not found",
        },
        { status: 404 }
      );
    }

    const inactiveCounterAccount =
      counterAccounts.find(
        (account) => !account.isActive
      );

    if (inactiveCounterAccount) {
      return NextResponse.json(
        {
          success: false,
          message: `Account "${inactiveCounterAccount.accountName}" is inactive`,
        },
        { status: 400 }
      );
    }

    // ========================================================
    // PARTY <-> CASH/BANK RESTRICTION (CHALLAN/BILTY/PHONCH/PRIVATE_
    // PHONCH/BILL lines)
    //
    // Restricted to PARTY <-> CASH/BANK movement, so Income/Expense
    // accounts can't be touched through a document-linked line.
    // Settlement already owns revenue/expense accruals for these
    // documents. Uses the RESOLVED counter account, so an auto-
    // resolved party is checked exactly like a manually selected one.
    //
    // Narrow, per-document exception: a handful of shared "Unallocated"
    // system accounts (never a Party) are the ONLY other legitimate
    // destination - but ONLY when THIS EXACT document's own party
    // resolution (resolveDocumentPartyAccount(), the same single
    // source of truth used everywhere else) genuinely points there.
    // A manually-supplied counter account that happens to match one of
    // these account ids for an UNRELATED document is still rejected -
    // this never becomes "any Unallocated account is fine for any
    // document". Identified by stable accountCode (via each account's
    // own getter in lib/gross-accounts.ts), never by name:
    //  - GROSS-BILTY-RECEIVABLE (BILTY RECEIPT - already reachable via
    //    resolveBiltyParty()'s own resolveUnclaimedGrossBiltyReceivable()
    //    candidate, kept here too for documentation/future-proofing).
    //  - BILL-WALKIN-RECEIVABLE (BILL with no linked Client Party -
    //    resolveBillParty() returns this exact account; this was the
    //    reported bug - a walk-in Bill's own receipt was rejected).
    //  - GROSS-COMMISSION-PAYABLE / GROSS-CARRIER-RENT-PAYABLE - listed
    //    for completeness, but neither resolveBiltyParty() nor
    //    resolveChallanParty() ever resolves to them today (pure
    //    Settlement-time clearing accounts), so the match check below
    //    will correctly keep rejecting them unless/until a real
    //    resolution path to them is ever added.
    // ========================================================

    const categoryMap: Record<string, string> = {};
    if (mainAccount) categoryMap[mainAccount.id] = mainAccount.category;
    for (const a of counterAccounts) categoryMap[a.id] = a.category;

    const isCashBank = (cat: string) => cat === "CASH" || cat === "BANK";

    const grossBiltyReceivableId = await getGrossBiltyReceivableAccountId(prisma);
    const approvedUnallocatedAccountIds = new Set([
      grossBiltyReceivableId,
      await getBillWalkInReceivableAccountId(prisma),
      await getGrossCommissionPayableAccountId(prisma),
      await getGrossCarrierRentPayableAccountId(prisma),
    ]);

    // True only when `accountId` is one of the approved Unallocated
    // accounts above AND it is genuinely where THIS line's own
    // document resolves its responsible party to - never a blanket
    // "any Unallocated account" allowance.
    async function isApprovedUnallocatedMatch(
      accountId: string,
      line: (typeof preparedChallanBiltyLines)[number]["line"]
    ): Promise<boolean> {
      if (!approvedUnallocatedAccountIds.has(accountId)) return false;
      const resolved = await resolveDocumentPartyAccount(
        line.sourceType as "CHALLAN" | "BILTY" | "PHONCH" | "PRIVATE_PHONCH" | "BILL",
        line.sourceId!,
        line.direction
      );
      return !!resolved && resolved.accountId === accountId;
    }

    const preparedChallanBiltyLines = preparedLines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          line.sourceType === "CHALLAN" ||
          line.sourceType === "BILTY" ||
          line.sourceType === "PHONCH" ||
          line.sourceType === "PRIVATE_PHONCH" ||
          line.sourceType === "BILL"
      );

    for (const { line, index } of preparedChallanBiltyLines) {
      const mainCat = mainAccount ? categoryMap[mainAccount.id] : "";
      const counterCat = categoryMap[line.counterAccountId] || "";

      let valid =
        (mainCat === "PARTY" && isCashBank(counterCat)) ||
        (counterCat === "PARTY" && isCashBank(mainCat)) ||
        (line.sourceType === "BILTY" &&
          line.direction === "DEBIT" &&
          isCashBank(mainCat) &&
          line.counterAccountId === grossBiltyReceivableId);

      if (!valid && isCashBank(mainCat)) {
        valid = await isApprovedUnallocatedMatch(line.counterAccountId, line);
      }

      if (!valid && mainAccount && isCashBank(counterCat)) {
        valid = await isApprovedUnallocatedMatch(mainAccount.id, line);
      }

      if (!valid) {
        return NextResponse.json(
          {
            success: false,
            message: `Entry ${index + 1}: Challan/Bilty/Phonch/Private Phonch/Bill-linked posting must move money only between a PARTY account and a CASH/BANK account.`,
          },
          { status: 400 }
        );
      }
    }

    // Canonical document numbers - never trust the client-supplied
    // sourceNumber for CHALLAN/BILTY lines.
    const resolvedLines = preparedLines.map((line) => {
      if (line.sourceType === "CHALLAN") {
        return {
          ...line,
          sourceNumber: challanNoById.get(line.sourceId!) || line.sourceNumber,
        };
      }
      if (line.sourceType === "BILTY") {
        return {
          ...line,
          sourceNumber: biltyNoById.get(line.sourceId!) || line.sourceNumber,
        };
      }
      if (line.sourceType === "PHONCH") {
        return {
          ...line,
          sourceNumber: phonchNoById.get(line.sourceId!) || line.sourceNumber,
        };
      }
      if (line.sourceType === "PRIVATE_PHONCH") {
        return {
          ...line,
          sourceNumber: privatePhonchNoById.get(line.sourceId!) || line.sourceNumber,
        };
      }
      if (line.sourceType === "BILL") {
        return {
          ...line,
          sourceNumber: billNoById.get(line.sourceId!) || line.sourceNumber,
        };
      }
      return line;
    });

    // ========================================================
    // DUPLICATE DOCUMENT WARNING
    //
    // IMPORTANT:
    // Same account + same date is ALWAYS allowed.
    //
    // Only already-used document references generate warning.
    //
    // CHALLAN / BILTY sources are EXCLUDED: multiple partial
    // receipts/payments against the same Challan/Bilty are
    // legitimate and must not be flagged as duplicates.
    // ========================================================

    const documentLines = resolvedLines.filter(
      (line) =>
        line.sourceType &&
        line.sourceType !== "DIRECT" &&
        line.sourceType !== "CHALLAN" &&
        line.sourceType !== "BILTY" &&
        line.sourceType !== "PHONCH" &&
        line.sourceType !== "PRIVATE_PHONCH" &&
        line.sourceType !== "BILL" &&
        line.sourceId
    );

    const duplicateWarnings: Array<{
      sourceType: string;
      sourceId: string;
      sourceNumber: string | null;
      existingJournalEntryId: string;
      existingDate: Date;
      amount: string;
    }> = [];

    for (const line of documentLines) {
      const existingLine =
        await prisma.journalLine.findFirst({
          where: {
            sourceType: line.sourceType,
            sourceId: line.sourceId,
            journalEntry: {
              is: {
                isDeleted: false,
              },
            },
          },

          include: {
            journalEntry: {
              select: {
                id: true,
                entryDate: true,
              },
            },
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      if (existingLine) {
        duplicateWarnings.push({
          sourceType: line.sourceType!,
          sourceId: line.sourceId!,
          sourceNumber:
            line.sourceNumber || null,
          existingJournalEntryId:
            existingLine.journalEntryId,
          existingDate:
            existingLine.journalEntry.entryDate,
          amount:
            existingLine.debit.toString() !== "0"
              ? existingLine.debit.toString()
              : existingLine.credit.toString(),
        });
      }
    }

    // --------------------------------------------------------
    // WARNING ONLY
    //
    // Do NOT block.
    //
    // Frontend receives warning and can send:
    // confirmDuplicate: true
    //
    // to continue posting.
    // --------------------------------------------------------

    if (
      duplicateWarnings.length > 0 &&
      !data.confirmDuplicate
    ) {
      return NextResponse.json(
        {
          success: false,

          warning: true,

          message:
            "One or more selected documents have already been posted.",

          duplicates: duplicateWarnings,

          requiresConfirmation: true,
        },
        { status: 409 }
      );
    }

    // ========================================================
    // BUILD JOURNAL LINES
    //
    // Every Daily Posting line creates TWO journal lines:
    //
    // Example:
    //
    // Main Account = Umar Bank
    // Direction    = DEBIT
    // Amount       = 100,000
    // Counter      = Customer ABC
    //
    // Result:
    //
    // Umar Bank       Dr 100,000
    // Customer ABC    Cr 100,000
    // ========================================================

    function buildLinePair(line: (typeof resolvedLines)[number]) {
      const mainDebit =
        line.direction === "DEBIT" ? line.amount : 0;

      const mainCredit =
        line.direction === "CREDIT" ? line.amount : 0;

      const counterDebit =
        line.direction === "CREDIT" ? line.amount : 0;

      const counterCredit =
        line.direction === "DEBIT" ? line.amount : 0;

      return [
        {
          accountId: data.accountId,
          description: line.description,
          debit: mainDebit,
          credit: mainCredit,
          sourceType: line.sourceType || "DIRECT",
          sourceId: line.sourceId || null,
          sourceNumber: line.sourceNumber || null,
        },
        {
          accountId: line.counterAccountId,
          description: line.description,
          debit: counterDebit,
          credit: counterCredit,
          sourceType: line.sourceType || "DIRECT",
          sourceId: line.sourceId || null,
          sourceNumber: line.sourceNumber || null,
        },
      ];
    }

    // ========================================================
    // GROUP LINES INTO JOURNAL ENTRIES BY DOCUMENT
    //
    // computeChallanFinancialsBatch() (lib/challan-financials.ts,
    // protected/unmodified) attributes ALL PARTY-category lines
    // of a matched JournalEntry to that entry's owning Challan -
    // it does not filter by sourceId within the entry. That is
    // safe only if a JournalEntry never mixes lines belonging to
    // two different CHALLAN/BILTY documents.
    //
    // Per-entry linking (this feature) allows one Daily Posting
    // submission to reference several different Challans/Bilties
    // at once. To keep challan-financials' amounts correct, each
    // distinct CHALLAN/BILTY document gets its OWN JournalEntry;
    // every DIRECT/other line shares one remaining JournalEntry.
    // All resulting entries are still created atomically from the
    // single Daily Posting submission.
    // ========================================================

    const groups = new Map<string, typeof resolvedLines>();
    const DIRECT_GROUP = "__DIRECT__";

    for (const line of resolvedLines) {
      const key =
        (line.sourceType === "CHALLAN" || line.sourceType === "BILTY") &&
        line.sourceId
          ? `${line.sourceType}:${line.sourceId}`
          : DIRECT_GROUP;

      const existing = groups.get(key) || [];
      existing.push(line);
      groups.set(key, existing);
    }

    const journalLines = [...groups.values()].flatMap((groupLines) =>
      groupLines.flatMap(buildLinePair)
    );

    const totalDebit = journalLines.reduce(
      (sum, line) => sum + line.debit,
      0
    );

    const totalCredit = journalLines.reduce(
      (sum, line) => sum + line.credit,
      0
    );

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Journal entry is not balanced. Total debit must equal total credit.",
        },
        { status: 400 }
      );
    }

    // ========================================================
    // CREATE JOURNAL ENTRIES
    //
    // One Daily Posting submission creates one JournalEntry per
    // distinct document (Challan/Bilty) plus one for DIRECT/other
    // lines, all inside a single atomic transaction.
    //
    // Same account + same date can be posted again.
    //
    // IDEMPOTENCY (P2-1): when the client supplies idempotencyKey,
    // each entry in this submission is created with an EXPLICIT id
    // derived from that key instead of an auto-generated cuid -
    // reusing JournalEntry's existing primary-key uniqueness
    // constraint rather than adding any new schema/column. An exact
    // resubmission of the same attempt (same key) therefore always
    // tries to insert the same id(s) again, which the database
    // itself rejects (P2002) - caught below and turned into a safe
    // "already processed" response instead of a second posting. A
    // genuinely NEW posting (fresh key) is unaffected and always
    // succeeds normally, even against the same Challan/Bilty.
    // ========================================================

    const entryIds = data.idempotencyKey
      ? [...groups.keys()].map((_, i) => `idem_${data.idempotencyKey}_${i}`)
      : null;

    const entryInclude = {
      lines: {
        include: {
          account: {
            select: {
              id: true,
              accountName: true,
              accountCode: true,
              accountType: true,
              category: true,

              party: {
                select: {
                  id: true,
                  partyName: true,
                },
              },
            },
          },
        },
      },
    } as const;

    let journalEntries;
    let idempotentReplay = false;

    try {
      journalEntries = await prisma.$transaction(async (tx) => {
        // GUARD (lib/bilty-paid-verification.ts): validate every
        // Bilty-tagged receipt against this SAME `tx`, BEFORE creating
        // any entry - all-or-nothing, and race-safe against a
        // concurrent Daily Posting for the same Bilty, which is why
        // this transaction is now SERIALIZABLE.
        for (const line of resolvedLines) {
          if (line.sourceType === "BILTY" && line.sourceId) {
            await assertPaidVerificationNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction);
          }
          if (line.sourceType === "PHONCH" && line.sourceId) {
            await assertPhonchReceiptNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction);
          }
          if (line.sourceType === "PRIVATE_PHONCH" && line.sourceId) {
            await assertPrivatePhonchPaymentNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction);
          }
          if (line.sourceType === "BILL" && line.sourceId) {
            await assertBillReceiptNotExceeded(tx, line.sourceId, line.counterAccountId, line.amount, line.direction);
          }
        }

        const created = [];
        let index = 0;

        for (const groupLines of groups.values()) {
          const entry = await tx.journalEntry.create({
            data: {
              ...(entryIds ? { id: entryIds[index] } : {}),
              entryDate: postingDate,
              referenceType: "DAILY_POSTING",
              referenceId: data.accountId,
              description:
                data.remarks ||
                `Daily Posting - ${mainAccount.accountName}`,
              createdById: currentUser.userId,
              lines: {
                create: groupLines.flatMap(buildLinePair),
              },
            },
            include: entryInclude,
          });

          created.push(entry);
          index++;

          const lineSummary = groupLines
            .map((l) => `${l.direction === "DEBIT" ? "Receipt" : "Payment"} Rs. ${l.amount.toLocaleString()}${l.sourceNumber ? ` (${l.sourceType} ${l.sourceNumber})` : ""}`)
            .join(", ");
          await auditPost(tx, {
            actor: actorFromUser(currentUser),
            module: "DAILY_POSTING",
            entityType: "JournalEntry",
            entityId: entry.id,
            documentNo: mainAccount.accountName,
            description: `Posted Daily Posting on ${mainAccount.accountName}: ${lineSummary}`,
            newValues: {
              accountId: mainAccount.id,
              lines: groupLines.map((l) => ({
                direction: l.direction,
                amount: l.amount,
                counterAccountId: l.counterAccountId,
                sourceType: l.sourceType || null,
                sourceId: l.sourceId || null,
                sourceNumber: l.sourceNumber || null,
              })),
            },
            ...requestContext(request),
          });
        }

        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
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

      if (error instanceof BillAccountingError) {
        return NextResponse.json(
          { success: false, code: error.code, message: error.message },
          { status: 400 }
        );
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "Another Daily Posting for the same Bilty/Challan happened at the same time. Please retry." },
          { status: 409 }
        );
      }

      const isIdempotencyCollision =
        entryIds &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";

      if (!isIdempotencyCollision) {
        throw error;
      }

      // Same idempotencyKey as an earlier successful submission -
      // that attempt already created these exact entries. Return
      // them as-is rather than posting (or erroring) again.
      const existing = await prisma.journalEntry.findMany({
        where: { id: { in: entryIds! } },
        include: entryInclude,
      });

      if (existing.length !== entryIds!.length) {
        // Defensive only - a partial/unexpected state should never
        // occur since entries are created in one transaction, but
        // fail safely rather than guess.
        return NextResponse.json(
          {
            success: false,
            message:
              "This submission could not be completed. Please try again with a new entry.",
          },
          { status: 409 }
        );
      }

      journalEntries = existing;
      idempotentReplay = true;
    }

    // ========================================================
    // SUCCESS
    // ========================================================

    return NextResponse.json(
      {
        success: true,

        message: idempotentReplay
          ? "This posting was already processed."
          : "Daily posting posted successfully",

        idempotentReplay: idempotentReplay || undefined,

        journalEntry: journalEntries[0],
        journalEntries,

        duplicateWarnings:
          duplicateWarnings.length > 0
            ? duplicateWarnings
            : undefined,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error(
      "Daily posting error:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          "Something went wrong while posting the daily accounts",
      },
      { status: 500 }
    );
  }
}
