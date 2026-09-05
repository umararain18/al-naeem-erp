import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  buildSettlementEntries,
  type BiltySettlementInput,
  type CarrierRentResponsibility,
  type CollectionResponsibility,
  type CommissionResponsibility,
} from "@/lib/settlement-accounting";
import {
  getGrossBiltyReceivableAccountId,
  getGrossCarrierRentPayableAccountId,
  getGrossCommissionPayableAccountId,
} from "@/lib/gross-accounts";
import { createSettlementPayment, reconcileCollectionAttributionAtSettlement, SettlementPaymentError } from "@/lib/settlement-payments";

// ============================================================
// POST /api/challan/[id]/finalize-settlement
//
// The SINGLE user-facing "Finalize Settlement" action, replacing the
// old multi-field responsibility wizard entirely from the user's
// point of view. It does NOT introduce a new accounting mechanism -
// it orchestrates the exact two existing, already-tested mechanisms
// in one atomic transaction:
//
//   1. buildSettlementEntries() (lib/settlement-accounting.ts) - the
//      SAME pure accounting function POST /settle already used,
//      called here with SAFE, DETERMINISTIC DEFAULTS computed from
//      data the Bilty/Challan already carry (a Bilty's own Clearing
//      Agent, the Challan's own Transporter, a Bilty's own Booking
//      Agent) - never a guess, never fabricated, and NEVER exposed
//      to the user as a choice. This performs the exact same
//      Gross-Bilty-Receivable / Gross-Carrier-Rent-Payable /
//      Gross-Commission-Payable reclassification the old wizard did,
//      sets challan.isSettled/settledAt/settledById/
//      settlementJournalEntryId/outstandingReceivable/
//      outstandingPayable identically.
//   2. createSettlementPayment() (lib/settlement-payments.ts), called
//      with this same transaction as its externalTx, once per
//      allocation the user already entered in the ONE Final
//      Settlement screen (optional - zero allocations is valid; more
//      can always be added afterward through the existing
//      /settlement-payments endpoints once the Challan is settled).
//
// Both happen in ONE $transaction: if any allocation is invalid
// (amount exceeds its component's remaining capacity, bad account,
// etc.) the ENTIRE transaction rolls back - the Challan is never left
// isSettled=true with a rejected allocation, and never left with a
// SettlementPayment row but no settlement. See lib/settlement-
// payments.ts's own SERIALIZABLE + P2034 handling, reused unchanged.
// ============================================================

const allocationSchema = z.object({
  component: z.enum(["COLLECTION", "CARRIER_RENT"]),
  biltyId: z.string().optional(),
  payerAccountId: z.string().min(1),
  amount: z.number().positive(),
});

const finalizeSchema = z.object({
  settlementNotes: z.string().optional(),
  allocations: z.array(allocationSchema).optional(),
});

