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
  getWindowTitleFromSource,
  isOBSProvisioningNotReadyError,
  suggestWindowSceneSwitcherRule,
} from "../ui/obs.js";
import type { ObsSceneCaptureWindowSelection } from "../ui/obs-capture.js";
import {
  WINDOW_SCENE_SWITCHER_MIGRATION_VERSION,
  type WindowSceneSwitcherCollection,
} from "../../shared/window_scene_switcher.js";
import { upsertGeneratedWindowSceneRule } from "./window_scene_switcher.js";
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
  let scene: ProvisioningScene | undefined;

  if (externalId) {
    const binding = getGameProvisioningBinding(externalId, collectionName);
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

  const captureTitle = await withProvisioningOBSReadiness(
    "OBS capture inspection",
    () => getWindowTitleFromSource(scene.id)
  );
  if (!captureTitle?.trim()) {
    throw new Error(
      `A scene named "${scene.name}" already exists but has no reusable window capture; refusing to rebuild it automatically.`
    );
  }

  const existingRule = collection.rules.find(
    (candidate) => candidate.sceneUuid === scene.id
  );
  if (existingRule) {
    if (!existingRule.enabled) {
      throw new Error(
        `The saved scene-switcher rule for "${scene.name}" is disabled; refusing to re-enable a user-disabled rule automatically.`
      );
    }
    return { scene, changed: false };
  }

  const suggestedRule = await withProvisioningOBSReadiness(
    "OBS scene-switcher rule inspection",
    () => suggestWindowSceneSwitcherRule(scene.id)
  );
  if (!suggestedRule?.titlePattern) {
    throw new Error(
      `GSM could not derive a scene-switcher rule for existing scene "${scene.name}".`
    );
  }

  upsertGeneratedWindowSceneRule(
    collectionName,
    collection.collectionFileName,
    {
      sceneUuid: scene.id,
      sceneName: scene.name,
      titlePattern: suggestedRule.titlePattern,
      executableName: suggestedRule.executableName,
    }
  );

  return { scene, changed: true };
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
    () => createSceneWithCapture(selection)
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
    reserveProvisioning: async (request) => {
      const externalId = request.externalId?.trim();
      if (!externalId) {
        return;
      }

      const collection = await getReadyActiveCollection();
      const existing = getGameProvisioningBinding(
        externalId,
        collection.collectionName
      );
      if (existing) {
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
        request.displayName
      );
    },
    rememberProvisionedScene: async (request, scene) => {
      const externalId = request.externalId?.trim();
      if (externalId) {
        const collection = await getReadyActiveCollection();
        upsertGameProvisioningBinding(
          externalId,
          collection.collectionName,
          scene
        );
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
