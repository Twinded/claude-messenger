/**
 * Auth bridge — resolves the credential the Claude Agent SDK should use:
 *
 *   1. If ~/.claude/.credentials.json exists, prefer Claude Code's
 *      OAuth credentials (the SDK reuses them automatically when no
 *      ANTHROPIC_API_KEY is set).
 *   2. Otherwise, look for a stored API key in the OS keychain via
 *      keytar.
 *   3. Otherwise, fall back to the ANTHROPIC_API_KEY env var.
 *
 * Secrets are never returned to the renderer — only `authStatus()` shape
 * crosses the IPC boundary.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEYTAR_SERVICE = "claude-messenger";
const KEYTAR_ACCOUNT = "anthropic-api-key";

export type AuthMode = "oauth-claude" | "api-key" | "env" | "unset";

export interface AuthStatus {
  mode: AuthMode;
  ready: boolean;
  hasOauthCredentials: boolean;
  hasStoredApiKey: boolean;
  hasEnvApiKey: boolean;
}

export interface AuthBridge {
  status(): Promise<AuthStatus>;
  storeApiKey(apiKey: string): Promise<void>;
  clearApiKey(): Promise<void>;
  resolveApiKey(): Promise<string | null>;
  applyToProcessEnv(): Promise<AuthMode>;
}

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    const mod = (await import("keytar")) as unknown as { default?: KeytarLike } & KeytarLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function claudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

function claudeHomeDir(): string {
  return path.join(os.homedir(), ".claude");
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects an existing Claude Code installation. The credential storage
 * differs per platform:
 *   - Linux / Windows: ~/.claude/.credentials.json (plain file).
 *   - macOS: macOS Keychain under the service "Claude Code-credentials"
 *     (no file is written). We check Keychain via the `security` CLI to
 *     avoid triggering a Keychain prompt with keytar.findCredentials().
 *
 * As a cross-platform fallback we also accept the presence of the
 * `~/.claude/sessions/` directory together with `~/.claude/settings.json`,
 * which is enough to assume the SDK can resolve credentials on its own.
 */
async function detectClaudeCodeOauth(): Promise<boolean> {
  if (await fileExists(claudeCredentialsPath())) return true;

  if (process.platform === "darwin") {
    const hasKeychainEntry = await new Promise<boolean>((resolve) => {
      const proc = spawn(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials"],
        { stdio: "ignore" }
      );
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
    });
    if (hasKeychainEntry) return true;
  }

  const claudeHome = claudeHomeDir();
  const hasSettings = await fileExists(path.join(claudeHome, "settings.json"));
  const hasSessions = await fileExists(path.join(claudeHome, "sessions"));
  return hasSettings && hasSessions;
}

export function createAuthBridge(): AuthBridge {
  const status = async (): Promise<AuthStatus> => {
    const keytar = await loadKeytar();
    const hasOauthCredentials = await detectClaudeCodeOauth();
    const storedKey = keytar
      ? await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT).catch(() => null)
      : null;
    const hasStoredApiKey = Boolean(storedKey);
    const hasEnvApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

    let mode: AuthMode = "unset";
    if (hasOauthCredentials) mode = "oauth-claude";
    else if (hasStoredApiKey) mode = "api-key";
    else if (hasEnvApiKey) mode = "env";

    return {
      mode,
      ready: mode !== "unset",
      hasOauthCredentials,
      hasStoredApiKey,
      hasEnvApiKey
    };
  };

  const storeApiKey = async (apiKey: string): Promise<void> => {
    const trimmed = apiKey.trim();
    if (!trimmed.startsWith("sk-ant-") || trimmed.length < 20) {
      throw new Error("Invalid Anthropic API key");
    }
    const keytar = await loadKeytar();
    if (!keytar) throw new Error("keytar is not available on this platform");
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, trimmed);
  };

  const clearApiKey = async (): Promise<void> => {
    const keytar = await loadKeytar();
    if (!keytar) return;
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT).catch(() => false);
  };

  const resolveApiKey = async (): Promise<string | null> => {
    const keytar = await loadKeytar();
    const stored = keytar
      ? await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT).catch(() => null)
      : null;
    return stored ?? process.env.ANTHROPIC_API_KEY ?? null;
  };

  const applyToProcessEnv = async (): Promise<AuthMode> => {
    const current = await status();
    if (current.mode === "oauth-claude") {
      // The SDK auto-picks ~/.claude/.credentials.json when no API key is set.
      return current.mode;
    }
    if (current.mode === "api-key") {
      const stored = await resolveApiKey();
      if (stored) process.env.ANTHROPIC_API_KEY = stored;
      return current.mode;
    }
    return current.mode;
  };

  return { status, storeApiKey, clearApiKey, resolveApiKey, applyToProcessEnv };
}
