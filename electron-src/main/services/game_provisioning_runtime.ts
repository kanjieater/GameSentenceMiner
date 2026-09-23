import {
  getGameProvisioningBinding,
  getSceneLaunchProfileForScene,
  getWindowSceneSwitcherConfig,
  reserveGameProvisioningBinding,
  upsertGameProvisioningBinding,
  upsertSceneLaunchProfile,
} from "../store.js";
import {
  createSceneWithCapture,
  getCurrentOBSSceneCollectionName,
  getOBSScenesForSceneSwitcher,
  getWindowTitleFromSourceForProvisioning,
  isOBSProvisioningNotReadyError,
  suggestWindowSceneSwitcherRuleForProvisioning,
} from "../ui/obs.js";
import {
  parseObsWindowValue,
  type ObsSceneCaptureWindowSelection,
} from "../ui/obs-capture.js";
import {
  WINDOW_SCENE_SWITCHER_MIGRATION_VERSION,
  normalizeExecutableName,
  type WindowSceneSwitcherCollection,
} from "../../shared/window_scene_switcher.js";
import {
  registerLaunchSceneAssociation,
  upsertGeneratedWindowSceneRule,
} from "./window_scene_switcher.js";
import {
  ensureGameProvisioned,
  GameProvisioningNotReadyError,
  type CaptureTargetResolution,
  type GameProvisioningDependencies,
  type GameProvisioningRequest,
  type GameProvisioningResult,
  type ProvisioningCaptureTarget,
  type ProvisioningScene,
  type ProvisioningSceneProfile,
} from "./game_provisioning.js";

export type GameCaptureTargetResolver = (
  request: GameProvisioningRequest
) => Promise<CaptureTargetResolution>;

function sameName(left: string, right: string): boolean {
  return (
    left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
  );
}

interface ProvisioningCaptureFingerprint {
  captureTitle: string;
  executableName?: string;
}

