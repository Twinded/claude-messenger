import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  defaultClaudeOptions,
  normalizeClaudeOptions,
  PERMISSION_MODES,
  SUPPORTED_MODELS
} from "../shared/claudeOptions.js";

test("defaultClaudeOptions exposes a supported model", () => {
  assert.ok(SUPPORTED_MODELS.includes(defaultClaudeOptions.model));
});

test("normalizeClaudeOptions falls back to defaults for unknown models", () => {
  const merged = normalizeClaudeOptions({ model: "claude-totally-fake-9000" as never });
  assert.equal(merged.model, defaultClaudeOptions.model);
});

test("normalizeClaudeOptions clamps maxOutputTokens", () => {
  const lower = normalizeClaudeOptions({ maxOutputTokens: 0 });
  assert.equal(lower.maxOutputTokens, 256);

  const upper = normalizeClaudeOptions({ maxOutputTokens: 1_000_000 });
  assert.equal(upper.maxOutputTokens, 64_000);
});

test("normalizeClaudeOptions falls back to defaults for unknown permission modes", () => {
  const merged = normalizeClaudeOptions({ permissionMode: "invalid" as never });
  assert.equal(merged.permissionMode, defaultClaudeOptions.permissionMode);
});

test("PERMISSION_MODES contains the documented modes", () => {
  for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"]) {
    assert.ok(PERMISSION_MODES.includes(mode as never));
  }
});

test("normalizeClaudeOptions preserves resumeSessionId", () => {
  const merged = normalizeClaudeOptions({ resumeSessionId: "session-abc" });
  assert.equal(merged.resumeSessionId, "session-abc");
});
