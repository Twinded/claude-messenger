/**
 * Image content helpers — turns local paths, data URLs, and remote URLs
 * into the Anthropic Messages API image-content shape used by the SDK.
 *
 * Replaces shared/codexImages.js, which encoded the Codex-specific
 * `imagegeneration` / `imageview` protocol items; the Claude SDK exposes
 * unified `image` content blocks regardless of source.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const dataUrlPattern = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i;
const httpPattern = /^https?:\/\//i;
const filePattern = /^file:\/\//i;
const windowsDrivePattern = /^[a-zA-Z]:\//;

export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export interface ImageContentBlockBase64 {
  type: "image";
  source: { type: "base64"; media_type: ImageMediaType; data: string };
}

export interface ImageContentBlockUrl {
  type: "image";
  source: { type: "url"; url: string };
}

export type ImageContentBlock = ImageContentBlockBase64 | ImageContentBlockUrl;

export function detectMediaType(extOrName: string): ImageMediaType {
  const lower = extOrName.toLowerCase();
  if (lower.endsWith("png")) return "image/png";
  if (lower.endsWith("jpg") || lower.endsWith("jpeg")) return "image/jpeg";
  if (lower.endsWith("gif")) return "image/gif";
  if (lower.endsWith("webp")) return "image/webp";
  return "image/png";
}

export function isImageDataUrl(value: string): boolean {
  return dataUrlPattern.test(value);
}

export function imageSrcFromPathOrUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (dataUrlPattern.test(text)) return text;
  if (httpPattern.test(text) || filePattern.test(text)) return text;
  const normalized = text.replace(/\\/g, "/");
  if (windowsDrivePattern.test(normalized)) {
    return `file:///${encodeURI(normalized).replace(/[#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  }
  if (path.isAbsolute(text)) return pathToFileURL(text).href;
  return "";
}

export function imageBlockFromDataUrl(dataUrl: string): ImageContentBlockBase64 | null {
  const match = dataUrl.match(dataUrlPattern);
  if (!match) return null;
  const headerEnd = dataUrl.indexOf(";base64,");
  const mime = dataUrl.slice(5, headerEnd) as ImageMediaType;
  return {
    type: "image",
    source: { type: "base64", media_type: mime, data: match[1] ?? "" }
  };
}

export function imageBlockFromUrl(url: string): ImageContentBlockUrl {
  return { type: "image", source: { type: "url", url } };
}
