import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  detectMediaType,
  imageBlockFromDataUrl,
  imageBlockFromUrl,
  imageSrcFromPathOrUrl,
  isImageDataUrl
} from "../electron/claudeImages.js";

test("detectMediaType maps common extensions", () => {
  assert.equal(detectMediaType("photo.png"), "image/png");
  assert.equal(detectMediaType("photo.jpg"), "image/jpeg");
  assert.equal(detectMediaType("photo.jpeg"), "image/jpeg");
  assert.equal(detectMediaType("photo.gif"), "image/gif");
  assert.equal(detectMediaType("photo.webp"), "image/webp");
  assert.equal(detectMediaType("photo.unknown"), "image/png");
});

test("isImageDataUrl recognises base64 data URLs", () => {
  assert.equal(isImageDataUrl("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isImageDataUrl("https://example.com/photo.png"), false);
});

test("imageSrcFromPathOrUrl forwards data URLs unchanged", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(imageSrcFromPathOrUrl(dataUrl), dataUrl);
});

test("imageSrcFromPathOrUrl forwards http(s) URLs unchanged", () => {
  assert.equal(imageSrcFromPathOrUrl("https://example.com/p.png"), "https://example.com/p.png");
});

test("imageSrcFromPathOrUrl converts absolute POSIX paths to file URLs", () => {
  const result = imageSrcFromPathOrUrl("/tmp/photo.png");
  assert.match(result, /^file:\/\/\/.+photo\.png$/);
});

test("imageSrcFromPathOrUrl returns empty string for invalid input", () => {
  assert.equal(imageSrcFromPathOrUrl(""), "");
  assert.equal(imageSrcFromPathOrUrl(null), "");
  assert.equal(imageSrcFromPathOrUrl(undefined), "");
});

test("imageBlockFromDataUrl produces a base64 source block", () => {
  const block = imageBlockFromDataUrl("data:image/png;base64,iVBORw0KGgo=");
  assert.ok(block);
  assert.equal(block?.type, "image");
  assert.equal(block?.source.type, "base64");
  if (block?.source.type === "base64") {
    assert.equal(block.source.media_type, "image/png");
    assert.equal(block.source.data, "iVBORw0KGgo=");
  }
});

test("imageBlockFromDataUrl returns null for non-data URLs", () => {
  assert.equal(imageBlockFromDataUrl("https://example.com/p.png"), null);
});

test("imageBlockFromUrl produces a url source block", () => {
  const block = imageBlockFromUrl("https://example.com/p.png");
  assert.equal(block.type, "image");
  assert.equal(block.source.type, "url");
  if (block.source.type === "url") {
    assert.equal(block.source.url, "https://example.com/p.png");
  }
});
