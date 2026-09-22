import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeGameProvisioningRequest,
  enqueueGameProvisioningRequest,
  getGameProvisioningInboxDir,
  listPendingGameProvisioningRequests,
} from "./game_provisioning_inbox.js";

const tempDirs: string[] = [];

function makeBaseDir(): string {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-provisioning-inbox-"));
  tempDirs.push(baseDir);
  return baseDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("game provisioning inbox", () => {
  it("atomically queues and reads exact provisioning args", () => {
    const baseDir = makeBaseDir();
    const args = [
      "--ensure-game",
      "Arc the Lad II",
      "--external-id",
      "playnite:abc",
      "--pid",
      "4242",
    ];

    const requestPath = enqueueGameProvisioningRequest(baseDir, args, 1_000);
    expect(path.dirname(requestPath)).toBe(getGameProvisioningInboxDir(baseDir));
    expect(fs.readdirSync(getGameProvisioningInboxDir(baseDir))).toEqual([
      path.basename(requestPath),
    ]);

    const pending = listPendingGameProvisioningRequests(baseDir, 1_500);
    expect(pending).toEqual([{ path: requestPath, args }]);

    completeGameProvisioningRequest(requestPath);
    expect(listPendingGameProvisioningRequests(baseDir, 1_500)).toEqual([]);
  });

  it("drops stale requests so old game launches cannot provision later", () => {
    const baseDir = makeBaseDir();
    enqueueGameProvisioningRequest(
      baseDir,
      ["--ensure-game", "Arc the Lad II", "--external-id", "playnite:abc"],
      1_000
    );

    expect(listPendingGameProvisioningRequests(baseDir, 31_001)).toEqual([]);
    expect(fs.readdirSync(getGameProvisioningInboxDir(baseDir))).toEqual([]);
  });

  it("drops malformed request files", () => {
    const baseDir = makeBaseDir();
    const inboxDir = getGameProvisioningInboxDir(baseDir);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, "broken.json"), "{not-json", "utf8");

    expect(listPendingGameProvisioningRequests(baseDir, 1_000)).toEqual([]);
    expect(fs.readdirSync(inboxDir)).toEqual([]);
  });
});
