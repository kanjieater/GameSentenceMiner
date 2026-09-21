import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GameProvisioningRequest } from "./game_provisioning.js";

const scene = { id: "scene-arc", name: "Arc the Lad II" };
let scenes: Array<{ id: string; name: string }> = [];
let profile: any = null;
let collectionName = "Default";
let switcherConfig: any = {
  schemaVersion: 1,
  collections: [],
};

const createSceneWithCapture = vi.fn(async () => {
  scenes = [scene];
});
const upsertSceneLaunchProfile = vi.fn((next: any) => {
  profile = next;
});

vi.mock("../ui/obs.js", () => ({
  createSceneWithCapture,
  getOBSScenes: vi.fn(async () => scenes),
  getCurrentOBSSceneCollectionName: vi.fn(async () => collectionName),
  getWindowTitleFromSource: vi.fn(async () => "Arc the Lad II - RetroArch"),
}));

vi.mock("../store.js", () => ({
  getSceneLaunchProfileForScene: vi.fn(() => profile),
  getWindowSceneSwitcherConfig: vi.fn(() => switcherConfig),
  upsertSceneLaunchProfile,
}));

async function loadRuntime() {
  vi.resetModules();
  return import("./game_provisioning_runtime.js");
}

const request: GameProvisioningRequest = {
  displayName: "Arc the Lad II",
  processId: 12345,
};

describe("GSM game provisioning runtime binding", () => {
  beforeEach(() => {
    scenes = [];
    profile = null;
    collectionName = "Default";
    switcherConfig = {
      schemaVersion: 1,
      collections: [],
    };
    createSceneWithCapture.mockClear();
    upsertSceneLaunchProfile.mockClear();
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

    const result = await ensureGameProvisionedWithGsm(request, resolver);

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
  });
});