function normalizeFingerprintTitle(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function getTargetCaptureFingerprint(
  target: ProvisioningCaptureTarget
): ProvisioningCaptureFingerprint {
  const captureTitle = (target.title || target.selection.title || "").trim();
  const captureValues = [
    target.selection.captureValues?.game_capture,
    target.selection.captureValues?.window_capture,
  ];

  let executableName = "";
  for (const value of captureValues) {
    if (!value) {
      continue;
    }
    const parsed = parseObsWindowValue(value);
    executableName = normalizeExecutableName(parsed.executable);
    if (executableName) {
      break;
    }
  }

  if (!captureTitle) {
    throw new Error(
      "Provisioning target has no stable capture title; refusing to reserve ownership."
    );
  }
  if (target.selection.targetKind === "window" && !executableName) {
    throw new Error(
      "Window provisioning target has no executable identity; refusing to reserve ownership."
    );
  }

  return {
    captureTitle,
    ...(executableName ? { executableName } : {}),
  };
}

function fingerprintsMatch(
  left: ProvisioningCaptureFingerprint,
  right: ProvisioningCaptureFingerprint
): boolean {
  return (
    normalizeFingerprintTitle(left.captureTitle) ===
      normalizeFingerprintTitle(right.captureTitle) &&
    normalizeExecutableName(left.executableName).toLocaleLowerCase() ===
      normalizeExecutableName(right.executableName).toLocaleLowerCase()
  );
}

async function withProvisioningOBSReadiness<T>(
  operation: string,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isOBSProvisioningNotReadyError(error)) {
      throw new GameProvisioningNotReadyError(
        operation +
          " is not ready yet: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
    throw error;
  }
}

async function getProvisioningOBSScenes(): Promise<ProvisioningScene[]> {
  return withProvisioningOBSReadiness(
    "OBS scene enumeration",
    getOBSScenesForSceneSwitcher
  );
}

function requireReadyWindowSceneSwitcherCollection(
  collectionName: string
): WindowSceneSwitcherCollection {
  const config = getWindowSceneSwitcherConfig();
  const collection = config.collections.find(
    (candidate) => candidate.collectionName === collectionName
  );

  if (!collection) {
    throw new GameProvisioningNotReadyError(
      `OBS collection "${collectionName}" has no GSM scene-switcher migration state yet.`
    );
  }
  if (!collection.enabled) {
    throw new Error(
      `Scene switching is disabled for OBS collection "${collectionName}"; refusing to override that setting.`
    );
  }
  if (
    collection.migrationVersion !== WINDOW_SCENE_SWITCHER_MIGRATION_VERSION ||
    !collection.legacySwitcherDisabled
  ) {
    throw new Error(
      `Scene switching for OBS collection "${collectionName}" is not migration-ready.`
    );
  }

  return collection;
}

async function getReadyActiveCollection(): Promise<WindowSceneSwitcherCollection> {
  const collectionName = await withProvisioningOBSReadiness(
    "OBS scene collection lookup",
    getCurrentOBSSceneCollectionName
  );
  if (!collectionName) {
    throw new GameProvisioningNotReadyError(
      "OBS did not report an active scene collection yet."
    );
  }
  return requireReadyWindowSceneSwitcherCollection(collectionName);
}

function chooseSetupCaptureMode(
  selection: ObsSceneCaptureWindowSelection
): ObsSceneCaptureWindowSelection {
  if (
    selection.targetKind === "capture_card" ||
    selection.targetKind === "wayland_pipewire" ||
    selection.captureMode
  ) {
    return selection;
  }

  // Match HomeTab's existing Setup Capture default: prefer Window Capture
  // when OBS exposes it, otherwise fall back to Game Capture.
  const captureMode =
    typeof selection.captureValues?.window_capture === "string"
      ? "window_capture"
      : "game_capture";

  return { ...selection, captureMode };
}

async function prepareExistingProvisionedScene(
  request: GameProvisioningRequest
): Promise<{ scene: ProvisioningScene; changed: boolean } | null> {
  const collection = await getReadyActiveCollection();
  const collectionName = collection.collectionName;
  const scenes = await getProvisioningOBSScenes();
  const externalId = request.externalId?.trim();
  const binding = externalId
    ? getGameProvisioningBinding(externalId, collectionName)
    : null;
  let scene: ProvisioningScene | undefined;

  if (externalId) {
    if (binding) {
      if (binding.sceneId) {
        scene = scenes.find((candidate) => candidate.id === binding.sceneId);
        if (!scene) {
          return null;
        }
      } else {
        const pendingSceneName = binding.sceneName || request.displayName;
        scene = scenes.find((candidate) =>
          sameName(candidate.name, pendingSceneName)
        );
        if (!scene) {
          return null;
        }

        const pendingScene = scene;
        if (!binding.captureTitle?.trim()) {
          throw new Error(
            `Pending provisioning binding for "${externalId}" has no capture fingerprint; refusing to claim same-name scene "${pendingScene.name}".`
          );
        }
        const actualCaptureTitle = await withProvisioningOBSReadiness(
          "OBS pending capture inspection",
          () => getWindowTitleFromSourceForProvisioning(pendingScene.id)
        );
        if (
          !actualCaptureTitle?.trim() ||
          normalizeFingerprintTitle(actualCaptureTitle) !==
            normalizeFingerprintTitle(binding.captureTitle)
        ) {
          throw new Error(
            `Pending provisioning binding for "${externalId}" does not match the capture in same-name scene "${pendingScene.name}"; refusing to claim it.`
          );
        }

        if (binding.executableName?.trim()) {
          const suggestedRule = await withProvisioningOBSReadiness(
            "OBS pending executable inspection",
            () => suggestWindowSceneSwitcherRuleForProvisioning(pendingScene.id)
          );
          const actualExecutable = normalizeExecutableName(
            suggestedRule?.executableName
          ).toLocaleLowerCase();
          const expectedExecutable = normalizeExecutableName(
            binding.executableName
          ).toLocaleLowerCase();
          if (!actualExecutable || actualExecutable !== expectedExecutable) {
            throw new Error(
              `Pending provisioning binding for "${externalId}" does not match the executable in same-name scene "${pendingScene.name}"; refusing to claim it.`
            );
          }
        }
      }
    } else {
      const sameNameScene = scenes.find((candidate) =>
        sameName(candidate.name, request.displayName)
      );
      if (sameNameScene) {
        throw new Error(
          `A scene named "${sameNameScene.name}" already exists but is not bound to external id "${externalId}" in OBS collection "${collectionName}"; refusing to claim or modify it automatically.`
        );
      }
      return null;
    }
  } else {
    scene = scenes.find((candidate) =>
      sameName(candidate.name, request.displayName)
    );
    if (!scene) {
      return null;
    }
  }

  const existingScene = scene;
  const captureTitle = await withProvisioningOBSReadiness(
    "OBS capture inspection",
    () => getWindowTitleFromSourceForProvisioning(existingScene.id)
  );
  if (!captureTitle?.trim()) {
    throw new Error(
      `A scene named "${existingScene.name}" already exists but has no reusable window capture; refusing to rebuild it automatically.`
    );
  }

  const existingRule = collection.rules.find(
    (candidate) => candidate.sceneUuid === existingScene.id
  );

  if (binding?.switchingMode === "launch-pid") {
    if (!request.processId || request.processId <= 0) {
      throw new GameProvisioningNotReadyError(
        `Provisioned game "${existingScene.name}" requires a current launch PID for scene switching.`
      );
    }
    if (existingRule && !existingRule.enabled) {
      throw new Error(
        `The saved scene-switcher rule for "${existingScene.name}" is disabled; refusing to bypass a user-disabled rule with launch-scoped switching.`
      );
    }
    registerLaunchSceneAssociation({
      collectionName,
      externalId: binding.externalId,
      pid: request.processId,
      sceneUuid: existingScene.id,
      sceneName: existingScene.name,
    });
    return { scene: existingScene, changed: false };
  }

  if (existingRule) {
    if (!existingRule.enabled) {
      throw new Error(
        `The saved scene-switcher rule for "${existingScene.name}" is disabled; refusing to re-enable a user-disabled rule automatically.`
      );
    }
    return { scene: existingScene, changed: false };
  }

  const suggestedRule = await withProvisioningOBSReadiness(
    "OBS scene-switcher rule inspection",
    () => suggestWindowSceneSwitcherRuleForProvisioning(existingScene.id)
  );
  if (!suggestedRule?.titlePattern) {
    throw new Error(
      `GSM could not derive a scene-switcher rule for existing scene "${existingScene.name}".`
    );
  }

  upsertGeneratedWindowSceneRule(
    collectionName,
    collection.collectionFileName,
    {
      sceneUuid: existingScene.id,
      sceneName: existingScene.name,
      titlePattern: suggestedRule.titlePattern,
      executableName: suggestedRule.executableName,
    }
  );

  return { scene: existingScene, changed: true };
}

async function createProvisionedScene(
  request: GameProvisioningRequest,
  target: ProvisioningCaptureTarget
): Promise<ProvisioningScene> {
  await getReadyActiveCollection();
  const before = await getProvisioningOBSScenes();
  if (
    before.some((candidate) =>
      sameName(candidate.name, request.displayName)
    )
  ) {
    throw new Error(
      `A scene named "${request.displayName}" already exists; refusing to rebuild its capture sources automatically.`
    );
  }

  const selection = chooseSetupCaptureMode({
    ...target.selection,
    sceneName: request.displayName,
  });

  await withProvisioningOBSReadiness(
    "OBS scene creation",
    () =>
      createSceneWithCapture(selection, {
        persistWindowSceneRule: target.durableSwitcherSafe !== false,
      })
  );

  const scenes = await getProvisioningOBSScenes();
  const createdScene = scenes.find((candidate) =>
    sameName(candidate.name, request.displayName)
  );
  if (!createdScene) {
    throw new Error(
      `GSM created capture for "${request.displayName}" but the scene could not be found afterward.`
    );
  }

  return createdScene;
}

export function createGsmGameProvisioningDependencies(
  resolveCaptureTarget: GameCaptureTargetResolver
): GameProvisioningDependencies {
  return {
    prepareExistingProvisionedScene,
    resolveCaptureTarget,
    createSceneWithCapture: createProvisionedScene,
    getSceneLaunchProfile: async (scene) =>
      getSceneLaunchProfileForScene(scene) as ProvisioningSceneProfile | null,
    upsertSceneLaunchProfile: async (profile) => {
      upsertSceneLaunchProfile(profile);
    },
    reserveProvisioning: async (request, target) => {
      const externalId = request.externalId?.trim();
      if (!externalId) {
        return;
      }

      const collection = await getReadyActiveCollection();
      const fingerprint = getTargetCaptureFingerprint(target);
      const existing = getGameProvisioningBinding(
        externalId,
        collection.collectionName
      );
      if (existing) {
        if (!existing.pending) {
          return;
        }

        if (
          !existing.captureTitle?.trim() ||
          !fingerprintsMatch(
            {
              captureTitle: existing.captureTitle,
              executableName: existing.executableName,
            },
            fingerprint
          )
        ) {
          throw new Error(
            `Pending provisioning ownership for "${externalId}" does not match the newly resolved capture target; refusing to reuse it.`
          );
        }
        return;
      }

      const scenes = await getProvisioningOBSScenes();
      const sameNameScene = scenes.find((candidate) =>
        sameName(candidate.name, request.displayName)
      );
      if (sameNameScene) {
        throw new Error(
          `A scene named "${sameNameScene.name}" appeared before provisioning ownership could be reserved; refusing to claim it automatically.`
        );
      }

      reserveGameProvisioningBinding(
        externalId,
        collection.collectionName,
        request.displayName,
        fingerprint.captureTitle,
        fingerprint.executableName,
        target.durableSwitcherSafe === false ? "launch-pid" : "durable-rule"
      );
    },
    rememberProvisionedScene: async (request, scene, target) => {
      const externalId = request.externalId?.trim();
      if (externalId) {
        const collection = await getReadyActiveCollection();
        const existing = getGameProvisioningBinding(
          externalId,
          collection.collectionName
        );
        const switchingMode =
          target?.durableSwitcherSafe === false
            ? "launch-pid"
            : existing?.switchingMode ?? "durable-rule";

        if (switchingMode === "launch-pid") {
          upsertGameProvisioningBinding(
            externalId,
            collection.collectionName,
            scene,
            switchingMode
          );
        } else {
          upsertGameProvisioningBinding(
            externalId,
            collection.collectionName,
            scene
          );
        }

        if (switchingMode === "launch-pid") {
          if (!request.processId || request.processId <= 0) {
            throw new GameProvisioningNotReadyError(
              `Provisioned game "${scene.name}" requires a current launch PID for scene switching.`
            );
          }
          registerLaunchSceneAssociation({
            collectionName: collection.collectionName,
            externalId,
            pid: request.processId,
            sceneUuid: scene.id,
            sceneName: scene.name,
          });
        }
      }
    },
  };
}

/**
 * GSM-native Phase 2 entry point.
 *
 * The caller supplies only an internal capture-target resolver. Transport
 * (Playnite, CLI, IPC, etc.) is intentionally not part of this layer.
 */
export async function ensureGameProvisionedWithGsm(
  request: GameProvisioningRequest,
  resolveCaptureTarget: GameCaptureTargetResolver
): Promise<GameProvisioningResult> {
  return ensureGameProvisioned(
    request,
    createGsmGameProvisioningDependencies(resolveCaptureTarget)
  );
}
