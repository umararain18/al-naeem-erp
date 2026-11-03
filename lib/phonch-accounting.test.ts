import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPhonchEditNotBelowSettled, PhonchValidationError } from "./phonch-accounting";

// "Paid-amount floor instead of full lock" - a Phonch with Daily
// Posting receipts CAN still be edited, as long as the new Total
// Amount never drops below what has already been received. Exact
// production test case: rent 15,000 with 10,000 already received via
// Daily Posting -> 12,000 OK, 10,000 OK, 8,000 blocked, with the
// Daily Posting date named in the message.

function makeFakeTx(receivedAmount: number, latestDate: Date | null) {
  const tx = {
    journalLine: {
      findMany: async () => (receivedAmount > 0 ? [{ debit: 0, credit: receivedAmount }] : []),
      findFirst: async () => (latestDate ? { journalEntry: { entryDate: latestDate } } : null),
    },
  };
  return tx as any;
}

test("edit above the already-received amount is allowed (15,000 -> 12,000, 10,000 paid)", async () => {
  const tx = makeFakeTx(10000, new Date("2026-10-20T00:00:00.000Z"));
  await assertPhonchEditNotBelowSettled(tx, "phonch-1", "transporter-account-1", 15000, 12000);
  // no throw = pass
});

test("edit exactly equal to the already-received amount is allowed (15,000 -> 10,000, 10,000 paid)", async () => {
  const tx = makeFakeTx(10000, new Date("2026-10-20T00:00:00.000Z"));
  await assertPhonchEditNotBelowSettled(tx, "phonch-1", "transporter-account-1", 15000, 10000);
  // no throw = pass
});

test("edit below the already-received amount is blocked with the Daily Posting date (15,000 -> 8,000, 10,000 paid)", async () => {
  const tx = makeFakeTx(10000, new Date("2026-10-20T00:00:00.000Z"));
  await assert.rejects(
    () => assertPhonchEditNotBelowSettled(tx, "phonch-1", "transporter-account-1", 15000, 8000),
    (error: unknown) => {
      assert.ok(error instanceof PhonchValidationError);
      assert.equal(
        (error as PhonchValidationError).message,
        "Is Phonch ki Rs. 10,000 payment pehle ho chuki hai (Daily Posting 20-10-2026) — receivable is se kam nahi ho sakta."
      );
      return true;
    }
  );
});

test("message omits the Daily Posting date if somehow no posting line can be found for it", async () => {
  const tx = makeFakeTx(10000, null);
  await assert.rejects(
    () => assertPhonchEditNotBelowSettled(tx, "phonch-1", "transporter-account-1", 15000, 8000),
    (error: unknown) => {
      assert.ok(error instanceof PhonchValidationError);
      assert.equal(
        (error as PhonchValidationError).message,
        "Is Phonch ki Rs. 10,000 payment pehle ho chuki hai — receivable is se kam nahi ho sakta."
      );
      return true;
    }
  );
});

test("no Transporter account yet (new/unsaved Phonch) never blocks", async () => {
  const tx = makeFakeTx(10000, new Date("2026-10-20T00:00:00.000Z"));
  await assertPhonchEditNotBelowSettled(tx, "phonch-1", null, 15000, 0);
  // no throw = pass
});
