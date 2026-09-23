#!/usr/bin/env node
/**
 * Source-level dynamic provisioning E2E:
 *   diagnose -> apply -> verify durable config/OBS scene
 *
 * This verifies the GSM provisioning mutation without packaging, then proves
 * the generated scene becomes active and AutoLauncher starts an auto-mode OCR
 * process. Recognized text output is the final live-content check.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (!args.includes("--confirm-write")) {
  throw new Error("provision:e2e requires --confirm-write.");
}
const replaceInstalledPrimary = args.includes("--replace-installed-primary");

function runNode(script, forwardedArgs) {
  return execFileSync(
    process.execPath,
    [script, ...forwardedArgs],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 15_000,
    }
  ).trim();
}

const forwarded = args.filter(
  (arg) =>
    arg !== "--confirm-write" &&
    arg !== "--replace-installed-primary"
);
const diagnose = () =>
  JSON.parse(runNode("scripts/provision-diagnose.mjs", forwarded));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function focusKnownLaunchWindow(pids) {
  const validPids = [...new Set(pids ?? [])].filter(
    (pid) => Number.isInteger(pid) && pid > 0
  );
  if (validPids.length === 0) return false;

  const pidList = validPids.join(",");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LaunchFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@; $candidate = Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($candidate) { [bool][LaunchFocus]::SetForegroundWindow($candidate.MainWindowHandle) } else { $false }`,
      ],
      { encoding: "utf8", timeout: 3_000, windowsHide: true }
    ).trim();
    return stdout.toLocaleLowerCase() === "true";
  } catch {
    return false;
  }
}

async function waitForOwnedForeground(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = diagnose();
      lastError = null;

      const processId = last.requested?.processId;
      const foregroundOwned =
        !processId || last.lineage?.foregroundOwned === true;
      if (last.result === "safe-to-provision" && foregroundOwned) {
        return last;
      }

      if (processId) {
        // Running this helper from a terminal can itself leave the terminal as
        // the foreground window. Best-effort focus a visible window that is
        // already proven to be in the known Playnite launch tree, then require
        // a fresh diagnostic snapshot to prove ownership before any write.
        focusKnownLaunchWindow(last.lineage?.knownPids);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(750);
  }

  throw new Error(
    "Read-only preflight did not observe a safe foreground window owned by the Playnite launch tree within " +
      timeoutMs +
      "ms. No provisioning write was attempted.\n" +
      JSON.stringify(
        {
          attempts,
          lastError,
          foreground: last?.foreground ?? null,
          lineage: last?.lineage ?? null,
          resolver: last?.resolver ?? null,
          result: last?.result ?? null,
        },
        null,
        2
      )
  );
}

function getInstalledGsmPids() {
  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-Process GameSentenceMiner -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','",
      ],
      { encoding: "utf8", timeout: 5_000, windowsHide: true }
    ).trim();
    if (!stdout) return [];
    return stdout
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function replaceInstalledGsmPrimaryForSourceTest(timeoutMs = 8_000) {
  const initialPids = getInstalledGsmPids();
  if (initialPids.length === 0) {
    return { requested: true, closedPids: [] };
  }

  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Stop-Process -Id ${initialPids.join(",")} -Force -ErrorAction Stop`,
      ],
      { stdio: "ignore", timeout: 5_000, windowsHide: true }
    );
  } catch (error) {
    throw new Error(
      "Source E2E could not stop the installed GameSentenceMiner primary: " +
        (error instanceof Error ? error.message : String(error))
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = getInstalledGsmPids();
    if (remaining.length === 0) {
      return { requested: true, closedPids: initialPids };
    }
    await sleep(250);
  }

  throw new Error(
    "Installed GameSentenceMiner.exe did not exit within " +
      timeoutMs +
      "ms after explicit source-test replacement request. Remaining PIDs: " +
      getInstalledGsmPids().join(", ")
  );
}

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
      { stdio: "ignore", timeout: 3_000, windowsHide: true }
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
      { encoding: "utf8", timeout: 5_000, windowsHide: true }
    ).trim();
    return /^\d+$/.test(stdout);
  } catch {
    return false;
  }
}

const before = await waitForOwnedForeground();
const beforeBinding = before.existing?.bindings?.find(
  (binding) =>
    binding.externalId === before.requested.externalId &&
    binding.pending === false &&
    Boolean(binding.sceneId)
);

const installedPrimaryReplacement = replaceInstalledPrimary
  ? await replaceInstalledGsmPrimaryForSourceTest()
  : { requested: false, closedPids: [] };

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
  const reusedExistingScene =
    !beforeBinding || beforeBinding.sceneId === completeBinding?.sceneId;

  if (
    completeBinding &&
    hasScene &&
    autoOcrReady &&
    launchScoped &&
    noPersistentTitleRule &&
    reusedExistingScene
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

      if (switchedToBoundScene && ocrProcessRunning) {
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
              apply: {
                ...apply,
                installedPrimaryReplacement,
              },
              provisioned: {
                binding: completeBinding,
                scenes: live.existing.boundScenes,
                sceneProfiles: live.existing.sceneProfiles,
                persistentWindowSceneRules:
                  live.existing.persistentWindowSceneRules,
                autoOcrReady: live.existing.autoOcrReady,
                reusedExistingScene: beforeBinding
                  ? beforeBinding.sceneId === completeBinding.sceneId
                  : null,
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
