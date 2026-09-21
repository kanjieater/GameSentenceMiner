import { describe, expect, it, vi } from "vitest";

import {
  ensureGameProvisioned,
  type GameProvisioningDependencies,
  type GameProvisioningRequest,
  type ProvisioningCaptureTarget,
  type ProvisioningScene,
  type ProvisioningSceneProfile,
} from "./game_provisioning.js";

const request: GameProvisioningRequest = {
  displayName: "Arc the Lad II",
  processId: 12345,
};

const target: ProvisioningCaptureTarget = {
  title: "Arc the Lad II - RetroArch",
  selection: {
    title: "Arc the Lad II - RetroArch",
    sceneName: "Arc the Lad II",
    targetKind: "window",
    captureMode: "window_capture",
    captureValues: {
      window_capture: "Arc the Lad II - RetroArch:Qt6QWindowIcon:retroarch.exe",
      game_capture: "Arc the Lad II - RetroArch:Qt6QWindowIcon:retroarch.exe",
    },
  },
};

const scene: ProvisioningScene = {
  id: "scene-arc",
  name: "Arc the Lad II",
};

function autoOcrProfile(
  overrides: Partial<ProvisioningSceneProfile> = {}
): ProvisioningSceneProfile {
  return {
    sceneId: scene.id,
    sceneName: scene.name,
    textHookMode: "none",
    ocrMode: "auto",
    launchOverlay: false,
    agentScriptPath: "",
    launchDelaySeconds: 0,
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<GameProvisioningDependencies> = {}
): GameProvisioningDependencies {
  return {
    prepareExistingProvisionedScene: vi.fn(async () => null),
    resolveCaptureTarget: vi.fn(async () => ({ status: "resolved", target })),
    createSceneWithCapture: vi.fn(async () => scene),
    getSceneLaunchProfile: vi.fn(async () => null),
    upsertSceneLaunchProfile: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("game provisioning core", () => {
  it("creates a new capture and saves the generic auto-OCR profile", async () => {
    const dependencies = makeDependencies();

    const result = await ensureGameProvisioned(request, dependencies);

    expect(result).toEqual({
      status: "provisioned",
      scene,
      createdScene: true,
      updatedProfile: true,
    });
    expect(dependencies.resolveCaptureTarget).toHaveBeenCalledWith(request);
    expect(dependencies.createSceneWithCapture).toHaveBeenCalledWith(request, target);
    expect(dependencies.upsertSceneLaunchProfile).toHaveBeenCalledWith(
      autoOcrProfile()
    );
  });

  it("short-circuits an already-correct provisioned game before target resolution", async () => {
    const dependencies = makeDependencies({
      prepareExistingProvisionedScene: vi.fn(async () => ({ scene, changed: false })),
      getSceneLaunchProfile: vi.fn(async () => autoOcrProfile()),
    });

    const result = await ensureGameProvisioned(request, dependencies);

    expect(result).toEqual({
      status: "already-configured",
      scene,
      createdScene: false,
      updatedProfile: false,
    });
    expect(dependencies.resolveCaptureTarget).not.toHaveBeenCalled();
    expect(dependencies.createSceneWithCapture).not.toHaveBeenCalled();
    expect(dependencies.upsertSceneLaunchProfile).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated calls once the first call provisions the game", async () => {
    let existingScene: ProvisioningScene | null = null;
    let profile: ProvisioningSceneProfile | null = null;
    const createSceneWithCapture = vi.fn(async () => {
      existingScene = scene;
      return scene;
    });
    const dependencies = makeDependencies({
      prepareExistingProvisionedScene: vi.fn(async () =>
        existingScene ? { scene: existingScene, changed: false } : null
      ),
      createSceneWithCapture,
      getSceneLaunchProfile: vi.fn(async () => profile),
      upsertSceneLaunchProfile: vi.fn(async (next) => {
        profile = next;
      }),
    });

    const first = await ensureGameProvisioned(request, dependencies);
    const second = await ensureGameProvisioned(request, dependencies);

    expect(first.status).toBe("provisioned");
    expect(second.status).toBe("already-configured");
    expect(createSceneWithCapture).toHaveBeenCalledTimes(1);
  });

  it("fails closed when capture resolution is ambiguous", async () => {
    const dependencies = makeDependencies({
      resolveCaptureTarget: vi.fn(async () => ({
        status: "ambiguous",
        reason: "Multiple RetroArch windows matched.",
      })),
    });

    const result = await ensureGameProvisioned(request, dependencies);

    expect(result).toEqual({
      status: "ambiguous-target",
      reason: "Multiple RetroArch windows matched.",
    });
    expect(dependencies.createSceneWithCapture).not.toHaveBeenCalled();
    expect(dependencies.upsertSceneLaunchProfile).not.toHaveBeenCalled();
  });

  it("reports a not-ready target without mutating anything", async () => {
    const dependencies = makeDependencies({
      resolveCaptureTarget: vi.fn(async () => ({
        status: "not-ready",
        reason: "The game window is not available yet.",
      })),
    });

    const result = await ensureGameProvisioned(request, dependencies);

    expect(result).toEqual({
      status: "target-not-ready",
      reason: "The game window is not available yet.",
    });
    expect(dependencies.createSceneWithCapture).not.toHaveBeenCalled();
    expect(dependencies.upsertSceneLaunchProfile).not.toHaveBeenCalled();
  });

  it("reports unsupported targets without mutating anything", async () => {
    const dependencies = makeDependencies({
      resolveCaptureTarget: vi.fn(async () => ({
        status: "unsupported",
        reason: "This capture target is not supported.",
      })),
    });

    const result = await ensureGameProvisioned(request, dependencies);

    expect(result).toEqual({
      status: "unsupported-target",
      reason: "This capture target is not supported.",
    });
    expect(dependencies.createSceneWithCapture).not.toHaveBeenCalled();
    expect(dependencies.upsertSceneLaunchProfile).not.toHaveBeenCalled();
  });

  it("preserves unrelated automation settings when only auto OCR is missing", async () => {
    const existingProfile = autoOcrProfile({
      textHookMode: "textractor",
      ocrMode: "none",
      launchOverlay: true,
      agentScriptPath: "C:\\scripts\\existing.js",
      launchDelaySeconds: 1.5,
    });
    const dependencies = makeDependencies({
      prepareExistingProvisionedScene: vi.fn(async () => ({ scene, changed: false })),
      getSceneLaunchProfile: vi.fn(async () => existingProfile),
    });

    const result = await ensureGameProvisioned(request, dependencies);

    expect(result).toEqual({
      status: "provisioned",
      scene,
      createdScene: false,
      updatedProfile: true,
    });
    expect(dependencies.resolveCaptureTarget).not.toHaveBeenCalled();
    expect(dependencies.upsertSceneLaunchProfile).toHaveBeenCalledWith({
      ...existingProfile,
      ocrMode: "auto",
    });
  });
});
