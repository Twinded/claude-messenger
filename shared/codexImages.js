/**
 * Compatibility shim for upstream codex-messenger image helpers.
 *
 * The upstream renderer routes image content (image_view, image_generation_call)
 * through a small set of helpers. The same helpers — minus their codex-server
 * specific protocol parsing — are useful for rendering Claude content blocks
 * (`image` content with base64 / url sources). This file mirrors the upstream
 * names so the vendored React components compile unchanged.
 */

const dataUrlPattern = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i;
const httpPattern = /^https?:\/\//i;
const filePattern = /^file:\/\//i;
const windowsDrivePattern = /^[a-zA-Z]:\//;

function cleanType(item) {
  return String(item?.type ?? "").toLowerCase();
}

const imageGenerationTypes = new Set([
  "imagegeneration",
  "image_generation_call",
  "image"
]);
const imageViewTypes = new Set(["imageview", "image_view"]);

export function isCodexImageItem(item) {
  const type = cleanType(item);
  return imageGenerationTypes.has(type) || imageViewTypes.has(type);
}

function safeFileUrlForWindowsPath(value) {
  const normalized = String(value).replace(/\\/g, "/");
  if (!windowsDrivePattern.test(normalized)) return "";
  return `file:///${encodeURI(normalized).replace(/[#?]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function imageSrcFromPathOrUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (dataUrlPattern.test(text)) return text;
  if (httpPattern.test(text) || filePattern.test(text)) return text;
  const windowsFileUrl = safeFileUrlForWindowsPath(text);
  if (windowsFileUrl) return windowsFileUrl;
  // Posix absolute path (renderer cannot use node:url so we synthesise the URL).
  if (text.startsWith("/")) return `file://${encodeURI(text)}`;
  return "";
}

export function imageSrcFromBase64Png(value) {
  const text = String(value ?? "").trim();
  const dataUrlMatch = text.match(/^data:image\/png;base64,([\s\S]+)$/i);
  const compact = (dataUrlMatch ? dataUrlMatch[1] : text).replace(/\s+/g, "");
  if (compact.length < 32) return "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return "";
  // Renderer-friendly: trust the prefix. Strict PNG signature checks live in
  // the main process where Buffer is available.
  return `data:image/png;base64,${compact}`;
}

function basenameFromUrl(value, fallback) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/");
    const last = segments[segments.length - 1] ?? "";
    return decodeURIComponent(last) || fallback;
  } catch {
    return fallback;
  }
}

function basenameForImage(value, fallback = "image.png") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (httpPattern.test(text) || filePattern.test(text)) return basenameFromUrl(text, fallback);
  const segments = text.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || fallback;
}

export function codexImageFromItem(item) {
  const type = cleanType(item);

  if (imageViewTypes.has(type)) {
    const imagePath = item.path ?? item.filePath ?? item.file_path ?? item.source?.url ?? "";
    const src = imageSrcFromPathOrUrl(imagePath);
    if (!src) return null;
    return {
      kind: "imageView",
      src,
      path: imagePath,
      name: basenameForImage(imagePath),
      text: `Image consultée: ${imagePath}`,
      status: "completed",
      prompt: ""
    };
  }

  if (!imageGenerationTypes.has(type)) {
    // Claude messages embed images as `{ type: "image", source: { ... } }` blocks.
    if (item?.type === "image" && item.source) {
      const source = item.source;
      let src = "";
      if (source.type === "base64" && source.data) {
        src = `data:${source.media_type ?? "image/png"};base64,${source.data}`;
      } else if (source.type === "url" && source.url) {
        src = source.url;
      } else if (source.type === "file" && source.data) {
        src = imageSrcFromPathOrUrl(source.data);
      }
      if (!src) return null;
      return {
        kind: "imageView",
        src,
        path: source.url ?? "",
        name: basenameFromUrl(source.url ?? "", "image.png"),
        text: "Image",
        status: "completed",
        prompt: ""
      };
    }
    return null;
  }

  const savedPath = item.savedPath ?? item.saved_path ?? item.path ?? "";
  const prompt = String(item.revisedPrompt ?? item.revised_prompt ?? item.prompt ?? "").trim();
  const rawStatus = String(item.status ?? "").trim();
  const src =
    imageSrcFromBase64Png(item.src) ||
    imageSrcFromPathOrUrl(item.src) ||
    imageSrcFromBase64Png(item.result) ||
    imageSrcFromPathOrUrl(savedPath);
  const status = src && (!rawStatus || /^(generating|pending|in_progress)$/i.test(rawStatus))
    ? "completed"
    : rawStatus || "generating";
  if (!src && !prompt && !status) return null;
  const text = [
    src ? "Image générée" : `Image en génération (${status})`,
    prompt
  ].filter(Boolean).join(": ");
  return {
    kind: "imageGeneration",
    src,
    path: savedPath,
    name: basenameForImage(savedPath, `${item.id || "generated-image"}.png`),
    text,
    status,
    prompt
  };
}
