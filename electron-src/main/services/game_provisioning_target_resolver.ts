import {
  normalizeExecutableName,
  type ForegroundWindowSnapshot,
} from "../../shared/window_scene_switcher.js";
import {
  parseObsWindowValue,
  type ObsWindowOption,
} from "../ui/obs-capture.js";
import type {
  CaptureTargetResolution,
  GameProvisioningRequest,
} from "./game_provisioning.js";

export interface GameProvisioningTargetResolverDependencies {
  isSupported: () => boolean;
  getForegroundSnapshot: () => ForegroundWindowSnapshot | null;
  getWindowOptions: () => Promise<ObsWindowOption[]>;
}

export interface GameProvisioningTargetResolverOptions {
  enforceProcessId?: boolean;
  isLaunchProcess?: (pid: number) => boolean;
}

function normalizeTitle(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function optionExecutable(option: ObsWindowOption): string {
  const values = [
    option.captureValues?.game_capture,
    option.captureValues?.window_capture,
    typeof option.value === "string" && option.value.includes(":")
      ? option.value
      : undefined,
  ];

  for (const value of values) {
    if (!value) continue;
    const executable = normalizeExecutableName(
      parseObsWindowValue(value).executable
    );
    if (executable) return executable;
  }
  return "";
}

function optionBelongsToRequestedGame(
  request: GameProvisioningRequest,
  option: ObsWindowOption
): boolean {
  const requested = normalizeTitle(request.displayName);
  if (!requested) return false;
  const suggested = normalizeTitle(option.suggestedSceneName);
  const title = normalizeTitle(option.title);
  return suggested === requested || title === requested;
}

export function resolveForegroundCaptureTarget(
  request: GameProvisioningRequest,
  foreground: ForegroundWindowSnapshot | null,
  options: ObsWindowOption[],
  resolverOptions: GameProvisioningTargetResolverOptions = {}
): CaptureTargetResolution {
  if (!foreground) {
    return { status: "not-ready", reason: "GSM has not observed a foreground game window yet." };
  }

  const requestedPid =
    typeof request.processId === "number" && request.processId > 0
      ? request.processId
      : undefined;
  const launchOwned =
    requestedPid !== undefined &&
    (resolverOptions.isLaunchProcess
      ? resolverOptions.isLaunchProcess(foreground.pid)
      : foreground.pid === requestedPid);
  const pidMismatch = requestedPid !== undefined && !launchOwned;
  if (pidMismatch && resolverOptions.enforceProcessId !== false) {
    return {
      status: "not-ready",
      reason:
        "Foreground PID " + foreground.pid +
        " is not part of the Playnite launch rooted at PID " + requestedPid + ".",
    };
  }

  const foregroundTitle = normalizeTitle(foreground.title);
  if (!foregroundTitle) {
    return { status: "not-ready", reason: "The foreground window does not have a usable title yet." };
  }

  const foregroundExecutable = normalizeExecutableName(
    foreground.executableName ?? foreground.executablePath
  ).toLocaleLowerCase();

  const titleMatches = options.filter(
    (option) =>
      option.targetKind === "window" &&
      normalizeTitle(option.title) === foregroundTitle
  );
  const executableMatches = foregroundExecutable
    ? titleMatches.filter((option) => {
        const executable = optionExecutable(option).toLocaleLowerCase();
        return !executable || executable === foregroundExecutable;
      })
    : titleMatches;

  if (executableMatches.length === 0) {
    return {
      status: "not-ready",
      reason:
        "Foreground window \"" + foreground.title +
        "\" is not available as an OBS Setup Capture target yet.",
    };
  }
  if (executableMatches.length > 1) {
    return {
      status: "ambiguous",
      reason:
        "Multiple OBS Setup Capture targets match foreground window \"" +
        foreground.title + "\".",
    };
  }

  const selection = executableMatches[0];

  const belongsToRequestedGame = optionBelongsToRequestedGame(
    request,
    selection
  );
  const selectedExecutable = optionExecutable(selection).toLocaleLowerCase();

  // A foreground process proven to be the Playnite root or one of its
  // descendants is authoritative launch identity. The human-readable window
  // title is only used to locate the matching OBS capture target.
  if (launchOwned) {
    if (
      !foregroundExecutable ||
      !selectedExecutable ||
      selectedExecutable !== foregroundExecutable
    ) {
      return {
        status: "not-ready",
        reason:
          "The foreground process belongs to the Playnite launch, but GSM could not verify the matching OBS capture target executable.",
      };
    }

    return {
      status: "resolved",
      target: {
        title: selection.title,
        selection,
        // Process ownership is the durable Playnite integration model. Do not
        // turn a coincidentally matching window title into persistent game
        // identity; a fresh launch PID/tree will be supplied on every launch.
        durableSwitcherSafe: false,
        launchProcessId: foreground.pid,
      },
    };
  }

  // If process ownership cannot be proven (no PID, broken ancestry, etc.),
  // retain the conservative legacy fallback. Name/executable matching is a
  // fallback only, never the primary game identity.
  if (!belongsToRequestedGame) {
    return {
      status: "not-ready",
      reason:
        requestedPid === undefined
          ? "No launcher PID was available, and the foreground capture target cannot be tied safely to the requested game name."
          : "The foreground process is not part of the requested launch, and its capture target cannot be tied safely to the requested game name.",
    };
  }

  if (
    !foregroundExecutable ||
    !selectedExecutable ||
    selectedExecutable !== foregroundExecutable
  ) {
    return {
      status: "not-ready",
      reason:
        requestedPid === undefined
          ? "No launcher PID was available, and GSM could not verify the foreground executable from the OBS capture target."
          : "GSM could not prove process lineage, and could not verify the fallback capture target executable.",
    };
  }

  return {
    status: "resolved",
    target: { title: selection.title, selection },
  };
}

export function createForegroundGameCaptureTargetResolver(
  dependencies: GameProvisioningTargetResolverDependencies,
  options: GameProvisioningTargetResolverOptions = {}
) {
  return async (request: GameProvisioningRequest): Promise<CaptureTargetResolution> => {
    if (!dependencies.isSupported()) {
      return {
        status: "unsupported",
        reason: "Automatic first-time provisioning is currently supported on Windows only.",
      };
    }

    let windows: ObsWindowOption[];
    try {
      windows = await dependencies.getWindowOptions();
    } catch (error) {
      return {
        status: "not-ready",
        reason:
          "OBS Setup Capture targets are not ready yet: " +
          (error instanceof Error ? error.message : String(error)),
      };
    }

    return resolveForegroundCaptureTarget(
      request,
      dependencies.getForegroundSnapshot(),
      windows,
      options
    );
  };
}