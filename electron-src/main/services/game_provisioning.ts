import type { ObsSceneCaptureWindowSelection } from "../ui/obs-capture.js";

export class GameProvisioningNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameProvisioningNotReadyError";
  }
}

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
  /**
   * False when the current launch is identified safely by exact PID/window/executable
   * evidence, but the discovered title/executable is too generic to persist as a
   * durable scene-switcher rule (for example, a shared emulator window title).
   */
  durableSwitcherSafe?: boolean;
  /** Actual foreground PID proven to belong to this Playnite launch. */
  launchProcessId?: number;
}

export interface ExistingProvisioningState {
  scene: ProvisioningScene;
  changed: boolean;
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
  ): Promise<ExistingProvisioningState | null>;

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

  /**
   * Persist a recoverable ownership reservation before creating a new scene.
   * Implementations should no-op when the request has no externalId.
   */
  reserveProvisioning(
    request: GameProvisioningRequest,
    target: ProvisioningCaptureTarget
  ): Promise<void> | void;

  /**
   * Persist or refresh durable caller identity for this scene. Implementations
   * should no-op when the request has no externalId.
   */
  rememberProvisionedScene(
    request: GameProvisioningRequest,
    scene: ProvisioningScene,
    target?: ProvisioningCaptureTarget
  ): Promise<void> | void;
}

function buildGenericAutoOcrProfile(
  scene: ProvisioningScene
): ProvisioningSceneProfile {
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
  if (reason instanceof GameProvisioningNotReadyError) {
    return {
      status: "target-not-ready",
      reason: reason.message,
    };
  }

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
    const existingState =
      await dependencies.prepareExistingProvisionedScene(normalizedRequest);

    if (existingState) {
      const existingScene = existingState.scene;

      // Finalize a pending durable identity before any later fallible profile
      // work so retries can always recognize integration-owned state.
      await dependencies.rememberProvisionedScene(
        normalizedRequest,
        existingScene
      );

      const existingProfile =
        await dependencies.getSceneLaunchProfile(existingScene);

      // Any existing Game Automation profile is user-owned configuration.
      // Provisioning may repair scene/rule plumbing, but it must not silently
      // replace explicit OCR/text-hook choices.
      if (existingProfile) {
        return {
          status: existingState.changed ? "provisioned" : "already-configured",
          scene: existingScene,
          createdScene: false,
          updatedProfile: false,
        };
      }

      await dependencies.upsertSceneLaunchProfile(
        buildGenericAutoOcrProfile(existingScene)
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

    // Reserve durable ownership before the first scene mutation. If any later
    // write fails, a retry can safely recognize and finish this provisioning
    // attempt instead of treating its own same-name scene as a user collision.
    await dependencies.reserveProvisioning(
      normalizedRequest,
      resolution.target
    );

    const createdScene = await dependencies.createSceneWithCapture(
      normalizedRequest,
      resolution.target
    );

    // Finalize the durable identity before profile mutation so profile failures
    // remain recoverable on the next call.
    await dependencies.rememberProvisionedScene(
      normalizedRequest,
      createdScene,
      resolution.target
    );

    const existingProfile =
      await dependencies.getSceneLaunchProfile(createdScene);
    const needsProfileUpdate = existingProfile === null;

    if (needsProfileUpdate) {
      await dependencies.upsertSceneLaunchProfile(
        buildGenericAutoOcrProfile(createdScene)
      );
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
