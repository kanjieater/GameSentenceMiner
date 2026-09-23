#!/usr/bin/env node
/**
 * Read-only live provisioning preflight.  This intentionally does not create
 * OBS probe inputs: it only queries the two existing Setup Capture helpers.
 * Run with: npm run provision:diagnose -- --name "Game" --external-id "playnite:<guid>" [--pid 123]
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
const processId = pidValue ? Number(pidValue) : undefined;
if (pidValue && (!Number.isInteger(processId) || processId <= 0)) {
  throw new Error("--pid must be a positive integer.");
}

function getForegroundSnapshot() {
  // Kept in this script rather than the app runtime so this preflight never
  // starts GSM services or changes foreground-hook state.
  // Match GSM's Windows hook: GetWindowTextW provides a UTF-16 window title.
  // Output UTF-8 JSON so Node never has to decode a console code page.
  const command = `$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type @'\nusing System; using System.Text; using System.Runtime.InteropServices;\npublic static class ForegroundProbe {\n [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n [DllImport(\"user32.dll\", EntryPoint=\"GetWindowTextW\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);\n [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\n}\n'@; $h=[ForegroundProbe]::GetForegroundWindow(); $windowPid=0; [void][ForegroundProbe]::GetWindowThreadProcessId($h,[ref]$windowPid); $b=New-Object Text.StringBuilder 4096; [void][ForegroundProbe]::GetWindowTextW($h,$b,$b.Capacity); $p=Get-Process -Id $windowPid -ErrorAction SilentlyContinue; [pscustomobject]@{hwnd=$h.ToInt64().ToString();pid=[int]$windowPid;title=$b.ToString();executablePath=if($p){$p.Path}else{''};executableName=if($p){$p.ProcessName+'.exe'}else{''};capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();sequence=1} | ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5_000, windowsHide: true }
    ).trim()
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseObsValue(raw) {
  // OBS Windows values conventionally look like: title:executable:class.
  const fields = String(raw ?? "").split(":");
  return { executable: fields.length >= 2 ? fields[1] : "" };
}

function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }

async function getObsWindowOptions(dataDir) {
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
      await withTimeout(
        candidate.connect(
          `ws://${config.server_ip || "127.0.0.1"}:${config.server_port}`,
          config.server_password || ""
        ),
        4_000,
        "OBS websocket connect"
      );
      obs = candidate;
      break;
    } catch (error) {
      lastError = error;
      await candidate.disconnect().catch(() => undefined);
    }
  }
  if (!obs) throw lastError ?? new Error("No OBS websocket configuration was found.");
  try {
    const queried = await Promise.all([
      ["window_getter", "window_capture"],
      ["game_window_getter", "game_capture"],
    ].map(async ([inputName, kind]) => {
      try {
        const response = await withTimeout(
          obs.call("GetInputPropertiesListPropertyItems", {
            inputName,
            propertyName: "window",
          }),
          4_000,
          `OBS ${inputName} candidate query`
        );
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
      // Production derives this from the foreground window title. This title
      // is only used to correlate the foreground HWND/process with OBS's
      // capture target; Playnite game identity comes from externalId + process
      // lineage.
      suggestedSceneName: option.title,
    }));
    const [collectionInfo, sceneInfo] = await Promise.all([
      withTimeout(obs.call("GetSceneCollectionList"), 4_000, "OBS collection query").catch(() => null),
      withTimeout(obs.call("GetSceneList"), 4_000, "OBS scene query").catch(() => null),
    ]);
    return {
      options,
      errors,
      activeCollection: collectionInfo?.currentSceneCollectionName ?? null,
      scenes: Array.isArray(sceneInfo?.scenes)
        ? sceneInfo.scenes.map((scene) => ({
            id: scene.sceneUuid ?? "",
            name: scene.sceneName ?? "",
          }))
        : [],
      currentProgramScene: sceneInfo
        ? {
            id: sceneInfo.currentProgramSceneUuid ?? "",
            name: sceneInfo.currentProgramSceneName ?? "",
          }
        : null,
    };
  } finally {
    await obs.disconnect();
  }
}

const resolverPath = pathToFileURL(path.join(repoRoot, "dist", "main", "services", "game_provisioning_target_resolver.js")).href;
const capturePath = pathToFileURL(path.join(repoRoot, "dist", "main", "ui", "obs-capture.js")).href;
const lineagePath = pathToFileURL(path.join(repoRoot, "dist", "main", "services", "process_lineage.js")).href;
const dataDirPath = pathToFileURL(path.join(repoRoot, "dist", "main", "data_dir.js")).href;
const { resolveForegroundCaptureTarget } = await import(resolverPath);
const { mergeObsWindowItems } = await import(capturePath);
const { LaunchProcessTree, getWindowsProcessRelationships } = await import(lineagePath);
const { getBaseDir } = await import(dataDirPath);
const dataDir = getBaseDir();
const foreground = getForegroundSnapshot();
let obsResult;
try {
  obsResult = await getObsWindowOptions(dataDir);
} catch (error) {
  obsResult = {
    options: [],
    errors: [error instanceof Error ? error.message : String(error)],
    activeCollection: null,
    scenes: [],
    currentProgramScene: null,
  };
}
const request = {
  displayName,
  externalId,
  ...(processId ? { processId } : {}),
  defaultMode: "ocr",
};
let launchTree = null;
let processRelationships = [];
if (processId) {
  launchTree = new LaunchProcessTree(processId);
  try {
    processRelationships = await getWindowsProcessRelationships();
    launchTree.observe(processRelationships);
  } catch {
    processRelationships = [];
  }
}
const resolution = resolveForegroundCaptureTarget(request, foreground, obsResult.options, {
  enforceProcessId: true,
  ...(launchTree ? { isLaunchProcess: (pid) => launchTree.owns(pid) } : {}),
});
const planned = resolution.status === "resolved" ? {
  sceneName: request.displayName,
  externalIdBinding: request.externalId,
  captureTarget: resolution.target,
  launchPidAssociation: resolution.target.durableSwitcherSafe === false
    ? { rootPid: request.processId, foregroundPid: resolution.target.launchProcessId, sceneName: request.displayName }
    : null,
  persistentWindowSceneRule: resolution.target.durableSwitcherSafe !== false,
} : null;
const electronConfigPath = path.join(dataDir, "electron", "config.json");
const electronConfig = fs.existsSync(electronConfigPath) ? readJson(electronConfigPath) : {};
const bindings = (electronConfig.gameProvisioningBindings || []).filter(
  (item) => item.externalId === externalId
);
const sceneProfiles = electronConfig.sceneLaunchProfiles || [];
const switcherCollections = electronConfig.windowSceneSwitcher?.collections || [];
const matchingProfiles = sceneProfiles.filter((profile) =>
  bindings.some(
    (binding) =>
      (binding.sceneId && profile.sceneId === binding.sceneId) ||
      (!binding.sceneId && binding.sceneName === profile.sceneName)
  )
);
const matchingRules = switcherCollections.flatMap((collection) =>
  (collection.rules || [])
    .filter((rule) =>
      bindings.some((binding) => binding.sceneId && rule.sceneUuid === binding.sceneId)
    )
    .map((rule) => ({ collectionName: collection.collectionName, ...rule }))
);
const boundScenes = obsResult.scenes.filter((scene) =>
  bindings.some(
    (binding) =>
      (binding.sceneId && binding.sceneId === scene.id) ||
      (!binding.sceneId && binding.sceneName === scene.name)
  )
);
const autoOcrReady =
  bindings.some((binding) => !binding.pending && Boolean(binding.sceneId)) &&
  matchingProfiles.some((profile) => profile.ocrMode === "auto");

console.log(JSON.stringify({
  mode: "read-only",
  dataDir,
  requested: request,
  foreground,
  lineage: processId ? {
    rootPid: processId,
    knownPids: launchTree?.getKnownPids() ?? [processId],
    foregroundOwned: launchTree?.owns(foreground.pid) ?? false,
    sampledRelationships: processRelationships.length,
  } : null,
  obs: {
    activeCollection: obsResult.activeCollection,
    sceneCount: obsResult.scenes.length,
    scenes: obsResult.scenes,
    currentProgramScene: obsResult.currentProgramScene,
    candidateCount: obsResult.options.length,
    candidates: obsResult.options,
    errors: obsResult.errors,
  },
  resolver: resolution,
  planned,
  existing: {
    bindings,
    boundScenes,
    sceneProfiles: matchingProfiles,
    persistentWindowSceneRules: matchingRules,
    autoOcrReady,
  },
  result: resolution.status === "resolved" ? "safe-to-provision" : "not-ready",
}, null, 2));
