import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRelationship {
  pid: number;
  parentPid: number;
}

function normalizeProcessRelationship(value: unknown): ProcessRelationship | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as {
    ProcessId?: unknown;
    ParentProcessId?: unknown;
    pid?: unknown;
    parentPid?: unknown;
  };
  const pid = Number(item.ProcessId ?? item.pid);
  const parentPid = Number(item.ParentProcessId ?? item.parentPid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) {
    return null;
  }
  return { pid, parentPid };
}

export function normalizeProcessRelationships(value: unknown): ProcessRelationship[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map(normalizeProcessRelationship)
    .filter((item): item is ProcessRelationship => item !== null);
}

/**
 * Snapshot the live Windows process parent relationships.
 *
 * A full snapshot lets launch tracking retain descendants after an intermediate
 * launcher exits. This is used only for first-time/launch-scoped provisioning,
 * not as a general high-frequency process monitor.
 */
export async function getWindowsProcessRelationships(): Promise<ProcessRelationship[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const script = [
    "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
  ].join("; ");

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  const raw = stdout.trim();
  if (!raw) {
    return [];
  }
  return normalizeProcessRelationships(JSON.parse(raw));
}

export class LaunchProcessTree {
  readonly rootPid: number;
  private readonly knownPids = new Set<number>();

  constructor(rootPid: number) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      throw new Error("Launch process tree requires a positive root PID.");
    }
    this.rootPid = rootPid;
    this.knownPids.add(rootPid);
  }

  observe(relationships: Iterable<ProcessRelationship>): void {
    const remaining = [...relationships];
    let changed = true;
    while (changed) {
      changed = false;
      for (const relationship of remaining) {
        if (
          !this.knownPids.has(relationship.pid) &&
          this.knownPids.has(relationship.parentPid)
        ) {
          this.knownPids.add(relationship.pid);
          changed = true;
        }
      }
    }
  }

  owns(pid: number): boolean {
    return this.knownPids.has(pid);
  }

  getKnownPids(): number[] {
    return [...this.knownPids].sort((left, right) => left - right);
  }

  hasLivingProcess(relationships: Iterable<ProcessRelationship>): boolean {
    const live = new Set<number>();
    for (const relationship of relationships) {
      live.add(relationship.pid);
    }
    return this.getKnownPids().some((pid) => live.has(pid));
  }
}
