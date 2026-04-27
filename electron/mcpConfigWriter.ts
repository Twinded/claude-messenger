/**
 * Read/write the user-level MCP server map at `~/.claude/settings.json`.
 *
 * The settings file is shared with the Claude Code CLI, so we preserve
 * every other key untouched and only mutate the `mcpServers` section.
 * Per-project settings are NOT modified by this module — those should be
 * edited by the user through their project tooling.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpServerConfig } from "../shared/claudeOptions.js";

interface SettingsShape {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

function userSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

async function readSettings(): Promise<SettingsShape> {
  try {
    const raw = await fs.readFile(userSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as SettingsShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettings(next: SettingsShape): Promise<void> {
  const filePath = userSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
}

export async function listUserMcpServers(): Promise<Record<string, McpServerConfig>> {
  const settings = await readSettings();
  return settings.mcpServers ?? {};
}

export async function saveUserMcpServer(name: string, config: McpServerConfig): Promise<void> {
  if (!name.trim()) throw new Error("Le nom du serveur MCP est requis.");
  const settings = await readSettings();
  const current = settings.mcpServers ?? {};
  await writeSettings({
    ...settings,
    mcpServers: { ...current, [name]: config }
  });
}

export async function removeUserMcpServer(name: string): Promise<void> {
  const settings = await readSettings();
  const current = settings.mcpServers ?? {};
  if (!(name in current)) return;
  const { [name]: _removed, ...rest } = current;
  await writeSettings({ ...settings, mcpServers: rest });
}
