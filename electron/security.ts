/**
 * URL allowlists and request validation helpers for the Electron main process.
 *
 * The renderer never makes outbound network requests directly: it must go
 * through the main process, which only allows external links and HTTP calls
 * to a small set of hosts (GitHub for releases, Anthropic for the API,
 * the local Claude Code config files, and standard package registries used
 * for self-update).
 */

const allowedExternalProtocols = new Set(["https:", "http:", "mailto:"]);

const allowedHttpHosts = new Set([
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "api.anthropic.com",
  "console.anthropic.com",
  "claude.ai",
  "docs.anthropic.com",
  "registry.npmjs.org",
  "www.npmjs.com",
  "npmjs.com"
]);

export function isSafeExternalUrl(value: unknown): boolean {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return false;
  }
  if (!allowedExternalProtocols.has(url.protocol)) return false;
  if (url.protocol === "mailto:") return Boolean(url.pathname);
  // http:// is intentionally rejected entirely — even localhost. Cliquable
  // links rendered by the assistant should never trigger requests to local
  // services. The Vite dev server is loaded by the main process via a
  // dedicated env var, not by passing through this allowlist.
  if (url.protocol === "http:") return false;
  return allowedHttpHosts.has(url.hostname);
}

export interface AssertStringOptions {
  required?: boolean;
  maxLength?: number;
}

export function assertString(
  value: unknown,
  field: string,
  { required = true, maxLength = 2000 }: AssertStringOptions = {}
): string {
  if (value === null || value === undefined || value === "") {
    if (!required) return "";
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value;
}

export function assertObject<T extends object = Record<string, unknown>>(
  value: unknown,
  field: string
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as T;
}

export function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T | null = null
): T {
  const clean = String(value ?? fallback ?? "");
  if (!(allowed as readonly string[]).includes(clean)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return clean as T;
}
