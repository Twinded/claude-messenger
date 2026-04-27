/**
 * Persistent application settings stored as JSON on disk under userData.
 *
 * Schema is validated with zod on load; unknown fields are dropped and
 * missing fields are filled from defaults so the app always boots with a
 * valid configuration even after a downgrade.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { AppSettings } from "../shared/types.js";

const settingsSchema = z.object({
  language: z.enum(["fr", "en", "es", "ja"]).default("fr"),
  theme: z.enum(["xp", "msn-luna"]).default("xp"),
  defaultModel: z.string().min(1).default("claude-sonnet-4-6"),
  maxOutputTokens: z.number().int().positive().max(64000).default(8192),
  maxThinkingTokens: z.number().int().min(0).max(64000).default(4096),
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .default("default"),
  authMode: z.enum(["oauth-claude", "api-key", "unset"]).default("unset"),
  apiKeyStored: z.boolean().default(false),
  profilePicturePath: z.string().optional(),
  windowZoomFactor: z.number().positive().max(3).default(1)
});

export const defaultSettings: AppSettings = settingsSchema.parse({});

export interface SettingsStore {
  load(): Promise<{ settings: AppSettings; persisted: boolean }>;
  save(next: AppSettings): Promise<AppSettings>;
  current(): AppSettings | null;
  patch(partial: Partial<AppSettings>): Promise<AppSettings>;
}

export interface CreateSettingsStoreOptions {
  filePath: () => string;
}

export function createSettingsStore({ filePath }: CreateSettingsStoreOptions): SettingsStore {
  let cache: AppSettings | null = null;
  let persisted = false;

  async function load(): Promise<{ settings: AppSettings; persisted: boolean }> {
    if (cache) return { settings: cache, persisted };
    try {
      const raw = await fs.readFile(filePath(), "utf8");
      const parsed = settingsSchema.safeParse(JSON.parse(raw));
      cache = parsed.success ? parsed.data : { ...defaultSettings };
      persisted = parsed.success;
    } catch {
      cache = { ...defaultSettings };
      persisted = false;
    }
    return { settings: cache, persisted };
  }

  async function save(next: AppSettings): Promise<AppSettings> {
    const validated = settingsSchema.parse(next);
    cache = validated;
    persisted = true;
    await fs.mkdir(path.dirname(filePath()), { recursive: true });
    await fs.writeFile(filePath(), JSON.stringify(cache, null, 2), "utf8");
    return cache;
  }

  function current(): AppSettings | null {
    return cache;
  }

  async function patch(partial: Partial<AppSettings>): Promise<AppSettings> {
    const base = cache ?? (await load()).settings;
    return save({ ...base, ...partial });
  }

  return { load, save, current, patch };
}
