#!/usr/bin/env node
/**
 * Dev orchestrator: spawns Vite on a fixed port, waits for it to be ready,
 * then compiles the main + preload TypeScript and launches Electron with
 * VITE_DEV_SERVER_URL set so the main process loads the dev URL instead
 * of the built dist/index.html.
 */

import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const VITE_URL = "http://127.0.0.1:5174";

function bin(name) {
  return path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name
  );
}

function waitForUrl(url, attempts = 60) {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < attempts; i += 1) {
      const ok = await new Promise((r) => {
        const req = http.get(url, (res) => {
          res.resume();
          r(res.statusCode != null && res.statusCode < 500);
        });
        req.on("error", () => r(false));
        req.setTimeout(500, () => {
          req.destroy();
          r(false);
        });
      });
      if (ok) return resolve(undefined);
      await sleep(250);
    }
    reject(new Error(`Vite did not become ready at ${url}`));
  });
}

const vite = spawn(bin("vite"), ["--host", "127.0.0.1", "--port", "5174"], {
  cwd: repoRoot,
  stdio: "inherit"
});

process.on("exit", () => vite.kill());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

await waitForUrl(VITE_URL);

execFileSync(bin("tsc"), ["-p", "tsconfig.electron.json"], { cwd: repoRoot, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/build-preload.mjs"], { cwd: repoRoot, stdio: "inherit" });

const electron = spawn(bin("electron"), ["."], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: VITE_URL }
});

electron.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
