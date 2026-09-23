import { describe, expect, it } from "vitest";
import {
  LaunchProcessTree,
  normalizeProcessRelationships,
} from "./process_lineage.js";

describe("launch process lineage", () => {
  it("tracks descendants transitively and retains them after parents disappear", () => {
    const tree = new LaunchProcessTree(100);

    tree.observe([
      { pid: 200, parentPid: 100 },
      { pid: 300, parentPid: 200 },
      { pid: 400, parentPid: 999 },
    ]);

    expect(tree.getKnownPids()).toEqual([100, 200, 300]);
    expect(tree.owns(300)).toBe(true);
    expect(tree.owns(400)).toBe(false);

    // The parent can disappear from later snapshots; already-proven descendants
    // remain launch-owned for the lifetime of this tracker.
    tree.observe([{ pid: 300, parentPid: 200 }]);
    expect(tree.owns(300)).toBe(true);
  });

  it("can discover a direct child even when the root already exited", () => {
    const tree = new LaunchProcessTree(100);

    tree.observe([{ pid: 200, parentPid: 100 }]);

    expect(tree.owns(200)).toBe(true);
  });

  it("does not infer ancestry through an unobserved missing intermediate process", () => {
    const tree = new LaunchProcessTree(100);

    tree.observe([{ pid: 300, parentPid: 200 }]);

    expect(tree.owns(300)).toBe(false);
  });

  it("reports whether any proven launch process is still alive", () => {
    const tree = new LaunchProcessTree(100);
    tree.observe([{ pid: 200, parentPid: 100 }]);

    expect(
      tree.hasLivingProcess([
        { pid: 200, parentPid: 100 },
        { pid: 999, parentPid: 1 },
      ])
    ).toBe(true);
    expect(
      tree.hasLivingProcess([{ pid: 999, parentPid: 1 }])
    ).toBe(false);
  });

  it("normalizes PowerShell/CIM JSON shapes", () => {
    expect(
      normalizeProcessRelationships([
        { ProcessId: 100, ParentProcessId: 1 },
        { ProcessId: "200", ParentProcessId: "100" },
        { ProcessId: 0, ParentProcessId: 1 },
      ])
    ).toEqual([
      { pid: 100, parentPid: 1 },
      { pid: 200, parentPid: 100 },
    ]);
  });
});
