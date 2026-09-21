import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GameProvisioningRequest } from "./game_provisioning.js";

const scene = { id: "scene-arc", name: "Arc the Lad II" };
function readySwitcherConfig(rules: any[] = []) {
  return {
    schemaVersion: 1,
    collections: [
      {
        collectionName: "Default",
        collectionFileName: "Default.json",
        enabled: true,
        migrationVersion: 1,
        legacySwitcherDisabled: true,
        rules,
      },
    ],
  };
}

let scenes: Array<{ id: string; name: string }> = [];
let profile: any = null;
let binding: any = null;
let collectionName = "Default";
let switcherConfig: any = readySwitcherConfig();

const mocks = vi.hoisted(() => ({
  getOBSScenesForSceneSwitcher: vi.fn(),
  createSceneWithCapture: vi.fn(),
  getCurrentOBSSceneCollectionName: vi.fn(),
  getWindowTitleFromSource: vi.fn(),
  suggestWindowSceneSwitcherRule: vi.fn(),
  upsertGeneratedWindowSceneRule: vi.fn(),
  upsertSceneLaunchProfile: vi.fn(),
  getGameProvisioningBinding: vi.fn(),
  getSceneLaunchProfileForScene: vi.fn(),
  getWindowSceneSwitcherConfig: vi.fn(),
  upsertGameProvisioningBinding: vi.fn(),
}));

vi.mock("../ui/obs.js", () => ({
  createSceneWithCapture: mocks.createSceneWithCapture,
  getOBSScenesForSceneSwitcher: mocks.getOBSScenesForSceneSwitcher,
  getCurrentOBSSceneCollectionName: mocks.getCurrentOBSSceneCollectionName,
  getWindowTitleFromSource: mocks.getWindowTitleFromSource,
  suggestWindowSceneSwitcherRule: mocks.suggestWindowSceneSwitcherRule,
}));

vi.mock("./window_scene_switcher.js", () => ({
  upsertGeneratedWindowSceneRule: mocks.upsertGeneratedWindowSceneRule,
}));

vi.mock("../store.js", () => ({
  getGameProvisioningBinding: mocks.getGameProvisioningBinding,
  getSceneLaunchProfileForScene: mocks.getSceneLaunchProfileForScene,
  getWindowSceneSwitcherConfig: mocks.getWindowSceneSwitcherConfig,
  upsertGameProvisioningBinding: mocks.upsertGameProvisioningBinding,
  upsertSceneLaunchProfile: mocks.upsertSceneLaunchProfile,
}));

async function loadRuntime() {
  vi.resetModules();
  return import("./game_provisioning_runtime.js");
}

const request: GameProvisioningRequest = {
  displayName: "Arc the Lad II",
  processId: 12345,
};

const externalRequest: GameProvisioningRequest = {
  displayName: "Arc the Lad II",
  processId: 12345,
  externalId: "playnite:arc-the-lad-ii",
};

