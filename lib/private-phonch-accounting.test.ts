import { test } from "node:test";
import assert from "node:assert/strict";
import { syncPrivatePhonchVehicleAmountsFromBill, PrivatePhonchValidationError } from "./private-phonch-accounting";
import { parseISODateStart } from "./date-range";

// ------------------------------------------------------------
// syncPrivatePhonchVehicleAmountsFromBill() - called from
// app/api/bill/[id]/route.ts's PATCH handler ONLY when the user
// explicitly ticks the opt-in "Same amount Private Phonch mein bhi
// lagayein" checkbox (unchecked by default - a Bill edit never
// touches the Private Phonch on its own; Bill Rent and Private
// Phonch Rent are independent documents). Exact production scenario:
// Private Phonch 6996 (18-10-2026, Transporter Haji Cargo, vehicle
// Suzuki APV chassis 103022), Clearing Agent Mardan Cargo Tarnol
// already paid Rs. 17,500 via Daily Posting. Rent 20,000 -> 18,000
// (Delivery Charges 500, Carrier Payable 0) so CA Payable recomputes
// to 18,000 - 500 - 0 = 17,500, exactly matching what's already paid.
// ------------------------------------------------------------

const PHONCH_ID = "phonch-6996";
const TRANSPORTER_ACCOUNT_ID = "acct-haji-cargo";
const CA_PARTY_ID = "party-mardan-cargo-tarnol";
const CA_ACCOUNT_ID = "acct-mardan-cargo-tarnol";
// Stored exactly like every other business-date field in this ERP -
// LOCAL (Asia/Karachi) midnight expressed in UTC, via
// parseISODateStart (see lib/date-range.ts's own doc comment) -
// never a plain "...T00:00:00.000Z" literal, which would silently be
// one local day off on round-trip through toBusinessDateInputValue/
// resolvePrivatePhonchInput.
const PHONCH_DATE = parseISODateStart("2026-10-18");
const DAILY_POSTING_DATE = new Date("2026-10-25T00:00:00.000Z");

function makeFakeTx(opts: {
  caAlreadyPaid: number;
  transporterAlreadyPaid?: number;
}) {
  const journalEntriesCreated: any[] = [];
  const journalEntryUpdateManyCalls: any[] = [];
  const vehicleUpdateCalls: any[] = [];

  const dailyPostingByAccount: Record<string, { debit: number; credit: number }> = {
    [CA_ACCOUNT_ID]: { debit: opts.caAlreadyPaid, credit: 0 },
    [TRANSPORTER_ACCOUNT_ID]: { debit: opts.transporterAlreadyPaid ?? 0, credit: 0 },
  };

  const tx = {
    privatePhonch: {
      findFirst: async () => ({
        id: PHONCH_ID,
        phonchNo: "6996",
        date: PHONCH_DATE,
        isDeleted: false,
        transporterPartyId: "party-haji-cargo",
        transporterParty: { partyName: "Haji Cargo", isActive: true, account: { id: TRANSPORTER_ACCOUNT_ID, isActive: true } },
        vehicles: [
          {
            id: "vehicle-1",
            lineNo: 1,
            biltyNo: null,
            challanNo: null,
            chassisNumber: "103022",
            engineNumber: null,
            vehicleName: "Suzuki APV",
            clearingAgentPartyId: CA_PARTY_ID,
            totalRent: 20000,
            deliveryCharges: 500,
            carrierPayable: 0,
            deliveryRecoveryParty: null,
            note: null,
          },
        ],
      }),
    },
    party: {
      findMany: async () => [{ id: CA_PARTY_ID, partyName: "Mardan Cargo Tarnol", isActive: true, account: { id: CA_ACCOUNT_ID, isActive: true } }],
    },
    privatePhonchVehicle: {
      update: async (args: any) => {
        vehicleUpdateCalls.push(args);
        return {};
      },
    },
    account: {
      findFirst: async () => ({ id: "system-account-1" }),
    },
    journalEntry: {
      updateMany: async (args: any) => {
        journalEntryUpdateManyCalls.push(args);
        return { count: 1 };
      },
      create: async (args: any) => {
        journalEntriesCreated.push(args.data);
        return { id: `je-${journalEntriesCreated.length}`, ...args.data };
      },
    },
    journalLine: {
      findMany: async (args: any) => {
        if (args.select?.debit !== undefined) {
          const entry = dailyPostingByAccount[args.where.accountId as string];
          return entry ? [{ debit: entry.debit, credit: entry.credit }] : [];
        }
        // historicalPayeeAccounts - every distinct Daily-Posting-paid
        // account other than the Transporter's own.
        return [{ accountId: CA_ACCOUNT_ID, account: { party: { partyName: "Mardan Cargo Tarnol" } } }];
      },
      findFirst: async (args: any) => {
        const accountId = args.where.accountId as string;
        if (!dailyPostingByAccount[accountId] || dailyPostingByAccount[accountId].debit <= 0) return null;
        return { journalEntry: { entryDate: DAILY_POSTING_DATE } };
      },
    },
  };
  return { tx: tx as any, journalEntriesCreated, journalEntryUpdateManyCalls, vehicleUpdateCalls };
}