function errorStatus(code: string): number {
  switch (code) {
    case "CHALLAN_NOT_FOUND":
    case "BILTY_NOT_FOUND":
    case "PARTY_NOT_FOUND":
      return 404;
    case "CONCURRENT_SETTLEMENT_PAYMENT":
    case "ALREADY_SETTLED":
      return 409;
    default:
      return 400;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "challan.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const result = finalizeSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { success: false, message: "Invalid settlement data", errors: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const data = result.data;
    const allocations = data.allocations || [];

    // Recording payment allocations is a SUPER_ADMIN-only mutation,
    // exactly like every other SettlementPayment create/edit/delete
    // in this codebase (see /settlement-payments's own hardcoded role
    // check) - never weakened just because it now rides inside the
    // same request as settlement establishment. Establishing the
    // settlement itself with zero allocations remains available to
    // anyone with challan.edit, unchanged from the old POST /settle.
    if (allocations.length > 0 && currentUser.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { success: false, message: "Only a Super Admin can record settlement payments." },
        { status: 403 }
      );
    }

    const challan = await prisma.challan.findUnique({
      where: { id },
      include: {
        transporterParty: { select: { id: true, account: { select: { id: true, isActive: true } } } },
        bilties: {
          include: {
            bilty: {
              include: {
                clearingAgentParty: { select: { id: true, account: { select: { id: true, isActive: true } } } },
                agentParty: { select: { id: true, account: { select: { id: true, isActive: true } } } },
              },
            },
          },
        },
      },
    });

    if (!challan || challan.isDeleted) {
      return NextResponse.json({ success: false, message: "Challan not found" }, { status: 404 });
    }
    if (challan.status !== "DELIVERED") {
      return NextResponse.json({ success: false, message: "Only delivered challans can be settled" }, { status: 400 });
    }
    if (challan.isSettled) {
      return NextResponse.json({ success: false, message: "Challan is already settled" }, { status: 400 });
    }

    const existingJournalEntry = await prisma.journalEntry.findFirst({
      where: { referenceType: "SETTLEMENT", referenceId: challan.id, isDeleted: false },
    });
    if (existingJournalEntry) {
      return NextResponse.json(
        { success: false, message: "This Challan has already been settled." },
        { status: 409 }
      );
    }

    // ------------------------------------------------------------
    // SAFE, DETERMINISTIC DEFAULTS - never a user choice, never a
    // guess: each Bilty's own already-recorded Clearing Agent, the
    // Challan's own already-recorded Transporter, and a Bilty's own
    // already-recorded Booking Agent are the only inputs used. This
    // mirrors defaultBiltySettlement()'s exact logic that the old
    // wizard already used as ITS OWN pre-filled default - the only
    // change is that a human never has to confirm it anymore.
    //
    // Carrier Rent default priority: Transporter first, Clearing
    // Agent only as fallback - Carrier Rent economically belongs to
    // the Transporter (per the Carrier Rent Accounting Diagnostic);
    // a Clearing Agent recorded on a Bilty must not absorb the
    // initial liability merely because it exists.
    // ------------------------------------------------------------

    const transporterAccountId = challan.transporterParty?.account?.isActive
      ? challan.transporterParty.account.id
      : null;

    const anyClearingAgentAccountId =
      challan.bilties.find((cb) => cb.bilty.clearingAgentParty?.account?.isActive)?.bilty.clearingAgentParty?.account
        ?.id || null;

    const carrierRentAmount = Number(challan.carrierRent);
    let carrierRentResponsibility: CarrierRentResponsibility;
    let carrierRentPartyAccountId: string | null = null;
    if (carrierRentAmount > 0) {
      if (transporterAccountId) {
        carrierRentResponsibility = "ANC";
        carrierRentPartyAccountId = transporterAccountId;
      } else if (anyClearingAgentAccountId) {
        carrierRentResponsibility = "CLEARING_AGENT";
        carrierRentPartyAccountId = anyClearingAgentAccountId;
      } else {
        return NextResponse.json(
          {
            success: false,
            message:
              "Unable to finalize settlement: no Clearing Agent or Transporter account is available to hold the Carrier Rent responsibility.",
          },
          { status: 400 }
        );
      }
    } else {
      carrierRentResponsibility = "ANC";
    }

    const resolutionErrors: string[] = [];
    const biltiesInput: BiltySettlementInput[] = challan.bilties.map((cb) => {
      const bilty = cb.bilty;
      const clearingAgentAccountId = bilty.clearingAgentParty?.account?.isActive
        ? bilty.clearingAgentParty.account.id
        : null;
      const amount = Number(bilty.total);
      const commissionAmount = Number(bilty.agentCommission);

      let collectionResponsibility: CollectionResponsibility;
      let collectionPartyAccountId: string | null = null;
      if (amount > 0) {
        if (clearingAgentAccountId) {
          collectionResponsibility = "CLEARING_AGENT";
          collectionPartyAccountId = clearingAgentAccountId;
        } else if (transporterAccountId) {
          collectionResponsibility = "TRANSPORTER";
          collectionPartyAccountId = transporterAccountId;
        } else {
          collectionResponsibility = "TRANSPORTER";
          resolutionErrors.push(
            `Bilty ${bilty.biltyNo} has no Clearing Agent and this Challan has no Transporter account - unable to determine a responsible party for its Collection.`
          );
        }
      } else {
        collectionResponsibility = "TRANSPORTER";
      }

      let commissionResponsibility: CommissionResponsibility | null = null;
      let commissionPartyAccountId: string | null = null;
      if (commissionAmount > 0) {
        if (bilty.agentParty?.account?.isActive) {
          commissionResponsibility = "THIRD_PARTY";
          commissionPartyAccountId = bilty.agentParty.account.id;
        } else if (clearingAgentAccountId) {
          commissionResponsibility = "CLEARING_AGENT";
          commissionPartyAccountId = clearingAgentAccountId;
        } else if (transporterAccountId) {
          commissionResponsibility = "TRANSPORTER";
          commissionPartyAccountId = transporterAccountId;
        } else {
          resolutionErrors.push(
            `Bilty ${bilty.biltyNo} has a commission but no Booking Agent, Clearing Agent, or Transporter account is available to hold it.`
          );
        }
      }

      return {
        biltyId: bilty.id,
        biltyNo: bilty.biltyNo,
        amount: bilty.total,
        collectionResponsibility,
        collectionPartyAccountId,
        agentCommission: bilty.agentCommission,
        commissionResponsibility,
        commissionPartyAccountId,
      };
    });

    if (resolutionErrors.length > 0) {
      return NextResponse.json({ success: false, message: resolutionErrors.join(" ") }, { status: 400 });
    }

    const [grossBiltyReceivableId, grossCarrierRentPayableId, grossCommissionPayableId] = await Promise.all([
      getGrossBiltyReceivableAccountId(prisma),
      getGrossCarrierRentPayableAccountId(prisma),
      getGrossCommissionPayableAccountId(prisma),
    ]);

    // Verified advances (real Daily-Posting-only receipts) - the
    // exact same lookup the old POST /settle used, unchanged.
    const involvedAccountIds = new Set<string>();
    if (carrierRentPartyAccountId) involvedAccountIds.add(carrierRentPartyAccountId);
    for (const b of biltiesInput) {
      if (b.collectionPartyAccountId) involvedAccountIds.add(b.collectionPartyAccountId);
      if (b.commissionPartyAccountId) involvedAccountIds.add(b.commissionPartyAccountId);
    }
    const verifiedAdvanceByAccountId: Record<string, number> = {};
    for (const accountId of involvedAccountIds) {
      const lines = await prisma.journalLine.findMany({
        where: { accountId, journalEntry: { referenceType: "DAILY_POSTING", isDeleted: false } },
        select: { debit: true, credit: true },
      });
      const net = lines.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0);
      verifiedAdvanceByAccountId[accountId] = net > 0 ? net : 0;
    }

    const settlementResult = buildSettlementEntries({
      challanId: challan.id,
      challanNo: challan.challanNo,
      carrierRent: challan.carrierRent,
      carrierRentResponsibility,
      carrierRentPartyAccountId,
      bilties: biltiesInput,
      accounts: { grossBiltyReceivableId, grossCarrierRentPayableId, grossCommissionPayableId },
      verifiedAdvanceByAccountId,
    });

    if (!settlementResult.isValid) {
      return NextResponse.json(
        { success: false, message: settlementResult.errors.map((e) => e.message).join(", ") },
        { status: 400 }
      );
    }

    // Validate allocations reference bilties that actually belong to
    // this Challan before opening the transaction - a cheap, early
    // rejection for an obviously malformed request.
    const challanBiltyIds = new Set(challan.bilties.map((cb) => cb.biltyId));
    for (const a of allocations) {
      if (a.component === "COLLECTION" && (!a.biltyId || !challanBiltyIds.has(a.biltyId))) {
        return NextResponse.json(
          { success: false, message: "Each Collection allocation must reference a Bilty on this Challan." },
          { status: 400 }
        );
      }
      if (a.component === "CARRIER_RENT" && a.biltyId) {
        return NextResponse.json(
          { success: false, message: "Carrier Rent is a Challan-level allocation and must not specify a Bilty." },
          { status: 400 }
        );
      }
    }

    let createdAllocations: { component: string; biltyId: string | null; payerAccountId: string; amount: number }[] = [];

    try {
      const updatedChallan = await prisma.$transaction(
        async (tx) => {
          // Re-check freshness INSIDE the transaction, on the same
          // connection/snapshot the write below will use - the
          // earlier checks (above, before this transaction opened)
          // only protect against an already-settled Challan at the
          // time of that read; they cannot protect against a second,
          // truly concurrent finalize-settlement request racing this
          // one. Under SERIALIZABLE, if both transactions read here
          // before either commits, Postgres aborts one with a
          // serialization failure (caught below as P2034 -> 409); if
          // one has already committed by the time this one reads, this
          // explicit check catches it directly instead of silently
          // creating a second settlement.
          const freshChallan = await tx.challan.findUnique({
            where: { id },
            select: { isSettled: true },
          });
          if (!freshChallan || freshChallan.isSettled) {
            throw new SettlementPaymentError(
              "ALREADY_SETTLED",
              "This Challan was settled by another request just now. Please refresh."
            );
          }
          const existingEntryInTx = await tx.journalEntry.findFirst({
            where: { referenceType: "SETTLEMENT", referenceId: id, isDeleted: false },
            select: { id: true },
          });
          if (existingEntryInTx) {
            throw new SettlementPaymentError(
              "ALREADY_SETTLED",
              "This Challan was settled by another request just now. Please refresh."
            );
          }

          const journalEntries = await Promise.all(
            settlementResult.entries.map((entrySpec) =>
              tx.journalEntry.create({
                data: {
                  entryDate: entrySpec.entryDate,
                  referenceType: entrySpec.referenceType,
                  referenceId: entrySpec.referenceId,
                  description: entrySpec.description,
                  createdById: currentUser.userId,
                  lines: {
                    create: entrySpec.lines.map((line) => ({
                      accountId: line.accountId,
                      debit: line.debit,
                      credit: line.credit,
                      description: line.description,
                      sourceType: line.sourceType,
                      sourceId: line.sourceId,
                      sourceNumber: line.sourceNumber,
                    })),
                  },
                },
              })
            )
          );

          const primaryJournalEntryId = journalEntries[0]?.id || null;

          const settled = await tx.challan.update({
            where: { id },
            data: {
              isSettled: true,
              settledAt: new Date(),
              settledById: currentUser.userId,
              settlementNotes: data.settlementNotes || undefined,
              settlementJournalEntryId: primaryJournalEntryId,
              outstandingReceivable: settlementResult.outstandingReceivable,
              outstandingPayable: settlementResult.outstandingPayable,
              updatedById: currentUser.userId,
            },
            include: {
              transporterParty: { select: { id: true, partyName: true } },
              bilties: {
                include: {
                  bilty: {
                    include: {
                      fromLocation: { select: { id: true, name: true } },
                      toLocation: { select: { id: true, name: true } },
                      consignorParty: { select: { id: true, partyName: true } },
                      consigneeParty: { select: { id: true, partyName: true } },
                      clearingAgentParty: { select: { id: true, partyName: true } },
                      agentParty: { select: { id: true, partyName: true } },
                    },
                  },
                },
                orderBy: { addedAt: "asc" },
              },
            },
          });

          // Reconcile each Bilty's freshly-established OLD single-payer
          // Collection default down to its CURRENT toPay, in the SAME
          // transaction, before any staged allocation runs - closes the
          // lifecycle gap where a Bilty's advance/Paid amount was
          // already raised BEFORE this Challan was ever settled (so
          // the PAID row's own sync correctly no-opped for lack of a
          // settled Challan at that time, and buildSettlementEntries()
          // above has no notion of toPay - only the Bilty's full
          // total). Idempotent and a no-op for a genuinely To-Pay
          // Bilty (see reconcileCollectionAttributionAtSettlement()'s
          // own doc comment) - safe to call unconditionally for every
          // Bilty on every finalize-settlement.
          for (const cb of challan.bilties) {
            await reconcileCollectionAttributionAtSettlement(tx, id, cb.biltyId, currentUser.userId);
          }

          // Same transaction, same tx - if ANY allocation is invalid
          // (over-allocation, bad account, etc.) this throws and the
          // settlement establishment above rolls back too. Never
          // leaves isSettled=true with a rejected allocation.
          for (const a of allocations) {
            const outcome = await createSettlementPayment(
              {
                challanId: id,
                biltyId: a.component === "COLLECTION" ? a.biltyId : undefined,
                component: a.component,
                payerAccountId: a.payerAccountId,
                amount: a.amount,
                createdById: currentUser.userId,
              },
              tx
            );
            createdAllocations.push({
              component: a.component,
              biltyId: a.component === "COLLECTION" ? a.biltyId || null : null,
              payerAccountId: outcome.row.payerAccountId,
              amount: outcome.row.amount,
            });
          }

          return settled;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return NextResponse.json({
        success: true,
        message: "Challan settled successfully",
        challan: updatedChallan,
        accounting: {
          entriesCreated: settlementResult.entries.length,
          totalDebit: settlementResult.totals.totalDebit,
          totalCredit: settlementResult.totals.totalCredit,
          outstandingReceivable: settlementResult.outstandingReceivable,
          outstandingPayable: settlementResult.outstandingPayable,
        },
        allocationsCreated: createdAllocations,
      });
    } catch (txError) {
      if (txError instanceof SettlementPaymentError) {
        return NextResponse.json(
          { success: false, code: txError.code, message: txError.message },
          { status: errorStatus(txError.code) }
        );
      }
      if (txError instanceof Prisma.PrismaClientKnownRequestError && txError.code === "P2034") {
        return NextResponse.json(
          { success: false, message: "This Challan was modified concurrently. Please retry." },
          { status: 409 }
        );
      }
      throw txError;
    }
  } catch (error) {
    console.error("Finalize settlement error:", error);
    return NextResponse.json({ success: false, message: "Unable to finalize settlement" }, { status: 500 });
  }
}

