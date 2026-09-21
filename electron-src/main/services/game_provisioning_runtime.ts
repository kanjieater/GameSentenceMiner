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
} from "../ui/obs.js";
import type { ObsSceneCaptureWindowSelection } from "../ui/obs-capture.js";
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
  return left.trim().localeCompare(right.trim(), undefined, {
    sensitivity: "accent",
  }) === 0;
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

async function findExistingProvisionedScene(
  request: GameProvisioningRequest
): Promise<ProvisioningScene | null> {
  const scenes = await getOBSScenes();
  const scene = scenes.find((candidate) =>
    sameName(candidate.name, request.displayName)
  );
  if (!scene) {
    return null;
  }

  const collectionName = await getCurrentOBSSceneCollectionName();
  const config = getWindowSceneSwitcherConfig();
  const collection = config.collections.find(
    (candidate) => candidate.collectionName === collectionName
  );
  const rule = collection?.rules.find(
    (candidate) =>
      candidate.enabled &&
      candidate.sceneUuid === scene.id
  );
  if (!rule) {
    return null;
  }

  // A matching rule without an actual window capture is not fully provisioned.
  const captureTitle = await getWindowTitleFromSource(scene.id);
  if (!captureTitle?.trim()) {
    return null;
  }

  return scene;
}

async function createProvisionedScene(
  request: GameProvisioningRequest,
  target: ProvisioningCaptureTarget
): Promise<ProvisioningScene> {
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
    findExistingProvisionedScene,
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
