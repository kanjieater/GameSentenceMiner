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
let bindings: any[] = [];
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
  reserveGameProvisioningBinding: vi.fn(),
  isOBSProvisioningNotReadyError: vi.fn(),
}));

vi.mock("../ui/obs.js", () => ({
  createSceneWithCapture: mocks.createSceneWithCapture,
  getOBSScenesForSceneSwitcher: mocks.getOBSScenesForSceneSwitcher,
  getCurrentOBSSceneCollectionName: mocks.getCurrentOBSSceneCollectionName,
  getWindowTitleFromSource: mocks.getWindowTitleFromSource,
  suggestWindowSceneSwitcherRule: mocks.suggestWindowSceneSwitcherRule,
  isOBSProvisioningNotReadyError: mocks.isOBSProvisioningNotReadyError,
}));

vi.mock("./window_scene_switcher.js", () => ({
  upsertGeneratedWindowSceneRule: mocks.upsertGeneratedWindowSceneRule,
}));

vi.mock("../store.js", () => ({
  getGameProvisioningBinding: mocks.getGameProvisioningBinding,
  getSceneLaunchProfileForScene: mocks.getSceneLaunchProfileForScene,
  getWindowSceneSwitcherConfig: mocks.getWindowSceneSwitcherConfig,
  upsertGameProvisioningBinding: mocks.upsertGameProvisioningBinding,
  reserveGameProvisioningBinding: mocks.reserveGameProvisioningBinding,
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
    bindings = [];
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
    mocks.isOBSProvisioningNotReadyError.mockImplementation(
      (error: unknown) =>
        error instanceof Error &&
        error.message.toLowerCase().includes("not connected")
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
      (externalId: string, requestedCollectionName: string) =>
        bindings.find(
          (binding) =>
            binding.externalId === externalId &&
            binding.collectionName === requestedCollectionName
        ) ?? null
    );
    mocks.getSceneLaunchProfileForScene.mockImplementation(() => profile);
    mocks.getWindowSceneSwitcherConfig.mockImplementation(
      () => switcherConfig
    );
    mocks.reserveGameProvisioningBinding.mockImplementation(
      (
        externalId: string,
        requestedCollectionName: string,
        sceneName: string,
        captureTitle: string,
        executableName?: string
      ) => {
        const existing = bindings.find(
          (binding) =>
            binding.externalId === externalId &&
            binding.collectionName === requestedCollectionName
        );
        if (!existing) {
          bindings.push({
            externalId,
            collectionName: requestedCollectionName,
            sceneId: "",
            sceneName,
            pending: true,
            captureTitle,
            executableName,
          });
        }
      }
    );
    mocks.upsertGameProvisioningBinding.mockImplementation(
      (
        externalId: string,
        requestedCollectionName: string,
        boundScene: { id: string; name: string }
      ) => {
        const next = {
          externalId,
          collectionName: requestedCollectionName,
          sceneId: boundScene.id,
          sceneName: boundScene.name,
          pending: false,
        };
        const index = bindings.findIndex(
          (binding) =>
            binding.externalId === externalId &&
            binding.collectionName === requestedCollectionName
        );
        if (index >= 0) {
          bindings[index] = next;
        } else {
          bindings.push(next);
        }
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
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
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
    expect(mocks.upsertGeneratedWindowSceneRule).toHaveBeenCalledWith(
      "Default",
      "Default.json",
      {
        sceneUuid: scene.id,
        sceneName: scene.name,
        titlePattern: ".*Arc the Lad II.*",
        executableName: "retroarch.exe",
      }
    );
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
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
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
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
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
    expect(mocks.upsertSceneLaunchProfile).not.toHaveBeenCalled();
  });

  it("follows an external-id binding across a scene rename", async () => {
    const renamedScene = { id: scene.id, name: "Arc the Lad II Renamed" };
    scenes = [renamedScene];
    bindings = [{
      externalId: externalRequest.externalId,
      collectionName: "Default",
      sceneId: scene.id,
      sceneName: scene.name,
    }];
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
    expect(mocks.upsertGameProvisioningBinding).toHaveBeenCalledWith(
      externalRequest.externalId,
      "Default",
      renamedScene
    );
  });

  it("reuses an external-id binding without a live PID/window lookup", async () => {
    scenes = [scene];
    bindings = [{
      externalId: "playnite:arc-the-lad-ii",
      collectionName: "Default",
      sceneId: scene.id,
      sceneName: scene.name,
    }];
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
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("keeps the same external id independently bound across OBS collections", async () => {
    const sceneA = { id: "scene-a", name: "Arc the Lad II" };
    const sceneB = { id: "scene-b", name: "Arc the Lad II" };
    const profiles = new Map<string, any>([
      [
        sceneA.id,
        {
          sceneId: sceneA.id,
          sceneName: sceneA.name,
          textHookMode: "none",
          ocrMode: "auto",
          launchOverlay: false,
          agentScriptPath: "",
          launchDelaySeconds: 0,
        },
      ],
    ]);
    mocks.getSceneLaunchProfileForScene.mockImplementation(
      (candidate: { id: string }) => profiles.get(candidate.id) ?? null
    );
    mocks.upsertSceneLaunchProfile.mockImplementation((next: any) => {
      if (next.sceneId) {
        profiles.set(next.sceneId, next);
      }
    });

    switcherConfig = {
      schemaVersion: 1,
      collections: [
        {
          collectionName: "Collection A",
          collectionFileName: "Collection_A.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [
            {
              sceneUuid: sceneA.id,
              sceneName: sceneA.name,
              titlePattern: ".*Arc the Lad II.*",
              executableName: "retroarch.exe",
              enabled: true,
              source: "gsm-generated",
            },
          ],
        },
        {
          collectionName: "Collection B",
          collectionFileName: "Collection_B.json",
          enabled: true,
          migrationVersion: 1,
          legacySwitcherDisabled: true,
          rules: [],
        },
      ],
    };
    bindings = [
      {
        externalId: externalRequest.externalId,
        collectionName: "Collection A",
        sceneId: sceneA.id,
        sceneName: sceneA.name,
        pending: false,
      },
    ];
    collectionName = "Collection A";
    scenes = [sceneA];

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
          },
        },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const inA = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );
    expect(inA.status).toBe("already-configured");
    expect(resolver).not.toHaveBeenCalled();

    collectionName = "Collection B";
    scenes = [];
    mocks.createSceneWithCapture.mockImplementationOnce(async () => {
      scenes = [sceneB];
    });

    const inB = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );
    expect(inB.status).toBe("provisioned");
    expect(
      bindings.find(
        (binding) =>
          binding.externalId === externalRequest.externalId &&
          binding.collectionName === "Collection B"
      )
    ).toEqual(
      expect.objectContaining({
        sceneId: sceneB.id,
        pending: false,
      })
    );

    collectionName = "Collection A";
    scenes = [sceneA];

    const backInA = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );
    expect(backInA.status).toBe("already-configured");
    expect(
      bindings.find(
        (binding) =>
          binding.externalId === externalRequest.externalId &&
          binding.collectionName === "Collection A"
      )
    ).toEqual(
      expect.objectContaining({
        sceneId: sceneA.id,
        pending: false,
      })
    );
    expect(
      bindings.filter(
        (binding) => binding.externalId === externalRequest.externalId
      )
    ).toHaveLength(2);
  });

  it("recovers a fingerprinted pending binding after scene creation partially succeeds", async () => {
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
          },
        },
      },
    }));
    mocks.createSceneWithCapture.mockImplementationOnce(async () => {
      scenes = [scene];
      throw new Error("OBS failed after creating the scene");
    });
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const first = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(first).toEqual({
      status: "failed",
      reason: "OBS failed after creating the scene",
    });
    expect(bindings).toEqual([
      expect.objectContaining({
        externalId: externalRequest.externalId,
        collectionName: "Default",
        sceneId: "",
        sceneName: scene.name,
        pending: true,
        captureTitle: "Arc the Lad II - RetroArch",
        executableName: "retroarch.exe",
      }),
    ]);

    const second = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(second).toEqual({
      status: "provisioned",
      scene,
      createdScene: false,
      updatedProfile: true,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mocks.createSceneWithCapture).toHaveBeenCalledTimes(1);
    expect(bindings).toEqual([
      expect.objectContaining({
        externalId: externalRequest.externalId,
        collectionName: "Default",
        sceneId: scene.id,
        sceneName: scene.name,
        pending: false,
      }),
    ]);
  });

  it("does not let an orphaned pending reservation claim an unrelated same-name scene", async () => {
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
          },
        },
      },
    }));
    mocks.createSceneWithCapture.mockRejectedValueOnce(
      new Error("OBS failed before creating the scene")
    );
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const first = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );
    expect(first.status).toBe("failed");
    expect(bindings[0]).toEqual(
      expect.objectContaining({
        pending: true,
        captureTitle: "Arc the Lad II - RetroArch",
        executableName: "retroarch.exe",
      })
    );

    scenes = [scene];
    mocks.getWindowTitleFromSource.mockImplementationOnce(
      async () => "Unrelated Manual Window"
    );

    const second = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(second.status).toBe("failed");
    expect(second).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining(
          "does not match the capture in same-name scene"
        ),
      })
    );
    expect(mocks.upsertGameProvisioningBinding).not.toHaveBeenCalled();
    expect(bindings[0]).toEqual(
      expect.objectContaining({
        sceneId: "",
        pending: true,
      })
    );
  });

  it("does not let a pending reservation claim a same-title scene with the wrong executable", async () => {
    scenes = [scene];
    bindings = [
      {
        externalId: externalRequest.externalId,
        collectionName: "Default",
        sceneId: "",
        sceneName: scene.name,
        pending: true,
        captureTitle: "Arc the Lad II - RetroArch",
        executableName: "retroarch.exe",
      },
    ];
    mocks.getWindowTitleFromSource.mockResolvedValue(
      "Arc the Lad II - RetroArch"
    );
    mocks.suggestWindowSceneSwitcherRule.mockResolvedValueOnce({
      titlePattern: ".*Arc the Lad II.*",
      executableName: "unrelated.exe",
    });
    const resolver = vi.fn(async () => ({
      status: "not-ready" as const,
      reason: "should not run",
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(
      externalRequest,
      resolver
    );

    expect(result.status).toBe("failed");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining(
          "does not match the executable in same-name scene"
        ),
      })
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(mocks.upsertGameProvisioningBinding).not.toHaveBeenCalled();
  });

  it("reports target-not-ready when the active collection migration state has not appeared yet", async () => {
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

    expect(result.status).toBe("target-not-ready");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("no GSM scene-switcher migration state yet"),
      })
    );
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("reports target-not-ready before OBS exposes an active collection", async () => {
    collectionName = "";
    const resolver = vi.fn(async () => ({
      status: "resolved" as const,
      target: {
        title: "Arc the Lad II - RetroArch",
        selection: { title: "Arc the Lad II - RetroArch" },
      },
    }));
    const { ensureGameProvisionedWithGsm } = await loadRuntime();

    const result = await ensureGameProvisionedWithGsm(request, resolver);

    expect(result.status).toBe("target-not-ready");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining("active scene collection yet"),
      })
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
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
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("reports target-not-ready when strict OBS scene enumeration is temporarily disconnected", async () => {
    mocks.getOBSScenesForSceneSwitcher.mockRejectedValueOnce(
      new Error("OBS websocket not connected")
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
      status: "target-not-ready",
      reason:
        "OBS scene enumeration is not ready yet: OBS websocket not connected",
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
  });

  it("fails closed when strict OBS scene enumeration fails", async () => {
    scenes = [scene];
    mocks.getOBSScenesForSceneSwitcher.mockRejectedValueOnce(
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
    expect(mocks.createSceneWithCapture).not.toHaveBeenCalled();
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
    expect(mocks.reserveGameProvisioningBinding).toHaveBeenCalledWith(
      externalRequest.externalId,
      "Default",
      "Arc the Lad II",
      "Arc the Lad II - RetroArch",
      "retroarch.exe"
    );
    expect(mocks.createSceneWithCapture).toHaveBeenCalledWith({
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
    expect(mocks.upsertSceneLaunchProfile).toHaveBeenCalledWith({
      sceneId: scene.id,
      sceneName: scene.name,
      textHookMode: "none",
      ocrMode: "auto",
      launchOverlay: false,
      agentScriptPath: "",
      launchDelaySeconds: 0,
    });
    expect(mocks.upsertGameProvisioningBinding).toHaveBeenCalledWith(
      externalRequest.externalId,
      "Default",
      scene
    );
  });
});