// ============================================================
// PATCH /api/challan/[id]/finalize-settlement
//
// Settlement Notes only - a plain field update, never touches
// accounting. Available once the Challan is already settled (before
// that, notes are set as part of the POST above). Reuses the exact
// same permission floor (challan.edit) as every other non-accounting
// Challan edit.
// ============================================================

const notesSchema = z.object({ settlementNotes: z.string().optional() });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(currentUser, "challan.edit")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const result = notesSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ success: false, message: "Invalid request" }, { status: 400 });
    }

    const challan = await prisma.challan.findUnique({ where: { id }, select: { id: true, isDeleted: true, isSettled: true } });
    if (!challan || challan.isDeleted) {
      return NextResponse.json({ success: false, message: "Challan not found" }, { status: 404 });
    }
    if (!challan.isSettled) {
      return NextResponse.json(
        { success: false, message: "This Challan has not been settled yet." },
        { status: 400 }
      );
    }

    await prisma.challan.update({
      where: { id },
      data: { settlementNotes: result.data.settlementNotes || undefined, updatedById: currentUser.userId },
    });

    return NextResponse.json({ success: true, message: "Settlement notes updated." });
  } catch (error) {
    console.error("Update settlement notes error:", error);
    return NextResponse.json({ success: false, message: "Unable to update settlement notes" }, { status: 500 });
  }
}
