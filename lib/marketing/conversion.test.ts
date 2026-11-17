import { test } from "node:test";
import assert from "node:assert/strict";
import { findConvertibleRecipient, type RecipientForConversion } from "./conversion";

const NOW = new Date("2026-06-30");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function recipient(overrides: Partial<RecipientForConversion> & { id: string }): RecipientForConversion {
  return { status: "SENT", sentAt: daysAgo(1), leadId: null, ...overrides };
}

test("within-window pick - 29 days ago qualifies (window 30)", () => {
  const r = recipient({ id: "r1", sentAt: daysAgo(29) });
  assert.equal(findConvertibleRecipient([r], NOW, 30)?.id, "r1");
});

test("outside-window - 31 days ago does not qualify (window 30)", () => {
  const r = recipient({ id: "r1", sentAt: daysAgo(31) });
  assert.equal(findConvertibleRecipient([r], NOW, 30), null);
});

test("exactly at the window boundary (30 days, window 30) qualifies", () => {
  const r = recipient({ id: "r1", sentAt: daysAgo(30) });
  assert.equal(findConvertibleRecipient([r], NOW, 30)?.id, "r1");
});

test("picks the most recent SENT recipient across multiple campaigns", () => {
  const older = recipient({ id: "older", sentAt: daysAgo(20) });
  const newer = recipient({ id: "newer", sentAt: daysAgo(5) });
  assert.equal(findConvertibleRecipient([older, newer], NOW, 30)?.id, "newer");
});

test("ignores non-SENT statuses entirely", () => {
  const queued = recipient({ id: "q", status: "QUEUED", sentAt: null });
  const replied = recipient({ id: "r", status: "REPLIED", sentAt: daysAgo(1) });
  assert.equal(findConvertibleRecipient([queued, replied], NOW, 30), null);
});

test("no recipients at all returns null", () => {
  assert.equal(findConvertibleRecipient([], NOW, 30), null);
});
