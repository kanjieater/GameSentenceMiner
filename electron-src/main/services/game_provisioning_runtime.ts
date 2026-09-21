import {
  getGameProvisioningBinding,
  getSceneLaunchProfileForScene,
  getWindowSceneSwitcherConfig,
  upsertGameProvisioningBinding,
  upsertSceneLaunchProfile,
} from "../store.js";
import {
  createSceneWithCapture,
  getCurrentOBSSceneCollectionName,
  getOBSScenesForSceneSwitcher,
  getWindowTitleFromSource,
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

function requireReadyWindowSceneSwitcherCollection(
  collectionName: string
): WindowSceneSwitcherCollection {
  const config = getWindowSceneSwitcherConfig();
  const collection = config.collections.find(
    (candidate) => candidate.collectionName === collectionName
  );

  if (!collection) {
    throw new Error(
      `OBS collection "${collectionName}" has no GSM scene-switcher migration state; refusing to provision until migration completes.`
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
  const collectionName = await getCurrentOBSSceneCollectionName();
  if (!collectionName) {
    throw new Error("OBS did not report an active scene collection.");
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
  const scenes = await getOBSScenesForSceneSwitcher();
  const externalId = request.externalId?.trim();
  let scene: ProvisioningScene | undefined;

  if (externalId) {
    const binding = getGameProvisioningBinding(externalId);
    if (binding) {
      scene = scenes.find((candidate) => candidate.id === binding.sceneId);
      if (!scene) {
        return null;
      }
    } else {
      const sameNameScene = scenes.find((candidate) =>
        sameName(candidate.name, request.displayName)
      );
      if (sameNameScene) {
        throw new Error(
          `A scene named "${sameNameScene.name}" already exists but is not bound to external id "${externalId}"; refusing to claim or modify it automatically.`
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

  const captureTitle = await getWindowTitleFromSource(scene.id);
  if (!captureTitle?.trim()) {
    throw new Error(
      `A scene named "${scene.name}" already exists but has no reusable window capture; refusing to rebuild it automatically.`
    );
  }

  const collection = await getReadyActiveCollection();
  const collectionName = collection.collectionName;

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

  const suggestedRule = await suggestWindowSceneSwitcherRule(scene.id);
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
  const before = await getOBSScenesForSceneSwitcher();
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

  await createSceneWithCapture(selection);

  const scenes = await getOBSScenesForSceneSwitcher();
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
    rememberProvisionedScene: async (request, scene) => {
      const externalId = request.externalId?.trim();
      if (externalId) {
        upsertGameProvisioningBinding(externalId, scene);
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
