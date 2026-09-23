import { describe, expect, it, vi } from "vitest";
import type { ForegroundWindowSnapshot } from "../../shared/window_scene_switcher.js";
import { mergeObsWindowItems, type ObsWindowOption } from "../ui/obs-capture.js";
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
      target: {
        title: windowOption.title,
        selection: windowOption,
        durableSwitcherSafe: false,
        launchProcessId: 4242,
      },
    });
  });

  it("preserves a Japanese PCSX2 window and uses process ownership instead of translated title identity", () => {
    const title = "ドラゴンシャドウスペル";
    const value = "ドラゴンシャドウスペル:Qt682QWindowIcon:pcsx2-qt.exe";
    const [option] = mergeObsWindowItems([
      { itemName: "[pcsx2-qt.exe]: " + title, itemValue: value, captureMode: "window_capture" },
      { itemName: "[pcsx2-qt.exe]: " + title, itemValue: value, captureMode: "game_capture" },
    ]);
    const result = resolveForegroundCaptureTarget(
      { displayName: "Dragon Shadow Spell", processId: 15300, externalId: "playnite:c1bd7a8f-7830-40ce-a908-fac7e4fef840" },
      { hwnd: "1641430", pid: 15300, title, executableName: "pcsx2-qt.exe", capturedAt: 1, sequence: 1 },
      [{ ...option, suggestedSceneName: title }]
    );

    expect(option).toMatchObject({
      title,
      captureValues: { window_capture: value, game_capture: value },
    });
    expect(result).toEqual({
      status: "resolved",
      target: {
        title,
        selection: { ...option, suggestedSceneName: title },
        durableSwitcherSafe: false,
        launchProcessId: 15300,
      },
    });
  });

  it("accepts a proven descendant process without comparing its title to the Playnite name", () => {
    const childForeground: ForegroundWindowSnapshot = {
      ...foreground,
      pid: 7777,
      title: "Completely Different Child Title",
      executableName: "game.exe",
    };
    const childOption: ObsWindowOption = {
      title: childForeground.title,
      suggestedSceneName: childForeground.title,
      value: "Completely Different Child Title:GameWindow:game.exe",
      targetKind: "window",
      captureValues: {
        window_capture: "Completely Different Child Title:GameWindow:game.exe",
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Playnite Display Name",
          processId: 4242,
          externalId: "playnite:abc",
        },
        childForeground,
        [childOption],
        { isLaunchProcess: (pid) => pid === 4242 || pid === 7777 }
      )
    ).toEqual({
      status: "resolved",
      target: {
        title: childOption.title,
        selection: childOption,
        durableSwitcherSafe: false,
        launchProcessId: 7777,
      },
    });
  });

  it("uses the Playnite root PID as launch identity even for a generic emulator title", () => {
    const emulatorForeground: ForegroundWindowSnapshot = {
      ...foreground,
      title: "RetroArch SwanStation 1.0.0 4d309c0",
      executableName: "retroarch.exe",
    };
    const emulatorOption: ObsWindowOption = {
      title: emulatorForeground.title,
      suggestedSceneName: emulatorForeground.title,
      value: JSON.stringify([
        emulatorForeground.title,
        "RetroArch",
        "retroarch.exe",
      ]),
      targetKind: "window",
      captureValues: {
        window_capture:
          "RetroArch SwanStation 1.0.0 4d309c0:RetroArch:retroarch.exe",
        game_capture:
          "RetroArch SwanStation 1.0.0 4d309c0:RetroArch:retroarch.exe",
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Arc the Lad II",
          processId: 4242,
          externalId: "playnite:abc",
        },
        emulatorForeground,
        [emulatorOption]
      )
    ).toEqual({
      status: "resolved",
      target: {
        title: emulatorOption.title,
        selection: emulatorOption,
        durableSwitcherSafe: false,
        launchProcessId: 4242,
      },
    });
  });

  it("requires exact executable proof for launch-scoped exact-PID identity", () => {
    const localizedForeground: ForegroundWindowSnapshot = {
      ...foreground,
      title: "ドラゴンシャドウスペル",
      executableName: "pcsx2-qt.exe",
    };
    const wrongExecutable: ObsWindowOption = {
      title: localizedForeground.title,
      suggestedSceneName: localizedForeground.title,
      value: "ドラゴンシャドウスペル:Qt682QWindowIcon:other.exe",
      targetKind: "window",
      captureValues: {
        window_capture:
          "ドラゴンシャドウスペル:Qt682QWindowIcon:other.exe",
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Dragon Shadow Spell",
          processId: 4242,
          externalId: "playnite:dss",
        },
        localizedForeground,
        [wrongExecutable]
      ).status
    ).toBe("not-ready");
  });

  it("requires OBS executable proof even when the foreground PID is launch-owned", () => {
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
    ).toEqual(
      expect.objectContaining({
        status: "not-ready",
        reason: expect.stringContaining("could not verify"),
      })
    );
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
        reason: expect.stringContaining("not part of the Playnite launch"),
      })
    );
  });

  it("uses a unique launch-owned OBS target when another app remains foreground", () => {
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

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Realize - Panorama Luminary",
          processId: 53768,
          externalId: "playnite:realize",
        },
        terminalForeground,
        [realizeOption],
        {
          launchProcesses: [
            {
              pid: 53768,
              executableName: "pcsx2-qt.exe",
              windowTitle: "_REALIZE -Panorama Luminary-",
            },
          ],
        }
      )
    ).toEqual({
      status: "resolved",
      target: {
        title: realizeOption.title,
        selection: realizeOption,
        durableSwitcherSafe: false,
        launchProcessId: 53768,
      },
    });
  });

  it("does not treat executable equality alone as launch-window ownership", () => {
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
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Realize - Panorama Luminary",
          processId: 53768,
          externalId: "playnite:realize",
        },
        terminalForeground,
        [realizeOption],
        {
          launchProcesses: [
            { pid: 53768, executableName: "pcsx2-qt.exe" },
          ],
        }
      ).status
    ).toBe("not-ready");
  });

  it("fails closed when multiple OBS windows share a launch-owned executable", () => {
    const terminalForeground: ForegroundWindowSnapshot = {
      hwnd: "999",
      pid: 8888,
      title: "π - ke",
      executableName: "WindowsTerminal.exe",
      capturedAt: 2,
      sequence: 2,
    };
    const secondPcsx2Option: ObsWindowOption = {
      ...windowOption,
      title: "_REALIZE -Panorama Luminary-",
      value: "_REALIZE -Panorama Luminary-:QtDifferentWindow:pcsx2-qt.exe",
      captureValues: {
        window_capture:
          "_REALIZE -Panorama Luminary-:QtDifferentWindow:pcsx2-qt.exe",
      },
    };
    const realizeOption: ObsWindowOption = {
      ...secondPcsx2Option,
      title: "_REALIZE -Panorama Luminary-",
      value: "_REALIZE -Panorama Luminary-:Qt682QWindowIcon:pcsx2-qt.exe",
      captureValues: {
        window_capture:
          "_REALIZE -Panorama Luminary-:Qt682QWindowIcon:pcsx2-qt.exe",
      },
    };

    expect(
      resolveForegroundCaptureTarget(
        {
          displayName: "Realize - Panorama Luminary",
          processId: 53768,
          externalId: "playnite:realize",
        },
        terminalForeground,
        [realizeOption, secondPcsx2Option],
        {
          launchProcesses: [
            { pid: 53768, executableName: "pcsx2-qt.exe" },
          ],
        }
      )
    ).toEqual(
      expect.objectContaining({
        status: "not-ready",
        reason: expect.stringContaining("Multiple OBS Setup Capture targets"),
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