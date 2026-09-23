#!/usr/bin/env node
/**
 * Guarded source-level provisioning apply helper.
 *
 * This launches the repo's Electron app with the same opaque provisioning
 * token used by Playnite. It intentionally requires --confirm-write because
 * it can create/modify OBS scenes and GSM provisioning state.
 *
 * Usage:
 *   npm run provision:apply -- --name "Game" --external-id "playnite:<guid>" --pid 123 --confirm-write
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function value(flag, required = true) {
  const index = args.indexOf(flag);
  const result = index >= 0 ? args[index + 1] : undefined;
  if (required && (!result || result.startsWith("--"))) {
    throw new Error(
      `Missing ${flag}. Usage: npm run provision:apply -- --name "Game" --external-id "playnite:<guid>" --pid 123 --confirm-write`
    );
  }
  return result;
}

if (process.platform !== "win32") {
  throw new Error("provision:apply is supported only on Windows.");
}
if (!args.includes("--confirm-write")) {
  throw new Error(
    "Refusing to mutate GSM/OBS state without explicit --confirm-write."
  );
}

const displayName = value("--name");
const externalId = value("--external-id");
const pidValue = value("--pid");
const processId = Number(pidValue);
if (!Number.isInteger(processId) || processId <= 0) {
  throw new Error("--pid must be a positive integer.");
}
if (!externalId.startsWith("playnite:")) {
  throw new Error('--external-id must use the canonical "playnite:<guid>" form.');
}

// Avoid accidentally forwarding this source-level test into an older installed
// packaged GSM primary instance. A source Electron primary appears as
// electron.exe; an installed GSM primary appears as GameSentenceMiner.exe.
const installedGsm = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-Process GameSentenceMiner -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id)",
  ],
  { encoding: "utf8", timeout: 5_000, windowsHide: true }
).trim();
if (installedGsm) {
  throw new Error(
    `Installed GameSentenceMiner.exe is running (PID ${installedGsm}). Close it before using provision:apply so the token cannot be forwarded to the installed build.`
  );
}

const payload = JSON.stringify({
  displayName: displayName.trim(),
  externalId: externalId.trim(),
  processId,
});
const encoded = Buffer.from(payload, "utf8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");
const token = "gsm-provision-v1-" + encoded;

const electronExe = path.join(
  repoRoot,
  "node_modules",
  "electron",
  "dist",
  "electron.exe"
);

const logDirectory = path.join(repoRoot, "temp");
fs.mkdirSync(logDirectory, { recursive: true });
const logPath = path.join(logDirectory, "provision-source-electron.log");
const logFd = fs.openSync(logPath, "w");

const child = spawn(electronExe, [repoRoot, token], {
  cwd: repoRoot,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  windowsHide: false,
  env: {
    ...process.env,
    GSM_SOURCE_E2E_REUSE_EXISTING_OBS: "1",
  },
});
fs.closeSync(logFd);
child.unref();

console.log(
  JSON.stringify(
    {
      mode: "write",
      displayName: displayName.trim(),
      externalId: externalId.trim(),
      processId,
      transport: "source-electron-single-token",
      electronPid: child.pid ?? null,
      logPath,
    },
    null,
    2
  )
);
