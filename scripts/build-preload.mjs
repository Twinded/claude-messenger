#!/usr/bin/env node
/**
 * Bundle electron/preload.ts to a single CommonJS file at
 * dist-electron/preload.cjs.
 *
 * Electron preload scripts running with `sandbox: true` only support
 * CommonJS (not ESM). Worse: they cannot reach files outside the preload
 * itself reliably in production (asar-packed bundles, relative paths, etc.).
 * To stay safe we bundle the preload with esbuild so any imported
 * constants from `shared/types.ts` are inlined into a single
 * self-contained file.
 */

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(repoRoot, "electron", "preload.ts")],
  outfile: path.join(repoRoot, "dist-electron", "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: ["node20"],
  sourcemap: true,
  external: ["electron"],
  logLevel: "info"
});
