import { describe, expect, it } from "vitest";

import {
  buildGameProvisioningPrimaryTransport,
  serializeGameProvisioningPrimaryTransport,
} from "./game_provisioning_primary_transport.js";

describe("game provisioning primary transport", () => {
  it("publishes packaged launches without a prefix", () => {
    const transport = buildGameProvisioningPrimaryTransport(
      1234,
      "C:\\Program Files\\GameSentenceMiner\\GameSentenceMiner.exe",
      ["C:\\Program Files\\GameSentenceMiner\\GameSentenceMiner.exe"]
    );

    expect(transport.argumentPrefix).toEqual([]);
    expect(transport.pid).toBe(1234);
  });

  it("retains the Electron app path for source launches but strips provisioning tokens", () => {
    const transport = buildGameProvisioningPrimaryTransport(
      4321,
      "C:\\repo\\node_modules\\electron\\dist\\electron.exe",
      [
        "C:\\repo\\node_modules\\electron\\dist\\electron.exe",
        "C:\\repo",
        "gsm-provision-v1-old-token",
      ]
    );

    expect(transport.argumentPrefix).toEqual(["C:\\repo"]);
  });

  it("serializes a bridge-readable line protocol", () => {
    const serialized = serializeGameProvisioningPrimaryTransport({
      version: 1,
      pid: 99,
      executablePath: "C:\\gsm\\electron.exe",
      workingDirectory: "C:\\repo",
      argumentPrefix: ["C:\\repo", "--flag"],
    });

    expect(serialized).toContain("version=1\n");
    expect(serialized).toContain("pid=99\n");
    expect(serialized).toContain("argc=2\n");
    expect(serialized).toContain(
      "workdir=" + Buffer.from("C:\\repo").toString("base64")
    );
    expect(serialized).toContain(
      "executable=" + Buffer.from("C:\\gsm\\electron.exe").toString("base64")
    );
    expect(serialized).toContain(
      "arg0=" + Buffer.from("C:\\repo").toString("base64")
    );
  });
});
