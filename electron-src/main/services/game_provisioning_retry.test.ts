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
      { attempts: 2, delayMs: 1 }
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
    expect(getForegroundSnapshot).toHaveBeenCalledTimes(2);
    expect(getWindowOptions).toHaveBeenCalledTimes(2);
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