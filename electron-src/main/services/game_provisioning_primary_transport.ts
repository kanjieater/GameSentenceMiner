import * as fs from "node:fs";
import * as path from "node:path";

import { GAME_PROVISIONING_TOKEN_PREFIX } from "./game_provisioning_command.js";

export const GAME_PROVISIONING_PRIMARY_TRANSPORT_FILE =
  "game-provisioning-primary-transport.txt";

export interface GameProvisioningPrimaryTransport {
  version: 1;
  pid: number;
  executablePath: string;
  workingDirectory: string;
  argumentPrefix: string[];
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function buildGameProvisioningPrimaryTransport(
  pid: number,
  executablePath: string,
  argv: string[],
  workingDirectory: string = process.cwd()
): GameProvisioningPrimaryTransport {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Primary transport PID must be a positive integer.");
  }
  if (!executablePath.trim()) {
    throw new Error("Primary transport executable path is required.");
  }
  if (!workingDirectory.trim()) {
    throw new Error("Primary transport working directory is required.");
  }

  return {
    version: 1,
    pid,
    executablePath,
    workingDirectory,
    argumentPrefix: argv
      .slice(1)
      .filter((arg) => !arg.startsWith(GAME_PROVISIONING_TOKEN_PREFIX)),
  };
}

export function getGameProvisioningPrimaryTransportPath(
  baseDir: string
): string {
  return path.join(
    baseDir,
    "runtime",
    GAME_PROVISIONING_PRIMARY_TRANSPORT_FILE
  );
}

export function serializeGameProvisioningPrimaryTransport(
  transport: GameProvisioningPrimaryTransport
): string {
  const lines = [
    "version=1",
    `pid=${transport.pid}`,
    `executable=${encode(transport.executablePath)}`,
    `workdir=${encode(transport.workingDirectory)}`,
    `argc=${transport.argumentPrefix.length}`,
    ...transport.argumentPrefix.map(
      (arg, index) => `arg${index}=${encode(arg)}`
    ),
  ];
  return lines.join("\n") + "\n";
}

export function writeGameProvisioningPrimaryTransport(
  baseDir: string,
  transport: GameProvisioningPrimaryTransport
): string {
  const target = getGameProvisioningPrimaryTransportPath(baseDir);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });

  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporary,
    serializeGameProvisioningPrimaryTransport(transport),
    "utf8"
  );
  fs.renameSync(temporary, target);
  return target;
}

export function clearGameProvisioningPrimaryTransport(
  baseDir: string,
  pid: number
): void {
  const target = getGameProvisioningPrimaryTransportPath(baseDir);
  try {
    const current = fs.readFileSync(target, "utf8");
    if (!current.split(/\r?\n/).includes(`pid=${pid}`)) {
      return;
    }
    fs.rmSync(target, { force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}
