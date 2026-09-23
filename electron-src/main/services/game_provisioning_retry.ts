import type {
  GameProvisioningRequest,
  GameProvisioningResult,
} from "./game_provisioning.js";
import type { GameCaptureTargetResolver } from "./game_provisioning_runtime.js";
import {
  createForegroundGameCaptureTargetResolver,
  type GameProvisioningTargetResolverDependencies,
} from "./game_provisioning_target_resolver.js";
import {
  getWindowsProcessRelationships,
  LaunchProcessTree,
  type ProcessRelationship,
} from "./process_lineage.js";

export interface GameProvisioningRetryOptions {
  attempts?: number;
  delayMs?: number;
  pidStrictAttempts?: number;
  launchOwnershipDelayAttempts?: number;
}

export interface GameProvisioningRetryDependencies
  extends GameProvisioningTargetResolverDependencies {
  wait?: (milliseconds: number) => Promise<void>;
  ensureAttempt?: (
    request: GameProvisioningRequest,
    resolveCaptureTarget: GameCaptureTargetResolver
  ) => Promise<GameProvisioningResult>;
  getProcessRelationships?: () => Promise<ProcessRelationship[]>;
}

export async function ensureGameProvisionedWithRetry(
  request: GameProvisioningRequest,
  dependencies: GameProvisioningRetryDependencies,
  options: GameProvisioningRetryOptions = {}
): Promise<GameProvisioningResult> {
  const attempts = Math.max(1, options.attempts ?? 40);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const pidStrictAttempts = Math.max(
    0,
    Math.min(attempts, options.pidStrictAttempts ?? 8)
  );
  const launchOwnershipDelayAttempts = Math.max(
    0,
    options.launchOwnershipDelayAttempts ?? 4
  );
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const ensureAttempt = dependencies.ensureAttempt ?? (async (
    provisionRequest: GameProvisioningRequest,
    resolveCaptureTarget: GameCaptureTargetResolver
  ) => {
    // Avoid loading Electron's OBS runtime when tests inject an attempt.
    const { ensureGameProvisionedWithGsm } = await import("./game_provisioning_runtime.js");
    return await ensureGameProvisionedWithGsm(provisionRequest, resolveCaptureTarget);
  });

  let lastResult: GameProvisioningResult = {
    status: "target-not-ready",
    reason: "The game provisioning target is not ready yet.",
  };
  const launchTree =
    typeof request.processId === "number" && request.processId > 0
      ? new LaunchProcessTree(request.processId)
      : null;
  const getProcessRelationships =
    dependencies.getProcessRelationships ?? getWindowsProcessRelationships;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const foreground = dependencies.getForegroundSnapshot();
    if (
      launchTree &&
      foreground &&
      !launchTree.owns(foreground.pid)
    ) {
      try {
        launchTree.observe(await getProcessRelationships());
      } catch {
        // Process ancestry is strong positive evidence when available, but a
        // transient CIM/PowerShell failure should not abort the whole retry
        // operation. The conservative fallback remains available later.
      }
    }

    const resolver = createForegroundGameCaptureTargetResolver(
      dependencies,
      {
        enforceProcessId: attempt < pidStrictAttempts,
        ...(launchTree
          ? {
              isLaunchProcess: (pid: number) =>
                attempt >= launchOwnershipDelayAttempts &&
                launchTree.owns(pid),
            }
          : {}),
      }
    );

    lastResult = await ensureAttempt(request, resolver);
    if (lastResult.status !== "target-not-ready") {
      return lastResult;
    }

    if (attempt + 1 < attempts && delayMs > 0) {
      await wait(delayMs);
    }
  }

  return lastResult;
}