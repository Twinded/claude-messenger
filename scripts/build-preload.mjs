#!/usr/bin/env node
/**
 * Compile electron/preload.ts to CommonJS at dist-electron/preload.cjs.
 *
 * Electron preload scripts running with `sandbox: true` only support
 * CommonJS (not ESM), so we compile this single file separately from the
 * rest of the main process. tsc emits a `.js`; we rename it to `.cjs` so
 * Electron's loader picks it up unambiguously regardless of the package's
 * `"type": "module"` setting.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "dist-electron");

mkdirSync(outDir, { recursive: true });

const tscBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
execFileSync(tscBin, ["-p", "tsconfig.preload.json"], { cwd: repoRoot, stdio: "inherit" });

// tsc emits dist-electron/electron/preload.js — flatten and rename.
const candidates = [
  path.join(outDir, "electron", "preload.js"),
  path.join(outDir, "preload.js")
];

for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  const target = path.join(outDir, "preload.cjs");
  if (existsSync(target)) rmSync(target);
  renameSync(candidate, target);
  // Drop a tiny shim sourcemap rename if present.
  const map = `${candidate}.map`;
  if (existsSync(map)) renameSync(map, `${target}.map`);
  process.stdout.write(`built ${path.relative(repoRoot, target)}\n`);
  break;
}
