#!/usr/bin/env node
/**
 * Source-level dynamic provisioning E2E:
 *   diagnose -> apply -> verify durable config/OBS scene
 *
 * This verifies the whole GSM provisioning mutation without packaging. Actual
 * OCR runtime output is verified separately after the created scene becomes
 * active, because OCR is a live backend/session concern rather than config.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (!args.includes("--confirm-write")) {
  throw new Error("provision:e2e requires --confirm-write.");
}

function runNode(script, forwardedArgs) {
  return execFileSync(
    process.execPath,
    [script, ...forwardedArgs],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }
  ).trim();
}

const forwarded = args.filter((arg) => arg !== "--confirm-write");
const diagnose = () =>
  JSON.parse(runNode("scripts/provision-diagnose.mjs", forwarded));

function restoreForeground(hwnd) {
  if (!hwnd) return;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FocusRestore {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@; [void][FocusRestore]::SetForegroundWindow([IntPtr]${String(hwnd)})`,
      ],
      { stdio: "ignore" }
    );
  } catch {
    // Best-effort only. The final active-scene/OCR checks still fail closed.
  }
}

function isOcrProcessRunning() {
  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'GameSentenceMiner\\.ocr\\.gsm_ocr' } | Select-Object -First 1 -ExpandProperty ProcessId)",
      ],
      { encoding: "utf8" }
    ).trim();
    return /^\d+$/.test(stdout);
  } catch {
    return false;
  }
}

const before = diagnose();
if (before.result !== "safe-to-provision") {
  throw new Error(
    "Read-only preflight is not safe-to-provision:\n" +
      JSON.stringify(before, null, 2)
  );
}
if (before.requested.processId && !before.lineage?.foregroundOwned) {
  throw new Error(
    "Read-only preflight did not prove that the foreground PID belongs to the Playnite launch tree."
  );
}

const applyOutput = runNode("scripts/provision-apply.mjs", [
  ...forwarded,
  "--confirm-write",
]);
let apply;
try {
  apply = JSON.parse(applyOutput);
} catch {
  apply = { raw: applyOutput };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + 30_000;
let after = null;

await sleep(2_000);
restoreForeground(before.foreground?.hwnd);

while (Date.now() < deadline) {
  await sleep(1_000);
  try {
    after = diagnose();
  } catch {
    continue;
  }

  const completeBinding = after.existing?.bindings?.find(
    (binding) =>
      binding.externalId === after.requested.externalId &&
      binding.pending === false &&
      Boolean(binding.sceneId)
  );
  const hasScene = (after.existing?.boundScenes?.length ?? 0) > 0;
  const autoOcrReady = after.existing?.autoOcrReady === true;
  const processOwned =
    before.resolver?.status === "resolved" &&
    typeof before.resolver?.target?.launchProcessId === "number";
  const launchScoped =
    !processOwned || completeBinding?.switchingMode === "launch-pid";
  const noPersistentTitleRule =
    !processOwned ||
    (after.existing?.persistentWindowSceneRules?.length ?? 0) === 0;

  if (
    completeBinding &&
    hasScene &&
    autoOcrReady &&
    launchScoped &&
    noPersistentTitleRule
  ) {
    restoreForeground(before.foreground?.hwnd);

    const ocrDeadline = Date.now() + 20_000;
    let ocrLogStarted = false;
    let ocrProcessRunning = false;
    let switchedToBoundScene = false;
    let live = after;

    while (Date.now() < ocrDeadline) {
      await sleep(1_000);
      try {
        live = diagnose();
      } catch {
        // Keep polling while source Electron/OBS settles.
      }

      const boundSceneId = completeBinding.sceneId;
      switchedToBoundScene =
        live?.obs?.currentProgramScene?.id === boundSceneId ||
        live?.obs?.currentProgramScene?.name === completeBinding.sceneName;

      const logPath = apply?.logPath;
      if (logPath && fs.existsSync(logPath)) {
        const log = fs.readFileSync(logPath, "utf8");
        ocrLogStarted = log.includes(
          "Starting OCR process (source=auto-launcher, mode=auto)."
        );
      }
      ocrProcessRunning = isOcrProcessRunning();

      if (switchedToBoundScene && ocrLogStarted && ocrProcessRunning) {
        console.log(
          JSON.stringify(
            {
              verified: true,
              preflight: {
                foreground: before.foreground,
                lineage: before.lineage,
                resolver: before.resolver,
                planned: before.planned,
              },
              apply,
              provisioned: {
                binding: completeBinding,
                scenes: live.existing.boundScenes,
                sceneProfiles: live.existing.sceneProfiles,
                persistentWindowSceneRules:
                  live.existing.persistentWindowSceneRules,
                autoOcrReady: live.existing.autoOcrReady,
              },
              runtime: {
                currentProgramScene: live.obs.currentProgramScene,
                ocrAutoStartLogged: ocrLogStarted,
                ocrProcessRunning,
              },
              nextGate:
                "Generate visible Japanese text and confirm OCR output is observed, then relaunch through Playnite and confirm the same scene/binding is reused with the new process tree.",
            },
            null,
            2
          )
        );
        process.exit(0);
      }

      restoreForeground(before.foreground?.hwnd);
    }

    throw new Error(
      "Provisioning config was created, but live runtime verification did not complete. " +
        JSON.stringify(
          {
            switchedToBoundScene,
            ocrLogStarted,
            ocrProcessRunning,
            currentProgramScene: live?.obs?.currentProgramScene ?? null,
            logPath: apply?.logPath ?? null,
          },
          null,
          2
        )
    );
  }
}

throw new Error(
  "Provisioning write did not reach a fully verified scene/binding/auto-OCR state within 30 seconds. Last diagnostic:\n" +
    JSON.stringify(after, null, 2)
);