test("syncs rent 20,000 -> 18,000: CA Payable recomputes to exactly the already-paid 17,500, remaining 0", async () => {
  const { tx, journalEntriesCreated, journalEntryUpdateManyCalls, vehicleUpdateCalls } = makeFakeTx({ caAlreadyPaid: 17500 });

  const result = await syncPrivatePhonchVehicleAmountsFromBill(tx, {
    phonchVehicleId: "vehicle-1",
    newTotalRent: 18000,
    newDeliveryCharges: 500,
    userId: "user-1",
  });

  assert.deepEqual(result, { phonchId: PHONCH_ID, phonchNo: "6996", lineNo: 1 });

  assert.equal(vehicleUpdateCalls.length, 1);
  assert.equal(vehicleUpdateCalls[0].data.totalRent, 18000);
  assert.equal(vehicleUpdateCalls[0].data.deliveryCharges, 500);

  assert.equal(journalEntryUpdateManyCalls.length, 1);
  assert.equal(journalEntryUpdateManyCalls[0].where.referenceType, "PRIVATE_PHONCH");
  assert.equal(journalEntryUpdateManyCalls[0].where.referenceId, PHONCH_ID);

  assert.equal(journalEntriesCreated.length, 1);
  const posted = journalEntriesCreated[0];
  // Dated the Private Phonch's OWN date - never the Bill's, never today.
  assert.equal(posted.entryDate.getTime(), PHONCH_DATE.getTime());
  assert.equal(posted.referenceType, "PRIVATE_PHONCH");

  const lines = posted.lines.create as { accountId: string; debit: number; credit: number }[];
  const caLine = lines.find((l) => l.accountId === CA_ACCOUNT_ID);
  assert.ok(caLine, "expected a Clearing Agent Payable line");
  assert.equal(caLine!.credit, 17500);
  assert.equal(caLine!.debit, 0);

  // Carrier Payable to the Transporter is 0 (carrierPayable field is
  // 0 for this vehicle) - no line posted to the Transporter's account.
  assert.ok(!lines.some((l) => l.accountId === TRANSPORTER_ACCOUNT_ID));

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(totalDebit, totalCredit);
  assert.equal(totalDebit, 18000);
});

test("blocks the sync when the new CA Payable would drop below what's already paid, naming the Daily Posting date", async () => {
  const { tx } = makeFakeTx({ caAlreadyPaid: 17500 });

  await assert.rejects(
    () =>
      syncPrivatePhonchVehicleAmountsFromBill(tx, {
        phonchVehicleId: "vehicle-1",
        newTotalRent: 17000, // netRent 16500 - 0 carrierPayable = CA Payable 16500 < 17,500 already paid
        newDeliveryCharges: 500,
        userId: "user-1",
      }),
    (error: unknown) => {
      assert.ok(error instanceof PrivatePhonchValidationError);
      assert.equal(
        (error as PrivatePhonchValidationError).message,
        "Is Private Phonch ki Rs. 17,500 payment pehle ho chuki hai (Daily Posting 25-10-2026) — CA Payable is se kam nahi ho sakta."
      );
      return true;
    }
  );
});

test("Daily Posting payments are left completely untouched by the sync (never writes to journalLine/DAILY_POSTING)", async () => {
  const { tx } = makeFakeTx({ caAlreadyPaid: 17500 });
  // The fake tx exposes no mutating DAILY_POSTING-shaped call at all -
  // only journalEntry.updateMany/create (both scoped to referenceType
  // "PRIVATE_PHONCH") and privatePhonchVehicle.update are writable, so
  // simply completing without error already proves no other write
  // path was exercised.
  await syncPrivatePhonchVehicleAmountsFromBill(tx, {
    phonchVehicleId: "vehicle-1",
    newTotalRent: 18000,
    newDeliveryCharges: 500,
    userId: "user-1",
  });
});
