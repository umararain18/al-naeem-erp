import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyActivitySegments, computeVipContactIds, isExcludedByDefault, matchesSavedSegmentFilter, type ContactForSegments, type ContactForSavedFilter, type MarketingSettingsLike } from "./segments";

const SETTINGS: MarketingSettingsLike = { activeDays: 30, sleepingMinDays: 60, sleepingMaxDays: 180, lostDays: 180, vipPercentile: 20 };
const NOW = new Date("2026-06-30");

function contact(overrides: Partial<ContactForSegments> & { lastDate: Date }): ContactForSegments {
  return {
    id: "c1",
    roles: [],
    firstDate: overrides.lastDate,
    biltyCount: 2,
    revenue: 1000,
    isBroker: false,
    optedOut: false,
    sourceless: false,
    ...overrides,
  };
}

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

test("Active boundary - exactly activeDays (30) is Active, 31 is not", () => {
  assert.ok(classifyActivitySegments(contact({ lastDate: daysAgo(30) }), SETTINGS, NOW).includes("ACTIVE"));
  assert.ok(!classifyActivitySegments(contact({ lastDate: daysAgo(31) }), SETTINGS, NOW).includes("ACTIVE"));
});

test("Sleeping boundary - 59 is not Sleeping, 60 is, 180 is, 181 is not", () => {
  assert.ok(!classifyActivitySegments(contact({ lastDate: daysAgo(59) }), SETTINGS, NOW).includes("SLEEPING"));
  assert.ok(classifyActivitySegments(contact({ lastDate: daysAgo(60) }), SETTINGS, NOW).includes("SLEEPING"));
  assert.ok(classifyActivitySegments(contact({ lastDate: daysAgo(180) }), SETTINGS, NOW).includes("SLEEPING"));
  assert.ok(!classifyActivitySegments(contact({ lastDate: daysAgo(181) }), SETTINGS, NOW).includes("SLEEPING"));
});

test("Lost boundary - 180 is not Lost (it's Sleeping), 181 is Lost", () => {
  assert.ok(!classifyActivitySegments(contact({ lastDate: daysAgo(180) }), SETTINGS, NOW).includes("LOST"));
  assert.ok(classifyActivitySegments(contact({ lastDate: daysAgo(181) }), SETTINGS, NOW).includes("LOST"));
});

test("One-time - exactly 1 Bilty ever, independent of Active/Sleeping/Lost", () => {
  const segs = classifyActivitySegments(contact({ lastDate: daysAgo(5), biltyCount: 1 }), SETTINGS, NOW);
  assert.ok(segs.includes("ACTIVE"));
  assert.ok(segs.includes("ONE_TIME"));
  assert.ok(!classifyActivitySegments(contact({ lastDate: daysAgo(5), biltyCount: 2 }), SETTINGS, NOW).includes("ONE_TIME"));
});

test("VIP - top 20% by revenue among eligible contacts", () => {
  const contacts: ContactForSegments[] = [1, 2, 3, 4, 5].map((n) =>
    contact({ id: `c${n}`, lastDate: daysAgo(1), revenue: n * 1000 })
  );
  const vipIds = computeVipContactIds(contacts, 20);
  assert.deepEqual([...vipIds], ["c5"]); // top 20% of 5 = 1 contact, the highest revenue
});

test("VIP - zero-revenue contacts never qualify", () => {
  const contacts: ContactForSegments[] = [contact({ id: "c1", lastDate: daysAgo(1), revenue: 0 })];
  assert.equal(computeVipContactIds(contacts, 20).size, 0);
});

test("isExcludedByDefault - Broker and Party roles excluded, opted-out and sourceless excluded", () => {
  assert.equal(isExcludedByDefault(contact({ lastDate: daysAgo(1), isBroker: true })), true);
  assert.equal(isExcludedByDefault(contact({ lastDate: daysAgo(1), roles: ["PARTY"] })), true);
  assert.equal(isExcludedByDefault(contact({ lastDate: daysAgo(1), optedOut: true })), true);
  assert.equal(isExcludedByDefault(contact({ lastDate: daysAgo(1), sourceless: true })), true);
  assert.equal(isExcludedByDefault(contact({ lastDate: daysAgo(1), roles: ["SENDER"] })), false);
});

test("matchesSavedSegmentFilter - opted-out/sourceless always excluded even from a permissive filter", () => {
  const base: ContactForSavedFilter = { ...contact({ lastDate: daysAgo(1) }), city: "Karachi", route: null };
  assert.equal(matchesSavedSegmentFilter({ ...base, optedOut: true }, { includeBrokers: true, includeParty: true }, NOW), false);
  assert.equal(matchesSavedSegmentFilter({ ...base, sourceless: true }, { includeBrokers: true, includeParty: true }, NOW), false);
});

test("matchesSavedSegmentFilter - city, route, minRevenue, lastActivityWithinDays combined", () => {
  const base: ContactForSavedFilter = { ...contact({ lastDate: daysAgo(10), revenue: 5000 }), city: "Karachi", route: "Karachi -> Lahore" };
  assert.equal(matchesSavedSegmentFilter(base, { city: "Karachi" }, NOW), true);
  assert.equal(matchesSavedSegmentFilter(base, { city: "Lahore" }, NOW), false);
  assert.equal(matchesSavedSegmentFilter(base, { route: "Karachi -> Lahore" }, NOW), true);
  assert.equal(matchesSavedSegmentFilter(base, { route: "Lahore -> Karachi" }, NOW), false);
  assert.equal(matchesSavedSegmentFilter(base, { minRevenue: 4000 }, NOW), true);
  assert.equal(matchesSavedSegmentFilter(base, { minRevenue: 6000 }, NOW), false);
  assert.equal(matchesSavedSegmentFilter(base, { lastActivityWithinDays: 10 }, NOW), true);
  assert.equal(matchesSavedSegmentFilter(base, { lastActivityWithinDays: 9 }, NOW), false);
});

test("matchesSavedSegmentFilter - roles any-of", () => {
  const base: ContactForSavedFilter = { ...contact({ lastDate: daysAgo(1), roles: ["RECEIVER"] }), city: null, route: null };
  assert.equal(matchesSavedSegmentFilter(base, { roles: ["SENDER", "RECEIVER"] }, NOW), true);
  assert.equal(matchesSavedSegmentFilter(base, { roles: ["SENDER"] }, NOW), false);
});

test("matchesSavedSegmentFilter - Broker/Party excluded unless the filter explicitly includes them", () => {
  const brokerContact: ContactForSavedFilter = { ...contact({ lastDate: daysAgo(1), isBroker: true }), city: null, route: null };
  assert.equal(matchesSavedSegmentFilter(brokerContact, {}, NOW), false);
  assert.equal(matchesSavedSegmentFilter(brokerContact, { includeBrokers: true }, NOW), true);

  const partyContact: ContactForSavedFilter = { ...contact({ lastDate: daysAgo(1), roles: ["PARTY"] }), city: null, route: null };
  assert.equal(matchesSavedSegmentFilter(partyContact, {}, NOW), false);
  assert.equal(matchesSavedSegmentFilter(partyContact, { includeParty: true }, NOW), true);
});
