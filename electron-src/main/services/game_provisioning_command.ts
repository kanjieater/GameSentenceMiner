import type {
  GameProvisioningRequest,
  GameProvisioningResult,
} from "./game_provisioning.js";

export type ParsedGameProvisioningCommand =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "ensure-game"; request: GameProvisioningRequest };

export interface GameProvisioningSingleInstanceData {
  gameProvisioningArgs?: string[];
}

export function createGameProvisioningSingleInstanceData(
  args: string[]
): GameProvisioningSingleInstanceData | undefined {
  if (!hasEnsureGameCommand(args)) {
    return undefined;
  }
  return { gameProvisioningArgs: [...args] };
}

export function getGameProvisioningSecondInstanceArgs(
  commandLine: string[],
  additionalData: unknown
): string[] {
  if (
    additionalData &&
    typeof additionalData === "object" &&
    Array.isArray(
      (additionalData as GameProvisioningSingleInstanceData)
        .gameProvisioningArgs
    )
  ) {
    const args = (
      additionalData as GameProvisioningSingleInstanceData
    ).gameProvisioningArgs;
    if (args && args.every((value) => typeof value === "string")) {
      return [...args];
    }
  }

  return [...commandLine];
}

function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const value = args[index + 1];
    if (typeof value === "string" && !value.startsWith("--")) {
      values.push(value);
    } else {
      values.push("");
    }
  }
  return values;
}

export function hasEnsureGameCommand(args: string[]): boolean {
  return args.includes("--ensure-game");
}

export function parseGameProvisioningCommand(
  args: string[]
): ParsedGameProvisioningCommand {
  const names = collectFlagValues(args, "--ensure-game");
  if (names.length === 0) {
    return { kind: "none" };
  }
  if (names.length !== 1 || !names[0].trim()) {
    return {
      kind: "invalid",
      reason: "--ensure-game requires exactly one non-empty game name.",
    };
  }

  const externalIds = collectFlagValues(args, "--external-id");
  if (externalIds.length !== 1 || !externalIds[0].trim()) {
    return {
      kind: "invalid",
      reason:
        "--ensure-game requires exactly one non-empty --external-id value.",
    };
  }

  const pidValues = collectFlagValues(args, "--pid");
  if (pidValues.length > 1) {
    return {
      kind: "invalid",
      reason: "--pid may be supplied at most once.",
    };
  }

  let processId: number | undefined;
  if (pidValues.length === 1) {
    const parsed = Number(pidValues[0]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        kind: "invalid",
        reason: "--pid must be a positive integer when supplied.",
      };
    }
    processId = parsed;
  }

  return {
    kind: "ensure-game",
    request: {
      displayName: names[0].trim(),
      externalId: externalIds[0].trim(),
      ...(processId ? { processId } : {}),
      defaultMode: "ocr",
    },
  };
}

let provisioningCommandTail: Promise<void> = Promise.resolve();

async function runProvisioningSerialized<T>(
  operation: () => Promise<T>
): Promise<T> {
  const previous = provisioningCommandTail;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  provisioningCommandTail = tail;

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (provisioningCommandTail === tail) {
      provisioningCommandTail = Promise.resolve();
    }
  }
}

export async function dispatchGameProvisioningCommand(
  args: string[],
  ensureGame: (
    request: GameProvisioningRequest
  ) => Promise<GameProvisioningResult>
): Promise<
  | { handled: false }
  | { handled: true; error: string }
  | { handled: true; result: GameProvisioningResult }
> {
  const parsed = parseGameProvisioningCommand(args);
  if (parsed.kind === "none") {
    return { handled: false };
  }
  if (parsed.kind === "invalid") {
    return { handled: true, error: parsed.reason };
  }

  return {
    handled: true,
    result: await runProvisioningSerialized(
      () => ensureGame(parsed.request)
    ),
  };
}