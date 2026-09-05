import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";

export type ChallanFinancialStatus =
  | "OPEN"
  | "PARTIALLY_CLEARED"
  | "CLEARED"
  | "OVERPAID";

export interface ChallanFinancials {
  challanId: string;
  receivable: number;
  payable: number;
  received: number;
  paid: number;
  remainingReceivable: number;
  remainingPayable: number;
  excessReceived: number;
  excessPaid: number;
  isCleared: boolean;
  status: ChallanFinancialStatus;
}

export interface ChallanFinancialInput {
  id: string;
  outstandingReceivable: number | string | Decimal;
  outstandingPayable: number | string | Decimal;
  biltyIds: string[];
}

function toNum(value: number | string | Decimal): number {
  if (typeof value === "number") return value;
  if (value instanceof Decimal) return value.toNumber();
  return new Decimal(value).toNumber();
}

/**
 * Pure read-side calculation of a Challan's financial position.
 *
 * Source of truth:
 *  - Original dues = Challan.outstandingReceivable / outstandingPayable
 *    (established by Final Settlement).
 *  - Actual receipts/payments = DAILY_POSTING JournalLines tagged to this
 *    Challan (sourceType CHALLAN + sourceId = challanId) or to one of its
 *    Bilties (sourceType BILTY + sourceId = biltyId).
 *
 * Only the PARTY-side line of each matched entry is summed:
 *  - Party CREDIT  = amount actually received (reduces receivable)
 *  - Party DEBIT   = amount actually paid    (reduces payable)
 * Cash/Bank lines are ignored for amounts (they are the other side).
 *
 * Each matched JournalEntry is counted exactly once via its owner Challan,
 * so a Bilty-linked posting (party line BILTY + cash line CHALLAN) is not
 * double-counted.
 */
export async function computeChallanFinancialsBatch(
  inputs: ChallanFinancialInput[]
): Promise<Record<string, ChallanFinancials>> {
  const receivedMap = new Map<string, Decimal>();
  const paidMap = new Map<string, Decimal>();

  for (const inp of inputs) {
    receivedMap.set(inp.id, new Decimal(0));
    paidMap.set(inp.id, new Decimal(0));
  }

  if (inputs.length > 0) {
    const challanIds = inputs.map((i) => i.id);
    const biltyToChallan = new Map<string, string>();

    for (const inp of inputs) {
      for (const b of inp.biltyIds) biltyToChallan.set(b, inp.id);
    }

    const biltyIdList = [...biltyToChallan.keys()];

    const entries = await prisma.journalEntry.findMany({
      where: {
        referenceType: "DAILY_POSTING",
        isDeleted: false,
        lines: {
          some: {
            OR: [
              { sourceType: "CHALLAN", sourceId: { in: challanIds } },
              ...(biltyIdList.length > 0
                ? [{ sourceType: "BILTY", sourceId: { in: biltyIdList } }]
                : []),
            ],
          },
        },
      },
      include: {
        lines: {
          include: {
            account: { select: { category: true } },
          },
        },
      },
    });

    for (const entry of entries) {
      // Resolve which Challan this entry belongs to (once per entry).
      let owner: string | null = null;

      for (const line of entry.lines) {
        const sid = line.sourceId;
        if (!sid) continue;
        if (line.sourceType === "CHALLAN" && challanIds.includes(sid)) {
          owner = sid;
          break;
        }
        if (line.sourceType === "BILTY" && biltyToChallan.has(sid)) {
          owner = biltyToChallan.get(sid) as string;
          break;
        }
      }

      if (!owner) continue;

      // Sum only the PARTY-side line of this entry.
      for (const line of entry.lines) {
        if (line.account?.category === "PARTY") {
          receivedMap.set(
            owner,
            receivedMap.get(owner)!.plus(new Decimal(line.credit))
          );
          paidMap.set(
            owner,
            paidMap.get(owner)!.plus(new Decimal(line.debit))
          );
        }
      }
    }
  }

  const result: Record<string, ChallanFinancials> = {};

  for (const inp of inputs) {
    const receivable = toNum(inp.outstandingReceivable);
    const payable = toNum(inp.outstandingPayable);
    const received = (receivedMap.get(inp.id) || new Decimal(0)).toNumber();
    const paid = (paidMap.get(inp.id) || new Decimal(0)).toNumber();

    const remainingReceivable = Math.max(0, receivable - received);
    const remainingPayable = Math.max(0, payable - paid);
    const excessReceived = Math.max(0, received - receivable);
    const excessPaid = Math.max(0, paid - payable);
    const isCleared = remainingReceivable === 0 && remainingPayable === 0;

    let status: ChallanFinancialStatus = "OPEN";
    if (excessReceived > 0 || excessPaid > 0) {
      status = "OVERPAID";
    } else if (isCleared) {
      status = "CLEARED";
    } else if (received > 0 || paid > 0) {
      status = "PARTIALLY_CLEARED";
    }

    result[inp.id] = {
      challanId: inp.id,
      receivable,
      payable,
      received,
      paid,
      remainingReceivable,
      remainingPayable,
      excessReceived,
      excessPaid,
      isCleared,
      status,
    };
  }

  return result;
}

export async function computeChallanFinancials(
  challanId: string
): Promise<ChallanFinancials | null> {
  const challan = await prisma.challan.findUnique({
    where: { id: challanId },
    select: {
      id: true,
      outstandingReceivable: true,
      outstandingPayable: true,
      bilties: { select: { biltyId: true } },
    },
  });

  if (!challan) return null;

  const batch = await computeChallanFinancialsBatch([
    {
      id: challan.id,
      outstandingReceivable: challan.outstandingReceivable,
      outstandingPayable: challan.outstandingPayable,
      biltyIds: challan.bilties.map((b) => b.biltyId),
    },
  ]);

  return batch[challan.id] || null;
}
