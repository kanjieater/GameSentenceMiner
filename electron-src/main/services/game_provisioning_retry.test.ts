import { describe, expect, it, vi } from "vitest";
import type { ForegroundWindowSnapshot } from "../../shared/window_scene_switcher.js";
import type { ObsWindowOption } from "../ui/obs-capture.js";
import type {
  GameProvisioningRequest,
  GameProvisioningResult,
} from "./game_provisioning.js";
import type { GameCaptureTargetResolver } from "./game_provisioning_runtime.js";
import { ensureGameProvisionedWithRetry } from "./game_provisioning_retry.js";

const foreground: ForegroundWindowSnapshot = {
  hwnd: "123",
  pid: 4242,
  title: "Arc the Lad II - RetroArch",
  executableName: "retroarch.exe",
  capturedAt: 1,
  sequence: 1,
};

const windowOption: ObsWindowOption = {
  title: "Arc the Lad II - RetroArch",
  suggestedSceneName: "Arc the Lad II",
  value: "Arc the Lad II - RetroArch:RetroArch:retroarch.exe",
  targetKind: "window",
  captureValues: {
    window_capture: "Arc the Lad II - RetroArch:RetroArch:retroarch.exe",
  },
};

const success: GameProvisioningResult = {
  status: "already-configured",
  scene: { id: "scene-1", name: "Arc the Lad II" },
  createdScene: false,
  updatedProfile: false,
};

