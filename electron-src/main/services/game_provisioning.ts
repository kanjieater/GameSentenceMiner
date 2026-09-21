import type { ObsSceneCaptureWindowSelection } from "../ui/obs-capture.js";

export interface GameProvisioningRequest {
  displayName: string;
  processId?: number;
  externalId?: string;
  defaultMode?: "ocr";
}

export interface ProvisioningScene {
  id: string;
  name: string;
}

export interface ProvisioningSceneProfile {
  sceneId?: string;
  sceneName: string;
  textHookMode: "none" | "agent" | "textractor" | "luna";
  ocrMode: "none" | "auto" | "manual";
  launchOverlay: boolean;
  agentScriptPath: string;
  launchDelaySeconds: number;
}

export interface ProvisioningCaptureTarget {
  title: string;
  selection: ObsSceneCaptureWindowSelection;
}

export type CaptureTargetResolution =
  | { status: "resolved"; target: ProvisioningCaptureTarget }
  | { status: "not-ready"; reason?: string }
  | { status: "ambiguous"; reason?: string }
  | { status: "unsupported"; reason?: string };

export type GameProvisioningResult =
  | {
      status: "already-configured" | "provisioned";
      scene: ProvisioningScene;
      createdScene: boolean;
      updatedProfile: boolean;
    }
  | {
      status:
        | "target-not-ready"
        | "ambiguous-target"
        | "unsupported-target"
        | "failed";
      reason?: string;
    };

export interface GameProvisioningDependencies {
  /**
   * Reuse a compatible existing scene and ensure it is safe for recurring
   * automation. Runtime bindings may repair missing GSM-generated rule state,
   * but must fail closed rather than overwrite conflicting/user-disabled state.
   *
   * Returning a scene lets this core short-circuit before target resolution.
   */
  prepareExistingProvisionedScene(
    request: GameProvisioningRequest
  ): Promise<ProvisioningScene | null>;

  /**
   * Resolve the current game to exactly one GSM/OBS capture target.
   * Ambiguous matches must be reported rather than guessed.
   */
  resolveCaptureTarget(
    request: GameProvisioningRequest
  ): Promise<CaptureTargetResolution>;

  /**
   * Reuse GSM's existing createSceneWithCapture path. Implementations must call
   * this only for a genuinely new target because the legacy helper may rebuild
   * sources when the named scene already exists.
   */
  createSceneWithCapture(
    request: GameProvisioningRequest,
    target: ProvisioningCaptureTarget
  ): Promise<ProvisioningScene>;

  getSceneLaunchProfile(
    scene: ProvisioningScene
  ): Promise<ProvisioningSceneProfile | null>;

  upsertSceneLaunchProfile(profile: ProvisioningSceneProfile): Promise<void> | void;
}

function profileAlreadyHasGenericBaseline(
  scene: ProvisioningScene,
  profile: ProvisioningSceneProfile | null
): boolean {
  return Boolean(
    profile &&
      profile.sceneName === scene.name &&
      (!profile.sceneId || profile.sceneId === scene.id) &&
      profile.ocrMode === "auto"
  );
}

function buildGenericAutoOcrProfile(
  scene: ProvisioningScene,
  existing: ProvisioningSceneProfile | null
): ProvisioningSceneProfile {
  if (existing) {
    return {
      ...existing,
      sceneId: scene.id,
      sceneName: scene.name,
      ocrMode: "auto",
    };
  }

  return {
    sceneId: scene.id,
    sceneName: scene.name,
    textHookMode: "none",
    ocrMode: "auto",
    launchOverlay: false,
    agentScriptPath: "",
    launchDelaySeconds: 0,
  };
}

function failed(reason: unknown): GameProvisioningResult {
  return {
    status: "failed",
    reason: reason instanceof Error ? reason.message : String(reason),
  };
}

/**
 * Ensure GSM has the minimum reusable setup for a game:
 *
 * - an existing provisioned scene is reused without touching capture sources;
 * - a new target delegates scene/capture/rule creation to GSM's existing path;
 * - generic newly provisioned games receive auto OCR;
 * - unrelated existing Game Automation settings are preserved;
 * - capture ambiguity/not-ready states fail closed.
 *
 * Transport and Playnite-specific identity resolution intentionally live
 * outside this core.
 */
export async function ensureGameProvisioned(
  request: GameProvisioningRequest,
  dependencies: GameProvisioningDependencies
): Promise<GameProvisioningResult> {
  const displayName = request.displayName?.trim();
  if (!displayName) {
    return { status: "failed", reason: "A game display name is required." };
  }

  const normalizedRequest: GameProvisioningRequest = {
    ...request,
    displayName,
  };

  try {
    const existingScene =
      await dependencies.prepareExistingProvisionedScene(normalizedRequest);

    if (existingScene) {
      const existingProfile =
        await dependencies.getSceneLaunchProfile(existingScene);

      if (profileAlreadyHasGenericBaseline(existingScene, existingProfile)) {
        return {
          status: "already-configured",
          scene: existingScene,
          createdScene: false,
          updatedProfile: false,
        };
      }

      await dependencies.upsertSceneLaunchProfile(
        buildGenericAutoOcrProfile(existingScene, existingProfile)
      );

      return {
        status: "provisioned",
        scene: existingScene,
        createdScene: false,
        updatedProfile: true,
      };
    }

    const resolution =
      await dependencies.resolveCaptureTarget(normalizedRequest);

    if (resolution.status === "not-ready") {
      return {
        status: "target-not-ready",
        reason: resolution.reason,
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        status: "ambiguous-target",
        reason: resolution.reason,
      };
    }
    if (resolution.status === "unsupported") {
      return {
        status: "unsupported-target",
        reason: resolution.reason,
      };
    }

    const createdScene = await dependencies.createSceneWithCapture(
      normalizedRequest,
      resolution.target
    );
    const existingProfile =
      await dependencies.getSceneLaunchProfile(createdScene);
    const desiredProfile = buildGenericAutoOcrProfile(
      createdScene,
      existingProfile
    );
    const needsProfileUpdate = !profileAlreadyHasGenericBaseline(
      createdScene,
      existingProfile
    );

    if (needsProfileUpdate) {
      await dependencies.upsertSceneLaunchProfile(desiredProfile);
    }

    return {
      status: "provisioned",
      scene: createdScene,
      createdScene: true,
      updatedProfile: needsProfileUpdate,
    };
  } catch (error) {
    return failed(error);
  }
}
