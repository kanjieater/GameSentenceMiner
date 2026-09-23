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
  const pidMismatch = requestedPid !== undefined && foreground.pid !== requestedPid;
  if (pidMismatch && resolverOptions.enforceProcessId !== false) {
    return {
      status: "not-ready",
      reason:
        "Foreground PID " + foreground.pid +
        " does not match requested PID " + requestedPid + ".",
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

  // Exact PID + exact foreground/candidate executable is strong evidence for
  // the current launch, even when Playnite's display name differs from the
  // actual window title (localized titles, generic emulator windows, etc.).
  // That evidence is deliberately launch-scoped: the discovered title/exe may
  // be too generic to persist as a durable scene-switcher rule.
  if (!belongsToRequestedGame && requestedPid !== undefined && !pidMismatch) {
    if (
      !foregroundExecutable ||
      !selectedExecutable ||
      selectedExecutable !== foregroundExecutable
    ) {
      return {
        status: "not-ready",
        reason:
          "The foreground process matches the requested PID, but GSM could not verify the OBS capture target executable.",
      };
    }

    return {
      status: "resolved",
      target: {
        title: selection.title,
        selection,
        durableSwitcherSafe: false,
      },
    };
  }

  // Without exact-PID launch proof, retain the conservative identity rule.
  // Launcher -> child fallback and no-PID paths must still tie the capture
  // target to the requested game name before provisioning.
  if (!belongsToRequestedGame) {
    return {
      status: "not-ready",
      reason:
        requestedPid === undefined
          ? "No launcher PID was available, and the foreground capture target cannot be tied safely to the requested game name."
          : pidMismatch
            ? "The foreground process replaced the requested PID, but its capture target cannot be tied safely to the requested game name."
            : "The foreground process matches the requested PID, but its capture target does not identify the requested game yet.",
    };
  }

  const requiresExecutableProof = requestedPid === undefined || pidMismatch;
  if (requiresExecutableProof) {
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
            : "The foreground process replaced the requested PID, but GSM could not verify the replacement executable from the OBS capture target.",
      };
    }
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