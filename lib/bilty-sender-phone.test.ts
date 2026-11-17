import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBiltySenderPhone } from "./bilty-sender-phone";

test("typed, valid phone wins outright (no party, no checkbox needed)", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "03001234567", partyPhone: null, partyWhatsapp: null, noPhoneProvided: false });
  assert.deepEqual(result, { ok: true, phone: "03001234567", noPhoneProvided: false });
});

test("typed, invalid phone is rejected even when a party with a valid phone is selected", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "garbage", partyPhone: "03009999999", partyWhatsapp: null, noPhoneProvided: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /valid mobile number/);
});

test("typed, invalid phone is rejected even when the checkbox is ticked (garbage is never silently excused)", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "123", partyPhone: null, partyWhatsapp: null, noPhoneProvided: true });
  assert.equal(result.ok, false);
});

test("blank phone + party with a valid phone auto-fills from the party", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "", partyPhone: "0300-1234567", partyWhatsapp: null, noPhoneProvided: false });
  assert.deepEqual(result, { ok: true, phone: "0300-1234567", noPhoneProvided: false });
});

test("blank phone + party has no phone but a valid whatsapp falls back to whatsapp", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "", partyPhone: null, partyWhatsapp: "03211234567", noPhoneProvided: false });
  assert.deepEqual(result, { ok: true, phone: "03211234567", noPhoneProvided: false });
});

test("blank phone + party phone invalid (landline) falls through to whatsapp", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "", partyPhone: "042-35123456", partyWhatsapp: "03211234567", noPhoneProvided: false });
  assert.deepEqual(result, { ok: true, phone: "03211234567", noPhoneProvided: false });
});

test("blank phone, no party, checkbox ticked - walk-in with no number allowed", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "", partyPhone: null, partyWhatsapp: null, noPhoneProvided: true });
  assert.deepEqual(result, { ok: true, phone: null, noPhoneProvided: true });
});

test("blank phone, party selected but neither phone nor whatsapp valid, checkbox ticked - falls back to walk-in rule", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "", partyPhone: null, partyWhatsapp: null, noPhoneProvided: true });
  assert.deepEqual(result, { ok: true, phone: null, noPhoneProvided: true });
});

test("blank phone, no party, checkbox NOT ticked - rejected as required", () => {
  const result = resolveBiltySenderPhone({ typedPhone: "", partyPhone: null, partyWhatsapp: null, noPhoneProvided: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /required/);
});
