import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, buildWaLink, type TemplateContact } from "./campaign";

const CONTACT: TemplateContact = {
  name: "Ali Traders",
  city: "Karachi",
  lastVehicle: "LEA-1234",
  lastDate: new Date("2026-03-15"),
  roles: ["SENDER", "RECEIVER"],
  route: "Karachi -> Lahore",
};

test("renderTemplate - all 6 placeholders", () => {
  const out = renderTemplate("Hi {name} from {city}, vehicle {vehicle}, last on {lastDate}, you are our {role} on {direction}.", CONTACT);
  assert.equal(out, "Hi Ali Traders from Karachi, vehicle LEA-1234, last on 15 Mar 2026, you are our Sender/Receiver on Karachi -> Lahore.");
});

test("renderTemplate - a recognized placeholder with no data renders empty, not the literal token", () => {
  const out = renderTemplate("Hi {name}, city: {city}", { ...CONTACT, city: null });
  assert.equal(out, "Hi Ali Traders, city: ");
});

test("renderTemplate - an unrecognized token is left untouched", () => {
  const out = renderTemplate("Hi {name}, code {unknown}", CONTACT);
  assert.equal(out, "Hi Ali Traders, code {unknown}");
});

test("renderTemplate - role label for Sender-only vs Receiver-only vs Bill client vs Party", () => {
  assert.equal(renderTemplate("{role}", { ...CONTACT, roles: ["SENDER"] }), "Sender");
  assert.equal(renderTemplate("{role}", { ...CONTACT, roles: ["RECEIVER"] }), "Receiver");
  assert.equal(renderTemplate("{role}", { ...CONTACT, roles: ["BILL_CLIENT"] }), "Client");
  assert.equal(renderTemplate("{role}", { ...CONTACT, roles: ["PARTY"] }), "Transporter/Agent");
});

test("buildWaLink - 03XXXXXXXXX becomes a 92-prefixed wa.me link with URL-encoded text", () => {
  const link = buildWaLink("03001234567", "Hello there!");
  assert.equal(link, "https://wa.me/923001234567?text=Hello%20there!");
});
