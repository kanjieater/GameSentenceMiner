#!/usr/bin/env node
/**
 * Read-only live provisioning preflight.  This intentionally does not create
 * OBS probe inputs: it only queries the two existing Setup Capture helpers.
 * Run with: npm run provision:diagnose -- --name "Game" --external-id "playnite:<guid>" [--pid 123] [--launch-kind emulator]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import OBSWebSocket from "obs-websocket-js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function value(flag, required = true) {
  const index = args.indexOf(flag);
  const result = index >= 0 ? args[index + 1] : undefined;
  if (required && (!result || result.startsWith("--"))) {
    throw new Error(`Missing ${flag}. Usage: npm run provision:diagnose -- --name "Game" --external-id "playnite:<guid>" [--pid 123]`);
  }
  return result;
}

const displayName = value("--name");
const externalId = value("--external-id");
const pidValue = value("--pid", false);
const launchKindValue = value("--launch-kind", false);
const processId = pidValue ? Number(pidValue) : undefined;
if (pidValue && (!Number.isInteger(processId) || processId <= 0)) {
  throw new Error("--pid must be a positive integer.");
}
if (launchKindValue !== undefined && launchKindValue !== "emulator") {
  throw new Error('--launch-kind must be "emulator" when supplied.');
}

function getForegroundSnapshot() {
  // Kept in this script rather than the app runtime so this preflight never
  // starts GSM services or changes foreground-hook state.
  // Match GSM's Windows hook: GetWindowTextW provides a UTF-16 window title.
  // Output UTF-8 JSON so Node never has to decode a console code page.
  const command = `$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type @'\nusing System; using System.Text; using System.Runtime.InteropServices;\npublic static class ForegroundProbe {\n [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n [DllImport(\"user32.dll\", EntryPoint=\"GetWindowTextW\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);\n [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\n}\n'@; $h=[ForegroundProbe]::GetForegroundWindow(); $windowPid=0; [void][ForegroundProbe]::GetWindowThreadProcessId($h,[ref]$windowPid); $b=New-Object Text.StringBuilder 4096; [void][ForegroundProbe]::GetWindowTextW($h,$b,$b.Capacity); $p=Get-Process -Id $windowPid -ErrorAction SilentlyContinue; [pscustomobject]@{hwnd=$h.ToInt64().ToString();pid=[int]$windowPid;title=$b.ToString();executablePath=if($p){$p.Path}else{''};executableName=if($p){$p.ProcessName+'.exe'}else{''};capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();sequence=1} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("powershell", ["-NoLogo", "-NoProfile", "-Command", command], { encoding: "utf8" }).trim());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseObsValue(raw) {
  // OBS Windows values conventionally look like: title:executable:class.
  const fields = String(raw ?? "").split(":");
  return { executable: fields.length >= 2 ? fields[1] : "" };
}

function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }

async function getObsWindowOptions() {
  const dataDir = process.env.GSM_DATA_DIR || path.join(process.env.APPDATA, "GameSentenceMiner");
  const configPaths = [
    path.join(dataDir, "obs-studio", "config", "obs-studio", "plugin_config", "obs-websocket", "config.json"),
    path.join(process.env.APPDATA, "obs-studio", "plugin_config", "obs-websocket", "config.json"),
  ].filter(fs.existsSync);
  let obs;
  let lastError;
  for (const configPath of configPaths) {
    const config = readJson(configPath);
    const candidate = new OBSWebSocket();
    try {
      await candidate.connect(`ws://${config.server_ip || "127.0.0.1"}:${config.server_port}`, config.server_password || "");
      obs = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!obs) throw lastError ?? new Error("No OBS websocket configuration was found.");
  try {
    const queried = await Promise.all([
      ["window_getter", "window_capture"],
      ["game_window_getter", "game_capture"],
    ].map(async ([inputName, kind]) => {
      try {
        const response = await obs.call("GetInputPropertiesListPropertyItems", { inputName, propertyName: "window" });
        return (response.propertyItems || []).map((item) => ({ kind, item }));
      } catch (error) {
        return [{ kind, error: error instanceof Error ? error.message : String(error) }];
      }
    }));
    const errors = queried.flat().filter((entry) => entry.error).map((entry) => entry.error);
    // Use GSM's exact merge/key/title/executable pipeline; do not reformat raw
    // OBS values in this diagnostic.
    const rawItems = queried.flat().flatMap((entry) => entry.item ? [{
      ...entry.item,
      captureMode: entry.kind,
    }] : []);
    const options = mergeObsWindowItems(rawItems).map((option) => ({
      ...option,
      // Production derives this from the same title. The resolver's title
      // match remains authoritative; the name is only ownership evidence.
      suggestedSceneName: option.title,
    }));
    return { options, errors };
  } finally {
    await obs.disconnect();
  }
}

const resolverPath = pathToFileURL(path.join(repoRoot, "dist", "main", "services", "game_provisioning_target_resolver.js")).href;
const capturePath = pathToFileURL(path.join(repoRoot, "dist", "main", "ui", "obs-capture.js")).href;
const { resolveForegroundCaptureTarget } = await import(resolverPath);
const { mergeObsWindowItems } = await import(capturePath);
const foreground = getForegroundSnapshot();
let obsResult;
try {
  obsResult = await getObsWindowOptions();
} catch (error) {
  obsResult = { options: [], errors: [error instanceof Error ? error.message : String(error)] };
}
const request = {
  displayName,
  externalId,
  ...(processId ? { processId } : {}),
  ...(launchKindValue ? { launchKind: launchKindValue } : {}),
  defaultMode: "ocr",
};
// This is the resolver configuration used after PR #10's exact-PID stability
// gate. It still enforces PID equality, so launcher→child cases remain refused.
const resolution = resolveForegroundCaptureTarget(request, foreground, obsResult.options, {
  enforceProcessId: true,
  allowLaunchScopedExactPid: true,
});
const planned = resolution.status === "resolved" ? {
  sceneName: request.displayName,
  externalIdBinding: request.externalId,
  captureTarget: resolution.target,
  launchPidAssociation: resolution.target.durableSwitcherSafe === false
    ? { pid: request.processId, sceneName: request.displayName }
    : null,
  persistentWindowSceneRule: resolution.target.durableSwitcherSafe !== false,
} : null;
const electronConfigPath = path.join(process.env.APPDATA, "GameSentenceMiner", "electron", "config.json");
const electronConfig = fs.existsSync(electronConfigPath) ? readJson(electronConfigPath) : {};
const activeCollection = (electronConfig.windowSceneSwitcher?.collections || []).find((item) => item.enabled);
const bindings = (electronConfig.gameProvisioningBindings || []).filter((item) => item.externalId === externalId);

console.log(JSON.stringify({
  mode: "read-only",
  requested: request,
  foreground,
  obs: { candidateCount: obsResult.options.length, candidates: obsResult.options, errors: obsResult.errors },
  resolver: resolution,
  planned,
  existing: { activeCollection: activeCollection?.collectionName ?? null, bindings },
  result: resolution.status === "resolved" ? "safe-to-provision" : "not-ready",
}, null, 2));
