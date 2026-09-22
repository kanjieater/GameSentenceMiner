import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const GAME_PROVISIONING_INBOX_DIR = "provisioning-requests";
export const GAME_PROVISIONING_REQUEST_MAX_AGE_MS = 30_000;

interface GameProvisioningInboxRecord {
  version: 1;
  createdAtMs: number;
  args: string[];
}

export interface PendingGameProvisioningRequest {
  path: string;
  args: string[];
}

export function getGameProvisioningInboxDir(baseDir: string): string {
  return path.join(baseDir, GAME_PROVISIONING_INBOX_DIR);
}

export function ensureGameProvisioningInbox(baseDir: string): string {
  const inboxDir = getGameProvisioningInboxDir(baseDir);
  fs.mkdirSync(inboxDir, { recursive: true });
  return inboxDir;
}

export function enqueueGameProvisioningRequest(
  baseDir: string,
  args: string[],
  createdAtMs: number = Date.now()
): string {
  const inboxDir = ensureGameProvisioningInbox(baseDir);
  const id = randomUUID();
  const temporaryPath = path.join(inboxDir, `${id}.tmp`);
  const requestPath = path.join(inboxDir, `${id}.json`);
  const record: GameProvisioningInboxRecord = {
    version: 1,
    createdAtMs,
    args: [...args],
  };

  fs.writeFileSync(temporaryPath, JSON.stringify(record), {
    encoding: "utf8",
    flag: "wx",
  });
  fs.renameSync(temporaryPath, requestPath);
  return requestPath;
}

export function listPendingGameProvisioningRequests(
  baseDir: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = GAME_PROVISIONING_REQUEST_MAX_AGE_MS
): PendingGameProvisioningRequest[] {
  const inboxDir = ensureGameProvisioningInbox(baseDir);
  const requests: PendingGameProvisioningRequest[] = [];

  for (const name of fs.readdirSync(inboxDir).sort()) {
    if (!name.endsWith(".json")) {
      continue;
    }

    const requestPath = path.join(inboxDir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    } catch {
      fs.rmSync(requestPath, { force: true });
      continue;
    }

    const record = parsed as Partial<GameProvisioningInboxRecord>;
    const valid =
      record.version === 1 &&
      Number.isFinite(record.createdAtMs) &&
      Array.isArray(record.args) &&
      record.args.length > 0 &&
      record.args.every((value) => typeof value === "string");

    if (!valid) {
      fs.rmSync(requestPath, { force: true });
      continue;
    }

    const ageMs = nowMs - Number(record.createdAtMs);
    if (ageMs < 0 || ageMs > maxAgeMs) {
      fs.rmSync(requestPath, { force: true });
      continue;
    }

    requests.push({
      path: requestPath,
      args: [...(record.args as string[])],
    });
  }

  return requests;
}

export function completeGameProvisioningRequest(requestPath: string): void {
  fs.rmSync(requestPath, { force: true });
}