describe("game provisioning whole-operation retry", () => {
  it("retries when OBS window enumeration rejects and then succeeds", async () => {
    const getWindowOptions = vi
      .fn<() => Promise<ObsWindowOption[]>>()
      .mockRejectedValueOnce(new Error("OBS is starting"))
      .mockResolvedValue([windowOption]);
    const ensureAttempt = vi.fn(
      async (
        _request: GameProvisioningRequest,
        resolver: GameCaptureTargetResolver
      ): Promise<GameProvisioningResult> => {
      const resolution = await resolver({
        displayName: "Arc the Lad II",
        processId: 4242,
      });
        return resolution.status === "resolved"
          ? success
          : { status: "target-not-ready", reason: resolution.reason };
      }
    );
    const wait = vi.fn(async () => undefined);

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Arc the Lad II", processId: 4242 },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => foreground,
        getWindowOptions,
        ensureAttempt,
        wait,
      },
      { attempts: 2, delayMs: 1, launchOwnershipDelayAttempts: 0 }
    );

    expect(result.status).toBe("already-configured");
    expect(getWindowOptions).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("retries Phase 2 preflight target-not-ready before target resolution", async () => {
    const ensureAttempt = vi
      .fn()
      .mockResolvedValueOnce({
        status: "target-not-ready",
        reason: "OBS did not report an active scene collection yet.",
      })
      .mockResolvedValueOnce(success);
    const getWindowOptions = vi.fn(async () => [windowOption]);
    const wait = vi.fn(async () => undefined);

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Arc the Lad II" },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => foreground,
        getWindowOptions,
        ensureAttempt,
        wait,
      },
      { attempts: 2, delayMs: 1 }
    );

    expect(result.status).toBe("already-configured");
    expect(ensureAttempt).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("keeps safety failures fail-closed without retry", async () => {
    const ensureAttempt = vi.fn(async () => ({
      status: "failed" as const,
      reason: "user-disabled rule",
    }));
    const wait = vi.fn(async () => undefined);

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Arc the Lad II" },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => foreground,
        getWindowOptions: async () => [windowOption],
        ensureAttempt,
        wait,
      },
      { attempts: 4, delayMs: 1 }
    );

    expect(result.status).toBe("failed");
    expect(ensureAttempt).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("waits through a matching-PID wrapper and provisions the later child target", async () => {
    const wrapperForeground: ForegroundWindowSnapshot = {
      ...foreground,
      pid: 4242,
      title: "Arc Launcher",
      executableName: "launcher.exe",
    };
    const childForeground: ForegroundWindowSnapshot = {
      ...foreground,
      pid: 7777,
      title: "Arc the Lad II - RetroArch",
      executableName: "retroarch.exe",
    };
    const wrapperOption: ObsWindowOption = {
      title: "Arc Launcher",
      suggestedSceneName: "Arc Launcher",
      value: "Arc Launcher:LauncherWindow:launcher.exe",
      targetKind: "window",
      captureValues: {
        window_capture: "Arc Launcher:LauncherWindow:launcher.exe",
      },
    };

    let attempt = 0;
    const getForegroundSnapshot = vi.fn(() =>
      attempt === 0 ? wrapperForeground : childForeground
    );
    const getWindowOptions = vi.fn(async () =>
      attempt === 0 ? [wrapperOption] : [windowOption]
    );
    const ensureAttempt = vi.fn(
      async (
        _request: GameProvisioningRequest,
        resolver: GameCaptureTargetResolver
      ): Promise<GameProvisioningResult> => {
        const resolution = await resolver({
          displayName: "Arc the Lad II",
          processId: 4242,
        });
        attempt += 1;
        return resolution.status === "resolved"
          ? success
          : { status: "target-not-ready", reason: resolution.reason };
      }
    );

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Arc the Lad II", processId: 4242 },
      {
        isSupported: () => true,
        getForegroundSnapshot,
        getWindowOptions,
        ensureAttempt,
        wait: async () => undefined,
      },
      { attempts: 2, pidStrictAttempts: 1, delayMs: 1 }
    );

    expect(result.status).toBe("already-configured");
    expect(ensureAttempt).toHaveBeenCalledTimes(2);
    // Retry samples foreground once for launch-tree observation and once in
    // the production resolver on each attempt.
    expect(getForegroundSnapshot).toHaveBeenCalledTimes(4);
    expect(getWindowOptions).toHaveBeenCalledTimes(2);
  });

  it("waits through the generic handoff grace before trusting the launch root", async () => {
    const genericForeground: ForegroundWindowSnapshot = {
      ...foreground,
      title: "RetroArch SwanStation 1.0.0 4d309c0",
      executableName: "retroarch.exe",
    };
    const genericOption: ObsWindowOption = {
      title: genericForeground.title,
      suggestedSceneName: genericForeground.title,
      value: "RetroArch SwanStation 1.0.0 4d309c0:RetroArch:retroarch.exe",
      targetKind: "window",
      captureValues: {
        window_capture:
          "RetroArch SwanStation 1.0.0 4d309c0:RetroArch:retroarch.exe",
        game_capture:
          "RetroArch SwanStation 1.0.0 4d309c0:RetroArch:retroarch.exe",
      },
    };
    const resolutions: string[] = [];
    const ensureAttempt = vi.fn(
      async (
        _request: GameProvisioningRequest,
        resolver: GameCaptureTargetResolver
      ): Promise<GameProvisioningResult> => {
        const resolution = await resolver({
          displayName: "Arc the Lad II",
          processId: 4242,
        });
        resolutions.push(resolution.status);
        if (resolution.status === "resolved") {
          expect(resolution.target.durableSwitcherSafe).toBe(false);
          expect(resolution.target.launchProcessId).toBe(4242);
          return success;
        }
        return { status: "target-not-ready", reason: resolution.reason };
      }
    );

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Arc the Lad II", processId: 4242 },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => genericForeground,
        getWindowOptions: async () => [genericOption],
        ensureAttempt,
        wait: async () => undefined,
      },
      {
        attempts: 2,
        delayMs: 1,
        launchOwnershipDelayAttempts: 1,
      }
    );

    expect(result.status).toBe("already-configured");
    expect(resolutions).toEqual(["not-ready", "resolved"]);
  });

  it("proves a launcher child from parent PID even after the root exits", async () => {
    const childForeground: ForegroundWindowSnapshot = {
      ...foreground,
      pid: 7777,
      title: "Untranslated Child Window",
      executableName: "game.exe",
    };
    const childOption: ObsWindowOption = {
      title: childForeground.title,
      suggestedSceneName: childForeground.title,
      value: "Untranslated Child Window:GameWindow:game.exe",
      targetKind: "window",
      captureValues: {
        window_capture: "Untranslated Child Window:GameWindow:game.exe",
      },
    };
    const ensureAttempt = vi.fn(
      async (
        _request: GameProvisioningRequest,
        resolver: GameCaptureTargetResolver
      ): Promise<GameProvisioningResult> => {
        const resolution = await resolver({
          displayName: "Different Playnite Name",
          processId: 4242,
        });
        if (resolution.status === "resolved") {
          expect(resolution.target.launchProcessId).toBe(7777);
          expect(resolution.target.durableSwitcherSafe).toBe(false);
          return success;
        }
        return { status: "target-not-ready", reason: resolution.reason };
      }
    );

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Different Playnite Name", processId: 4242 },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => childForeground,
        getWindowOptions: async () => [childOption],
        getProcessRelationships: async () => [
          { pid: 7777, parentPid: 4242 },
        ],
        ensureAttempt,
        wait: async () => undefined,
      },
      {
        attempts: 1,
        delayMs: 0,
        launchOwnershipDelayAttempts: 0,
      }
    );

    expect(result.status).toBe("already-configured");
    expect(ensureAttempt).toHaveBeenCalledOnce();
  });

  it("provisions from a unique launch-owned OBS target even when another app stays foreground", async () => {
    const terminalForeground: ForegroundWindowSnapshot = {
      hwnd: "999",
      pid: 8888,
      title: "π - ke",
      executableName: "WindowsTerminal.exe",
      capturedAt: 2,
      sequence: 2,
    };
    const realizeOption: ObsWindowOption = {
      title: "_REALIZE -Panorama Luminary-",
      suggestedSceneName: "_REALIZE -Panorama Luminary-",
      value: "_REALIZE -Panorama Luminary-:Qt682QWindowIcon:pcsx2-qt.exe",
      targetKind: "window",
      captureValues: {
        window_capture:
          "_REALIZE -Panorama Luminary-:Qt682QWindowIcon:pcsx2-qt.exe",
        game_capture:
          "_REALIZE -Panorama Luminary-:Qt682QWindowIcon:pcsx2-qt.exe",
      },
    };

    const ensureAttempt = vi.fn(
      async (
        attemptRequest: GameProvisioningRequest,
        resolver: GameCaptureTargetResolver
      ): Promise<GameProvisioningResult> => {
        expect(attemptRequest.launchProcessIds).toEqual([53768]);
        const resolution = await resolver({
          displayName: "Realize - Panorama Luminary",
          processId: 53768,
          externalId: "playnite:realize",
        });
        if (resolution.status === "resolved") {
          expect(resolution.target).toEqual(
            expect.objectContaining({
              title: realizeOption.title,
              durableSwitcherSafe: false,
              launchProcessId: 53768,
            })
          );
          return success;
        }
        return { status: "target-not-ready", reason: resolution.reason };
      }
    );

    const result = await ensureGameProvisionedWithRetry(
      {
        displayName: "Realize - Panorama Luminary",
        processId: 53768,
        externalId: "playnite:realize",
      },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => terminalForeground,
        getWindowOptions: async () => [realizeOption],
        getProcessRelationships: async () => [
          {
            pid: 53768,
            parentPid: 1,
            executableName: "pcsx2-qt.exe",
            windowTitle: "_REALIZE -Panorama Luminary-",
          },
        ],
        ensureAttempt,
        wait: async () => undefined,
      },
      {
        attempts: 1,
        delayMs: 0,
        launchOwnershipDelayAttempts: 0,
      }
    );

    expect(result.status).toBe("already-configured");
    expect(ensureAttempt).toHaveBeenCalledOnce();
  });

  it("keeps observing a bound relaunch long enough to retain a transient multi-hop launcher", async () => {
    let snapshot = 0;
    const getProcessRelationships = vi.fn(async () => {
      snapshot += 1;
      if (snapshot === 1) {
        return [
          { pid: 4242, parentPid: 1, executableName: "root.exe" },
        ];
      }
      if (snapshot === 2) {
        return [
          { pid: 4242, parentPid: 1, executableName: "root.exe" },
          { pid: 5000, parentPid: 4242, executableName: "launcher.exe" },
        ];
      }
      return [
        { pid: 4242, parentPid: 1, executableName: "root.exe" },
        { pid: 7777, parentPid: 5000, executableName: "pcsx2-qt.exe" },
      ];
    });
    const foregrounds: ForegroundWindowSnapshot[] = [
      {
        ...foreground,
        pid: 4242,
        title: "Root Launcher",
        executableName: "root.exe",
      },
      {
        ...foreground,
        pid: 4242,
        title: "Root Launcher",
        executableName: "root.exe",
      },
      {
        ...foreground,
        pid: 7777,
        title: "_REALIZE -Panorama Luminary-",
        executableName: "pcsx2-qt.exe",
      },
    ];
    let foregroundIndex = 0;
    const ensureAttempt = vi.fn(
      async (
        attemptRequest: GameProvisioningRequest
      ): Promise<GameProvisioningResult> => {
        foregroundIndex += 1;
        if (foregroundIndex === 1) {
          expect(attemptRequest.launchProcessIds).toEqual([4242]);
        } else if (foregroundIndex === 2) {
          expect(attemptRequest.launchProcessIds).toEqual([4242, 5000]);
        } else {
          expect(attemptRequest.launchProcessIds).toEqual([4242, 5000, 7777]);
        }
        return success;
      }
    );
    const wait = vi.fn(async () => undefined);

    const result = await ensureGameProvisionedWithRetry(
      {
        displayName: "Realize - Panorama Luminary",
        processId: 4242,
        externalId: "playnite:realize",
      },
      {
        isSupported: () => true,
        getForegroundSnapshot: () =>
          foregrounds[Math.min(foregroundIndex, foregrounds.length - 1)],
        getWindowOptions: async () => [],
        getProcessRelationships,
        ensureAttempt,
        wait,
      },
      {
        attempts: 3,
        delayMs: 1,
        boundLaunchObservationAttempts: 3,
      }
    );

    expect(result.status).toBe("already-configured");
    expect(getProcessRelationships).toHaveBeenCalledTimes(3);
    expect(ensureAttempt).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("uses PID strictly first, then safely falls back after launcher handoff", async () => {
    const ensureAttempt = vi.fn(
      async (
        _request: GameProvisioningRequest,
        resolver: GameCaptureTargetResolver
      ): Promise<GameProvisioningResult> => {
      const resolution = await resolver({
        displayName: "Arc the Lad II",
        processId: 9999,
      });
        return resolution.status === "resolved"
          ? success
          : { status: "target-not-ready", reason: resolution.reason };
      }
    );

    const result = await ensureGameProvisionedWithRetry(
      { displayName: "Arc the Lad II", processId: 9999 },
      {
        isSupported: () => true,
        getForegroundSnapshot: () => foreground,
        getWindowOptions: async () => [windowOption],
        ensureAttempt,
        wait: async () => undefined,
      },
      { attempts: 2, pidStrictAttempts: 1, delayMs: 1 }
    );

    expect(result.status).toBe("already-configured");
    expect(ensureAttempt).toHaveBeenCalledTimes(2);
  });
});