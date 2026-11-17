import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateContactFromDocuments, type BiltyDocForContact, type BillDocForContact, type MatchedPartyForContact } from "./contact-refresh";

function bilty(overrides: Partial<BiltyDocForContact>): BiltyDocForContact {
  return {
    date: new Date("2026-01-01"),
    roles: ["SENDER"],
    name: "Ali Traders",
    total: 10000,
    vehicle: "LEA-1234",
    city: "Karachi",
    route: "Karachi -> Lahore",
    ...overrides,
  };
}

test("no documents and no Party match - sourceless, empty", () => {
  const result = aggregateContactFromDocuments({ bilties: [], bills: [], matchedParty: null, partyOnlyFallbackDate: null });
  assert.equal(result.sourceless, true);
  assert.equal(result.name, "");
  assert.deepEqual(result.roles, []);
});

test("dedupe - two spellings of the same phone's documents already unioned by caller collapse into one aggregate", () => {
  // The caller (refreshMarketingContacts) is responsible for unioning a
  // merge-group's documents before calling this - here we simulate that
  // by just passing both bilties in directly, confirming the aggregate
  // treats them as one combined picture (one `name`, one `biltyCount`).
  const result = aggregateContactFromDocuments({
    bilties: [bilty({ date: new Date("2026-01-01"), name: "Ali" }), bilty({ date: new Date("2026-02-01"), name: "Ali Traders" })],
    bills: [],
    matchedParty: null,
    partyOnlyFallbackDate: null,
  });
  assert.equal(result.biltyCount, 2);
  assert.equal(result.name, "Ali Traders"); // latest-dated name wins
  assert.deepEqual(result.aliases, ["Ali"]);
});

test("role SENDER only", () => {
  const result = aggregateContactFromDocuments({ bilties: [bilty({ roles: ["SENDER"] })], bills: [], matchedParty: null, partyOnlyFallbackDate: null });
  assert.deepEqual(result.roles, ["SENDER"]);
});

test("role BOTH on the same Bilty (same phone used as consignor and consignee) stays one document", () => {
  const result = aggregateContactFromDocuments({ bilties: [bilty({ roles: ["SENDER", "RECEIVER"] })], bills: [], matchedParty: null, partyOnlyFallbackDate: null });
  assert.deepEqual(result.roles.sort(), ["RECEIVER", "SENDER"]);
  assert.equal(result.biltyCount, 1);
});

test("Bill-only contact gets BILL_CLIENT role and revenue", () => {
  const bill: BillDocForContact = { date: new Date("2026-03-01"), name: "Hamid Co", total: 5000 };
  const result = aggregateContactFromDocuments({ bilties: [], bills: [bill], matchedParty: null, partyOnlyFallbackDate: null });
  assert.deepEqual(result.roles, ["BILL_CLIENT"]);
  assert.equal(result.revenue, 5000);
  assert.equal(result.name, "Hamid Co");
});

test("revenue sums Bilty + Bill totals, each document once", () => {
  const result = aggregateContactFromDocuments({
    bilties: [bilty({ total: 10000 })],
    bills: [{ date: new Date("2026-02-01"), name: "Ali Traders", total: 3000 }],
    matchedParty: null,
    partyOnlyFallbackDate: null,
  });
  assert.equal(result.revenue, 13000);
});

test("city/route/lastVehicle come from the latest BILTY, not a later Bill (Bills carry none)", () => {
  const result = aggregateContactFromDocuments({
    bilties: [bilty({ date: new Date("2026-01-01"), city: "Karachi", route: "Karachi -> Lahore", vehicle: "LEA-1234" })],
    bills: [{ date: new Date("2026-06-01"), name: "Ali Traders", total: 1000 }],
    matchedParty: null,
    partyOnlyFallbackDate: null,
  });
  assert.equal(result.city, "Karachi");
  assert.equal(result.route, "Karachi -> Lahore");
  assert.equal(result.lastVehicle, "LEA-1234");
  assert.equal(result.lastDate.toISOString().slice(0, 10), "2026-06-01"); // lastDate still reflects the Bill being the most recent event
});

test("broker tag - more than 5 distinct names (6) triggers MANY_NAMES", () => {
  const names = ["A", "B", "C", "D", "E", "F"];
  const result = aggregateContactFromDocuments({
    bilties: names.map((n, i) => bilty({ name: n, date: new Date(2026, 0, i + 1) })),
    bills: [],
    matchedParty: null,
    partyOnlyFallbackDate: null,
  });
  assert.equal(result.isBroker, true);
  assert.equal(result.brokerReason, "MANY_NAMES");
});

test("broker tag - exactly 5 distinct names does NOT trigger", () => {
  const names = ["A", "B", "C", "D", "E"];
  const result = aggregateContactFromDocuments({
    bilties: names.map((n, i) => bilty({ name: n, date: new Date(2026, 0, i + 1) })),
    bills: [],
    matchedParty: null,
    partyOnlyFallbackDate: null,
  });
  assert.equal(result.isBroker, false);
  assert.equal(result.brokerReason, null);
});

test("broker tag - CLEARING_AGENT party match wins even with few names", () => {
  const matchedParty: MatchedPartyForContact = { id: "p1", partyName: "ABC Clearing", isBusinessRoleParty: true, isClearingAgent: true };
  const result = aggregateContactFromDocuments({ bilties: [bilty({})], bills: [], matchedParty, partyOnlyFallbackDate: null });
  assert.equal(result.isBroker, true);
  assert.equal(result.brokerReason, "CLEARING_AGENT_MATCH");
  assert.equal(result.linkedPartyId, "p1");
  assert.ok(result.roles.includes("PARTY"));
});

test("Party-only contact (no Bilty/Bill) uses the Party's own name and createdAt fallback date", () => {
  const matchedParty: MatchedPartyForContact = { id: "p2", partyName: "Fast Transport", isBusinessRoleParty: true, isClearingAgent: false };
  const fallbackDate = new Date("2024-05-01");
  const result = aggregateContactFromDocuments({ bilties: [], bills: [], matchedParty, partyOnlyFallbackDate: fallbackDate });
  assert.equal(result.name, "Fast Transport");
  assert.equal(result.sourceless, false);
  assert.ok(result.roles.includes("PARTY"));
  assert.equal(result.firstDate.getTime(), fallbackDate.getTime());
  assert.equal(result.lastDate.getTime(), fallbackDate.getTime());
});

test("a plain CUSTOMER-type Party match does not add the PARTY role", () => {
  const matchedParty: MatchedPartyForContact = { id: "p3", partyName: "Regular Customer", isBusinessRoleParty: false, isClearingAgent: false };
  const result = aggregateContactFromDocuments({ bilties: [bilty({})], bills: [], matchedParty, partyOnlyFallbackDate: null });
  assert.equal(result.roles.includes("PARTY" as never), false);
  assert.equal(result.linkedPartyId, "p3"); // still linked, just no role tag
});
