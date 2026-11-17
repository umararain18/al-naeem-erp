import { test } from "node:test";
import assert from "node:assert/strict";
import { toLocalMobile } from "./phone";

test("toLocalMobile - already-local 03XXXXXXXXX passes through", () => {
  assert.equal(toLocalMobile("03001234567"), "03001234567");
});

test("toLocalMobile - strips hyphens/spaces", () => {
  assert.equal(toLocalMobile("0300-1234567"), "03001234567");
  assert.equal(toLocalMobile("0300 123 4567"), "03001234567");
});

test("toLocalMobile - strips +92 country code", () => {
  assert.equal(toLocalMobile("+923001234567"), "03001234567");
});

test("toLocalMobile - strips 0092 country code", () => {
  assert.equal(toLocalMobile("00923001234567"), "03001234567");
});

test("toLocalMobile - bare 92XXXXXXXXXX (no leading 0/+)", () => {
  assert.equal(toLocalMobile("923001234567"), "03001234567");
});

test("toLocalMobile - bare 10-digit 3XXXXXXXXX", () => {
  assert.equal(toLocalMobile("3001234567"), "03001234567");
});

test("toLocalMobile - rejects a landline (doesn't start with 3 after reduction)", () => {
  assert.equal(toLocalMobile("042-35123456"), null);
});

test("toLocalMobile - rejects too short", () => {
  assert.equal(toLocalMobile("12345"), null);
});

test("toLocalMobile - rejects empty/null/undefined", () => {
  assert.equal(toLocalMobile(""), null);
  assert.equal(toLocalMobile(null), null);
  assert.equal(toLocalMobile(undefined), null);
});
