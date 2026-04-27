import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  assertEnum,
  assertObject,
  assertString,
  isSafeExternalUrl
} from "../electron/security.js";

test("isSafeExternalUrl allows known Anthropic and GitHub hosts", () => {
  assert.equal(isSafeExternalUrl("https://api.anthropic.com/v1/messages"), true);
  assert.equal(isSafeExternalUrl("https://github.com/Twinded/claude-messenger"), true);
  assert.equal(isSafeExternalUrl("https://docs.anthropic.com/claude"), true);
});

test("isSafeExternalUrl rejects arbitrary external HTTPS hosts", () => {
  assert.equal(isSafeExternalUrl("https://evil.example.com/exfil"), false);
});

test("isSafeExternalUrl rejects non-http/https/mailto protocols", () => {
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("data:text/html,<script>"), false);
});

test("isSafeExternalUrl rejects all plain http:// links", () => {
  // The Vite dev server URL is forwarded through a separate env var, not
  // through this allowlist, so even http://localhost is intentionally
  // rejected to prevent cross-origin SSRF via assistant-rendered links.
  assert.equal(isSafeExternalUrl("http://127.0.0.1:5174"), false);
  assert.equal(isSafeExternalUrl("http://localhost:5174"), false);
  assert.equal(isSafeExternalUrl("http://example.com"), false);
});

test("assertString enforces required and maxLength", () => {
  assert.equal(assertString("hello", "field"), "hello");
  assert.equal(assertString("", "field", { required: false }), "");
  assert.throws(() => assertString("", "field"));
  assert.throws(() => assertString("a".repeat(3000), "field", { maxLength: 100 }));
  assert.throws(() => assertString(42 as unknown, "field"));
});

test("assertObject rejects arrays and primitives", () => {
  const obj = assertObject({ a: 1 }, "field");
  assert.deepEqual(obj, { a: 1 });
  assert.throws(() => assertObject([], "field"));
  assert.throws(() => assertObject(null, "field"));
  assert.throws(() => assertObject("hello", "field"));
});

test("assertEnum returns the value when it matches", () => {
  assert.equal(assertEnum("a", ["a", "b"] as const, "field"), "a");
  assert.throws(() => assertEnum("c", ["a", "b"] as const, "field"));
});
