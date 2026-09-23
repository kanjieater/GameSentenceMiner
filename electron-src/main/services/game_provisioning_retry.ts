import type {
  GameProvisioningRequest,
  GameProvisioningResult,
} from "./game_provisioning.js";
import { ensureGameProvisionedWithGsm } from "./game_provisioning_runtime.js";
import {
  createForegroundGameCaptureTargetResolver,
  type GameProvisioningTargetResolverDependencies,
} from "./game_provisioning_target_resolver.js";

export interface GameProvisioningRetryOptions {
  attempts?: number;
  delayMs?: number;
  pidStrictAttempts?: number;
  launchScopedExactPidAfterAttempts?: number;
}

export interface GameProvisioningRetryDependencies
  extends GameProvisioningTargetResolverDependencies {
  wait?: (milliseconds: number) => Promise<void>;
  ensureAttempt?: typeof ensureGameProvisionedWithGsm;
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
  const launchScopedExactPidAfterAttempts = Math.max(
    0,
    options.launchScopedExactPidAfterAttempts ?? 4
  );
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const ensureAttempt = dependencies.ensureAttempt ?? ensureGameProvisionedWithGsm;

  let lastResult: GameProvisioningResult = {
    status: "target-not-ready",
    reason: "The game provisioning target is not ready yet.",
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const resolver = createForegroundGameCaptureTargetResolver(
      dependencies,
      {
        enforceProcessId: attempt < pidStrictAttempts,
        allowLaunchScopedExactPid:
          attempt >= launchScopedExactPidAfterAttempts,
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