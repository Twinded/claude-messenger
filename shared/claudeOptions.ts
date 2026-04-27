/**
 * Defaults and validators for Claude Agent SDK options.
 *
 * Single source of truth for the model list, the permission modes we
 * surface in the UI, and the option normalization run before passing user
 * settings to `query()`. Mirrors `shared/codexOptions.js` upstream but
 * backed by Anthropic's API surface.
 */

export const SUPPORTED_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions"
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface ClaudeRuntimeOptions {
  model: SupportedModel;
  systemPrompt?: string;
  cwd?: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxOutputTokens?: number;
  maxThinkingTokens?: number;
  resumeSessionId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  settingSources?: Array<"user" | "project" | "local">;
}

export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export const defaultClaudeOptions: ClaudeRuntimeOptions = {
  model: "claude-sonnet-4-6",
  permissionMode: "default",
  maxOutputTokens: 8192,
  maxThinkingTokens: 4096,
  settingSources: ["user", "project"]
};

export function normalizeClaudeOptions(input: Partial<ClaudeRuntimeOptions>): ClaudeRuntimeOptions {
  const merged: ClaudeRuntimeOptions = { ...defaultClaudeOptions, ...input };
  if (!SUPPORTED_MODELS.includes(merged.model)) merged.model = defaultClaudeOptions.model;
  if (!PERMISSION_MODES.includes(merged.permissionMode)) {
    merged.permissionMode = defaultClaudeOptions.permissionMode;
  }
  if (typeof merged.maxOutputTokens === "number") {
    merged.maxOutputTokens = Math.max(256, Math.min(merged.maxOutputTokens, 64000));
  }
  if (typeof merged.maxThinkingTokens === "number") {
    merged.maxThinkingTokens = Math.max(0, Math.min(merged.maxThinkingTokens, 64000));
  }
  return merged;
}
