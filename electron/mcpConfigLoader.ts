/**
 * Loads MCP server configurations from a project's .claude/settings.json
 * and from the user-level ~/.claude/settings.json. Merges them with
 * project-level entries taking precedence over user-level ones.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpServerConfig } from "../shared/claudeOptions.js";

interface RawSettingsFile {
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: Record<string, unknown>;
}

async function readJson(filePath: string): Promise<RawSettingsFile | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as RawSettingsFile;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadMcpServers(cwd?: string): Promise<Record<string, McpServerConfig>> {
  const userPath = path.join(os.homedir(), ".claude", "settings.json");
  const projectPath = cwd ? path.join(cwd, ".claude", "settings.json") : null;
  const localPath = cwd ? path.join(cwd, ".claude", "settings.local.json") : null;

  const userConfig = await readJson(userPath);
  const projectConfig = projectPath ? await readJson(projectPath) : null;
  const localConfig = localPath ? await readJson(localPath) : null;

  return {
    ...(userConfig?.mcpServers ?? {}),
    ...(projectConfig?.mcpServers ?? {}),
    ...(localConfig?.mcpServers ?? {})
  };
}
