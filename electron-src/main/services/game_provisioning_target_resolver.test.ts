import { describe, expect, it, vi } from "vitest";
import type { ForegroundWindowSnapshot } from "../../shared/window_scene_switcher.js";
import type { ObsWindowOption } from "../ui/obs-capture.js";
import {
  createForegroundGameCaptureTargetResolver,
  resolveForegroundCaptureTarget,
} from "./game_provisioning_target_resolver.js";

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
  value: JSON.stringify(["arc the lad ii - retroarch", "retroarch", "retroarch.exe"]),
  targetKind: "window",
  captureValues: {
    window_capture: "Arc the Lad II - RetroArch:RetroArch:retroarch.exe",
    game_capture: "Arc the Lad II - RetroArch:RetroArch:retroarch.exe",
  },
};

describe("game provisioning target resolver", () => {
  it("resolves the matching foreground Setup Capture target", () => {
    expect(
      resolveForegroundCaptureTarget(
        { displayName: "Arc the Lad II", processId: 4242, externalId: "playnite:abc" },
        foreground,
        [windowOption]
      )
    ).toEqual({
      status: "resolved",
      target: { title: windowOption.title, selection: windowOption },
    });
  });

  it("refuses a matching Playnite PID when the foreground target is still a wrapper", () => {
    const wrapperForeground: ForegroundWindowSnapshot = {
      ...foreground,
      title: "Arc Launcher",
      executableName: "launcher.exe",
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

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          processId: 4242,
          externalId: "playnite:abc",
        },
        wrapperForeground,
        [wrapperOption]
      )
    ).toEqual(
      expect.objectContaining({
        status: "not-ready",
        reason: expect.stringContaining(
          "does not identify the requested game yet"
        ),
      })
    );
  });

  it("allows matching PID to relax executable proof once game identity is exact", () => {
    const noExecutable: ObsWindowOption = {
      ...windowOption,
      captureValues: {},
      value: "opaque",
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          processId: 4242,
          externalId: "playnite:abc",
        },
        foreground,
        [noExecutable]
      )
    ).toEqual({
      status: "resolved",
      target: { title: noExecutable.title, selection: noExecutable },
    });
  });

  it("treats a mismatched requested PID as not-ready while PID enforcement is active", () => {
    expect(
      resolveForegroundCaptureTarget(
        { displayName: "Arc the Lad II", processId: 9999, externalId: "playnite:abc" },
        foreground,
        [windowOption]
      )
    ).toEqual(
      expect.objectContaining({
        status: "not-ready",
        reason: expect.stringContaining("does not match requested PID"),
      })
    );
  });

  it("falls back from a stale launcher PID to a unique game-associated capture target", () => {
    expect(
      resolveForegroundCaptureTarget(
        { displayName: "Arc the Lad II", processId: 9999, externalId: "playnite:abc" },
        foreground,
        [windowOption],
        { enforceProcessId: false }
      )
    ).toEqual({
      status: "resolved",
      target: { title: windowOption.title, selection: windowOption },
    });
  });

  it("does not fall back from a stale PID to an unrelated foreground target", () => {
    const unrelated: ObsWindowOption = {
      ...windowOption,
      title: "Some Other Window",
      suggestedSceneName: "Some Other Window",
      captureValues: {
        window_capture: "Some Other Window:Other:retroarch.exe",
      },
    };
    const unrelatedForeground = { ...foreground, title: "Some Other Window" };

    expect(
      resolveForegroundCaptureTarget(
        { displayName: "Arc the Lad II", processId: 9999, externalId: "playnite:abc" },
        unrelatedForeground,
        [unrelated],
        { enforceProcessId: false }
      ).status
    ).toBe("not-ready");
  });

  it("refuses partial-name collisions after PID fallback", () => {
    const collisionForeground: ForegroundWindowSnapshot = {
      ...foreground,
      pid: 5555,
      title: "Dead Island",
      executableName: "deadisland.exe",
    };
    const collisionOption: ObsWindowOption = {
      title: "Dead Island",
      suggestedSceneName: "Dead Island",
      value: "Dead Island:DeadIsland:deadisland.exe",
      targetKind: "window",
      captureValues: {
        window_capture: "Dead Island:DeadIsland:deadisland.exe",
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Island",
          processId: 9999,
          externalId: "playnite:island",
        },
        collisionForeground,
        [collisionOption],
        { enforceProcessId: false }
      ).status
    ).toBe("not-ready");
  });

  it("refuses browser or launcher titles that merely contain the requested name", () => {
    const browserForeground: ForegroundWindowSnapshot = {
      ...foreground,
      pid: 5555,
      title: "Island - Google Search - Chrome",
      executableName: "chrome.exe",
    };
    const browserOption: ObsWindowOption = {
      title: "Island - Google Search - Chrome",
      suggestedSceneName: "Island - Google Search - Chrome",
      value: "Island - Google Search - Chrome:Chrome_WidgetWin_1:chrome.exe",
      targetKind: "window",
      captureValues: {
        window_capture:
          "Island - Google Search - Chrome:Chrome_WidgetWin_1:chrome.exe",
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Island",
          processId: 9999,
          externalId: "playnite:island",
        },
        browserForeground,
        [browserOption],
        { enforceProcessId: false }
      ).status
    ).toBe("not-ready");
  });

  it("refuses an unrelated foreground target when no PID is available", () => {
    const unrelated: ObsWindowOption = {
      ...windowOption,
      title: "Some Other Window",
      suggestedSceneName: "Some Other Window",
      value: "Some Other Window:Other:retroarch.exe",
      captureValues: {
        window_capture: "Some Other Window:Other:retroarch.exe",
      },
    };
    const unrelatedForeground = { ...foreground, title: "Some Other Window" };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          externalId: "playnite:abc",
        },
        unrelatedForeground,
        [unrelated]
      ).status
    ).toBe("not-ready");
  });

  it("resolves without PID when exact cleaned identity and executable match", () => {
    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          externalId: "playnite:abc",
        },
        foreground,
        [windowOption]
      )
    ).toEqual({
      status: "resolved",
      target: { title: windowOption.title, selection: windowOption },
    });
  });

  it("refuses an unverifiable executable when no PID is available", () => {
    const noExecutable: ObsWindowOption = {
      ...windowOption,
      captureValues: {},
      value: "opaque",
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          externalId: "playnite:abc",
        },
        foreground,
        [noExecutable]
      ).status
    ).toBe("not-ready");
  });

  it("requires executable verification after PID fallback", () => {
    const noExecutable: ObsWindowOption = {
      ...windowOption,
      captureValues: {},
      value: "opaque",
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          processId: 9999,
          externalId: "playnite:abc",
        },
        foreground,
        [noExecutable],
        { enforceProcessId: false }
      ).status
    ).toBe("not-ready");
  });

  it("uses executable identity to reject a same-title wrong process", () => {
    const wrongProcess: ObsWindowOption = {
      ...windowOption,
      captureValues: {
        window_capture: "Arc the Lad II - RetroArch:RetroArch:not-retroarch.exe",
      },
    };
    expect(
      resolveForegroundCaptureTarget(
        { displayName: "Arc the Lad II" },
        foreground,
        [wrongProcess]
      ).status
    ).toBe("not-ready");
  });

  it("fails closed when multiple Setup Capture targets remain", () => {
    const second: ObsWindowOption = { ...windowOption, value: "second" };
    expect(
      resolveForegroundCaptureTarget(
        { displayName: "Arc the Lad II" },
        { ...foreground, executableName: undefined },
        [windowOption, second]
      ).status
    ).toBe("ambiguous");
  });

  it("normalizes a transient OBS enumeration exception to not-ready", async () => {
    const resolver = createForegroundGameCaptureTargetResolver({
      isSupported: () => true,
      getForegroundSnapshot: () => foreground,
      getWindowOptions: vi.fn(async () => { throw new Error("OBS is starting"); }),
    });

    const result = await resolver({ displayName: "Arc the Lad II" });

    expect(result).toEqual(
      expect.objectContaining({
        status: "not-ready",
        reason: expect.stringContaining("OBS is starting"),
      })
    );
  });

  it("reports unsupported platforms without querying OBS", async () => {
    const getWindowOptions = vi.fn(async () => [windowOption]);
    const resolver = createForegroundGameCaptureTargetResolver({
      isSupported: () => false,
      getForegroundSnapshot: () => foreground,
      getWindowOptions,
    });
    expect((await resolver({ displayName: "Arc the Lad II" })).status).toBe("unsupported");
    expect(getWindowOptions).not.toHaveBeenCalled();
  });
});