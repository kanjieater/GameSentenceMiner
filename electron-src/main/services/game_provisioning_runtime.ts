import {
  getSceneLaunchProfileForScene,
  getWindowSceneSwitcherConfig,
  upsertSceneLaunchProfile,
} from "../store.js";
import {
  createSceneWithCapture,
  getCurrentOBSSceneCollectionName,
  getOBSScenes,
  getWindowTitleFromSource,
  suggestWindowSceneSwitcherRule,
} from "../ui/obs.js";
import type { ObsSceneCaptureWindowSelection } from "../ui/obs-capture.js";
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
): Promise<ProvisioningScene | null> {
  const scenes = await getOBSScenes();
  const scene = scenes.find((candidate) =>
    sameName(candidate.name, request.displayName)
  );
  if (!scene) {
    return null;
  }

  const captureTitle = await getWindowTitleFromSource(scene.id);
  if (!captureTitle?.trim()) {
    throw new Error(
      `A scene named "${scene.name}" already exists but has no reusable window capture; refusing to rebuild it automatically.`
    );
  }

  const collectionName = await getCurrentOBSSceneCollectionName();
  if (!collectionName) {
    throw new Error("OBS did not report an active scene collection.");
  }

  const config = getWindowSceneSwitcherConfig();
  const collection = config.collections.find(
    (candidate) => candidate.collectionName === collectionName
  );

  if (collection && !collection.enabled) {
    throw new Error(
      `Scene switching is disabled for OBS collection "${collectionName}"; refusing to override that setting.`
    );
  }
  if (collection && !collection.legacySwitcherDisabled) {
    throw new Error(
      `Scene switching for OBS collection "${collectionName}" is not migration-ready.`
    );
  }

  const existingRule = collection?.rules.find(
    (candidate) => candidate.sceneUuid === scene.id
  );
  if (existingRule) {
    if (!existingRule.enabled) {
      throw new Error(
        `The saved scene-switcher rule for "${scene.name}" is disabled; refusing to re-enable a user-disabled rule automatically.`
      );
    }
    return scene;
  }

  const suggestedRule = await suggestWindowSceneSwitcherRule(scene.id);
  if (!suggestedRule?.titlePattern) {
    throw new Error(
      `GSM could not derive a scene-switcher rule for existing scene "${scene.name}".`
    );
  }

  upsertGeneratedWindowSceneRule(
    collectionName,
    collection?.collectionFileName ??
      `${collectionName.replace(/\\s+/g, "_")}.json`,
    {
      sceneUuid: scene.id,
      sceneName: scene.name,
      titlePattern: suggestedRule.titlePattern,
      executableName: suggestedRule.executableName,
    }
  );

  return scene;
}

async function createProvisionedScene(
  request: GameProvisioningRequest,
  target: ProvisioningCaptureTarget
): Promise<ProvisioningScene> {
  const before = await getOBSScenes();
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

  const scenes = await getOBSScenes();
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