describe("GSM game provisioning runtime binding", () => {
  beforeEach(() => {
    scenes = [];
    profile = null;
    binding = null;
    collectionName = "Default";
    switcherConfig = readySwitcherConfig();
    vi.clearAllMocks();
    mocks.getOBSScenesForSceneSwitcher.mockImplementation(async () => scenes);
    mocks.createSceneWithCapture.mockImplementation(async () => {
      scenes = [scene];
    });
    mocks.getCurrentOBSSceneCollectionName.mockImplementation(
      async () => collectionName
    );
    mocks.getWindowTitleFromSource.mockImplementation(
      async () => "Arc the Lad II - RetroArch"
    );
    mocks.suggestWindowSceneSwitcherRule.mockImplementation(async () => ({
      titlePattern: ".*Arc the Lad II.*",
      executableName: "retroarch.exe",
    }));
    mocks.upsertSceneLaunchProfile.mockImplementation((next: any) => {
      profile = next;
    });
    mocks.getGameProvisioningBinding.mockImplementation(
      (externalId: string) =>
        binding?.externalId === externalId ? binding : null
    );
    mocks.getSceneLaunchProfileForScene.mockImplementation(() => profile);
    mocks.getWindowSceneSwitcherConfig.mockImplementation(
      () => switcherConfig
    );
    mocks.upsertGameProvisioningBinding.mockImplementation(
      (externalId: string, boundScene: { id: string; name: string }) => {
        binding = {
          externalId,
          sceneId: boundScene.id,
          sceneName: boundScene.name,
        };
      }
    );
  });

  it("reuses an existing scene only when the active collection has an enabled rule", async () => {
    scenes = [scene];
    profile = {
      sceneId: scene.id,
      sceneName: scene.name,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    };
    switcherConfig = {
      schemaVersion: 1,
      collections: [
        {
          collectionName: "Default",
          collectionFileName: "Default.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [
            {
              sceneUuid: scene.id,
              sceneName: scene.name,
              titlePattern: ".*Arc the Lad II.*",
              executableName: "retroarch.exe",
              enabled: true,
              source: "gsm-generated",
            },
          ],
        },
      ],
    };
    const resolver = vi.fn(async () => ({
      status: "not-ready" as const,
      reason: "should not run",
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result.status).toBe("already-configured");
    expect(resolver).not.toHaveBeenCalled();
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("repairs a missing generated rule for a compatible existing capture", async () => {
    scenes = [scene];
    profile = {
      sceneId: scene.id,
      sceneName: scene.name,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    };
    switcherConfig = {
      schemaVersion: 1,
      collections: [
        {
          collectionName: "Default",
          collectionFileName: "Default.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [],
        },
      ],
    };
    const resolver = vi.fn(async () => ({
      status: "not-ready" as const,
      reason: "should not run",
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result.status).toBe("provisioned");
    expect(resolver).not.toHaveBeenCalled();
    expect(upsertGeneratedWindowSceneRule).toHaveBeenCalledWith(
      "Default",
      "Default.json",
      {
        sceneUuid: scene.id,
        sceneName: scene.name,
        titlePattern: ".*Arc the Lad II.*",
        executableName: "retroarch.exe",
      }
    );
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("fails closed instead of re-enabling a user-disabled rule", async () => {
    scenes = [scene];
    switcherConfig = {
      schemaVersion: 1,
      collections: [
        {
          collectionName: "Default",
          collectionFileName: "Default.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [
            {
              sceneUuid: scene.id,
              sceneName: scene.name,
              titlePattern: ".*Arc the Lad II.*",
              executableName: "retroarch.exe",
              enabled: false,
              source: "gsm-generated",
            },
          ],
        },
      ],
    };
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: { title: "Arc the Lad II - RetroArch" },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result.status).toBe("failed");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("user-disabled"),
      })
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("fails closed on an unbound same-name scene when external identity is supplied", async () => {
    scenes = [scene];
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: { title: "Arc the Lad II - RetroArch" },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(result.status).toBe("failed");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("is not bound to external id"),
      })
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(createSceneWithCapture).not.toHaveBeenCalled();
    expect(upsertSceneLaunchProfile).not.toHaveBeenCalled();
  });

  it("follows an external-id binding across a scene rename", async () => {
    const renamedScene = { id: scene.id, name: "Arc the Lad II Renamed" };
    scenes = [renamedScene];
    binding = {
      externalId: externalRequest.externalId,
      sceneId: scene.id,
      sceneName: scene.name,
    };
    profile = {
      sceneId: renamedScene.id,
      sceneName: renamedScene.name,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    };
    switcherConfig = readySwitcherConfig([
      {
        sceneUuid: renamedScene.id,
        sceneName: renamedScene.name,
        titlePattern: ".*Arc the Lad II.*",
        executableName: "retroarch.exe",
        enabled: true,
        source: "gsm-generated",
      },
    ]);
    const resolver = vi.fn(async () => ({
      status: "not-ready" as const,
      reason: "should not run",
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(result.status).toBe("already-configured");
    expect(resolver).not.toHaveBeenCalled();
    expect(upsertGameProvisioningBinding).toHaveBeenCalledWith(
      externalRequest.externalId,
      renamedScene
    );
  });

  it("reuses an external-id binding without a live PID/window lookup", async () => {
    scenes = [scene];
    binding = {
      externalId: "playnite:arc-the-lad-ii",
      sceneId: scene.id,
      sceneName: scene.name,
    };
    profile = {
      sceneId: scene.id,
      sceneName: scene.name,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    };
    switcherConfig = readySwitcherConfig([
      {
        sceneUuid: scene.id,
        sceneName: scene.name,
        titlePattern: ".*Arc the Lad II.*",
        executableName: "retroarch.exe",
        enabled: true,
        source: "gsm-generated",
      },
    ]);
    const requestWithoutRuntimeIdentity: GameProvisioningRequest = {
      displayName: "Arc the Lad II",
      externalId: "playnite:arc-the-lad-ii",
    };
    const resolver = vi.fn(async () => ({
      status: "not-ready" as const,
      reason: "no live process/window",
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(
      requestWithoutRuntimeIdentity,
      resolver
    );

    expect(result.status).toBe("already-configured");
    expect(resolver).not.toHaveBeenCalled();
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("fails closed when the active collection has no switcher migration state", async () => {
    switcherConfig = {
      schemaVersion: 1,
      collections: [],
    };
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: { title: "Arc the Lad II - RetroArch" },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result.status).toBe("failed");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("no GSM scene-switcher migration state"),
      })
    );
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("fails closed when the active collection has a stale migration version", async () => {
    switcherConfig = readySwitcherConfig();
    switcherConfig.collections[0].migrationVersion = 0;
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: { title: "Arc the Lad II - RetroArch" },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result.status).toBe("failed");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("not migration-ready"),
      })
    );
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("fails closed when strict OBS scene enumeration fails", async () => {
    scenes = [scene];
    getOBSScenesForSceneSwitcher.mockRejectedValueOnce(
      new Error("OBS scene enumeration failed")
    );
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: { title: "Arc the Lad II - RetroArch" },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result).toEqual({
      status: "failed",
      reason: "OBS scene enumeration failed",
    });
    expect(createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("uses the existing Setup Capture default and creates a new auto-OCR scene", async () => {
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: {
          title: "Arc the Lad II - RetroArch",
          targetKind: "window" as const,
          captureValues: {
            window_capture:
              "Arc the Lad II - RetroArch:Qt6QWindowIcon:retroarch.exe",
            game_capture:
              "Arc the Lad II - RetroArch:Qt6QWindowIcon:retroarch.exe",
          },
        },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(result).toEqual({
      status: "provisioned",
      scene,
      createdScene: true,
      updatedProfile: true,
    });
    expect(createSceneWithCapture).toHaveBeenCalledWith({
      title: "Arc the Lad II - RetroArch",
      sceneName: "Arc the Lad II",
      targetKind: "window",
      captureMode: "window_capture",
      captureValues: {
        window_capture:
          "Arc the Lad II - RetroArch:Qt6QWindowIcon:retroarch.exe",
        game_capture:
          "Arc the Lad II - RetroArch:Qt6QWindowIcon:retroarch.exe",
      },
    });
    expect(upsertSceneLaunchProfile).toHaveBeenCalledWith({
      sceneId: scene.id,
      sceneName: scene.name,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    });
    expect(upsertGameProvisioningBinding).toHaveBeenCalledWith(
      externalRequest.externalId,
      scene
    );
  });
});
