import { describe, expect, it, vi } from "vitest";
import {
  dispatchGameProvisioningCommand,
  hasEnsureGameCommand,
  parseGameProvisioningCommand,
} from "./game_provisioning_command.js";

describe("game provisioning command transport", () => {
  it("parses Playnite ensure-game argv", () => {
    expect(
      parseGameProvisioningCommand([
        "--ensure-game",
        "Arc the Lad II",
        "--external-id",
        "playnite:abc",
        "--pid",
        "4242",
      ])
    ).toEqual({
      kind: "ensure-game",
      request: {
        displayName: "Arc the Lad II",
        externalId: "playnite:abc",
        processId: 4242,
        defaultMode: "ocr",
      },
    });
  });

  it("allows PID to be omitted", () => {
    const parsed = parseGameProvisioningCommand([
      "--ensure-game",
      "Arc the Lad II",
      "--external-id",
      "playnite:abc",
    ]);
    expect(parsed).toEqual({
      kind: "ensure-game",
      request: {
        displayName: "Arc the Lad II",
        externalId: "playnite:abc",
        defaultMode: "ocr",
      },
    });
  });

  it("rejects missing stable external identity", () => {
    expect(
      parseGameProvisioningCommand(["--ensure-game", "Arc the Lad II"])
    ).toEqual(
      expect.objectContaining({
        kind: "invalid",
        reason: expect.stringContaining("--external-id"),
      })
    );
  });

  it("rejects invalid PID values", () => {
    expect(
      parseGameProvisioningCommand([
        "--ensure-game",
        "Arc the Lad II",
        "--external-id",
        "playnite:abc",
        "--pid",
        "0",
      ]).kind
    ).toBe("invalid");
  });

  it("ignores unrelated startup argv", () => {
    expect(parseGameProvisioningCommand(["--ocr"])).toEqual({ kind: "none" });
    expect(hasEnsureGameCommand(["--ocr"])).toBe(false);
  });

  it("serializes duplicate external-id requests so provisioning cannot race", async () => {
    const args = [
      "--ensure-game",
      "Arc the Lad II",
      "--external-id",
      "playnite:abc",
    ];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let configured = false;
    let createCount = 0;
    let active = 0;
    let maxActive = 0;

    const ensureGame = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (!configured) {
          createCount += 1;
          await firstGate;
          configured = true;
          return {
            status: "provisioned" as const,
            scene: { id: "scene-1", name: "Arc the Lad II" },
            createdScene: true,
            updatedProfile: true,
          };
        }

        return {
          status: "already-configured" as const,
          scene: { id: "scene-1", name: "Arc the Lad II" },
          createdScene: false,
          updatedProfile: false,
        };
      } finally {
        active -= 1;
      }
    });

    const first = dispatchGameProvisioningCommand(args, ensureGame);
    await Promise.resolve();

    const second = dispatchGameProvisioningCommand(args, ensureGame);
    await Promise.resolve();

    expect(ensureGame).toHaveBeenCalledTimes(1);
    expect(createCount).toBe(1);

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(
      expect.objectContaining({
        handled: true,
        result: expect.objectContaining({ status: "provisioned" }),
      })
    );
    expect(secondResult).toEqual(
      expect.objectContaining({
        handled: true,
        result: expect.objectContaining({ status: "already-configured" }),
      })
    );
    expect(ensureGame).toHaveBeenCalledTimes(2);
    expect(createCount).toBe(1);
    expect(maxActive).toBe(1);
  });

  it("serializes same-scene requests across different external IDs", async () => {
    const firstArgs = [
      "--ensure-game",
      "Arc the Lad II",
      "--external-id",
      "playnite:first",
    ];
    const secondArgs = [
      "--ensure-game",
      "Arc the Lad II",
      "--external-id",
      "playnite:second",
    ];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sceneExists = false;
    let createCount = 0;
    let active = 0;
    let maxActive = 0;

    const ensureGame = vi.fn(async (request: { externalId?: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (!sceneExists) {
          createCount += 1;
          await firstGate;
          sceneExists = true;
          return {
            status: "provisioned" as const,
            scene: { id: "scene-1", name: "Arc the Lad II" },
            createdScene: true,
            updatedProfile: true,
          };
        }

        return {
          status: "failed" as const,
          reason:
            "A scene named \"Arc the Lad II\" already exists and is owned by another external identity.",
        };
      } finally {
        active -= 1;
      }
    });

    const first = dispatchGameProvisioningCommand(firstArgs, ensureGame);
    await Promise.resolve();

    const second = dispatchGameProvisioningCommand(secondArgs, ensureGame);
    await Promise.resolve();

    expect(ensureGame).toHaveBeenCalledTimes(1);
    expect(createCount).toBe(1);

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(
      expect.objectContaining({
        handled: true,
        result: expect.objectContaining({ status: "provisioned" }),
      })
    );
    expect(secondResult).toEqual(
      expect.objectContaining({
        handled: true,
        result: expect.objectContaining({ status: "failed" }),
      })
    );
    expect(ensureGame).toHaveBeenCalledTimes(2);
    expect(createCount).toBe(1);
    expect(maxActive).toBe(1);
  });

  it("uses the same dispatcher for startup or second-instance argv", async () => {
    const ensureGame = vi.fn(async () => ({
      status: "already-configured" as const,
      scene: { id: "scene-1", name: "Arc the Lad II" },
      createdScene: false,
      updatedProfile: false,
    }));
    const args = [
      "--ensure-game",
      "Arc the Lad II",
      "--external-id",
      "playnite:abc",
    ];

    const result = await dispatchGameProvisioningCommand(args, ensureGame);

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        result: expect.objectContaining({ status: "already-configured" }),
      })
    );
    expect(ensureGame).toHaveBeenCalledWith({
      displayName: "Arc the Lad II",
      externalId: "playnite:abc",
      defaultMode: "ocr",
    });
  });
});