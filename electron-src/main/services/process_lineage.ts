import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRelationship {
  pid: number;
  parentPid: number;
  executableName?: string;
  /** Main top-level window title observed for this exact PID, when available. */
  windowTitle?: string;
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
    Name?: unknown;
    executableName?: unknown;
    MainWindowTitle?: unknown;
    windowTitle?: unknown;
  };
  const pid = Number(item.ProcessId ?? item.pid);
  const parentPid = Number(item.ParentProcessId ?? item.parentPid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) {
    return null;
  }
  const executableNameRaw = item.Name ?? item.executableName;
  const executableName =
    typeof executableNameRaw === "string" && executableNameRaw.trim()
      ? executableNameRaw.trim()
      : undefined;
  const windowTitleRaw = item.MainWindowTitle ?? item.windowTitle;
  const windowTitle =
    typeof windowTitleRaw === "string" && windowTitleRaw.trim()
      ? windowTitleRaw.trim()
      : undefined;
  return {
    pid,
    parentPid,
    ...(executableName ? { executableName } : {}),
    ...(windowTitle ? { windowTitle } : {}),
  };
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
    "$titles=@{}",
    "Get-Process -ErrorAction SilentlyContinue | ForEach-Object {$titles[$_.Id]=$_.MainWindowTitle}",
    "$items=Get-CimInstance Win32_Process",
    "$rows=foreach($item in $items){$title=$titles[$item.ProcessId];[pscustomobject]@{ProcessId=$item.ProcessId;ParentProcessId=$item.ParentProcessId;Name=$item.Name;MainWindowTitle=$title}}",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    }
  );
  const raw = String(stdout).trim();
  if (!raw) {
    return [];
  }
  return normalizeProcessRelationships(JSON.parse(raw));
}

export class LaunchProcessTree {
  readonly rootPid: number;
  private readonly knownPids = new Set<number>();
  private readonly executableNames = new Map<number, string>();
  private readonly windowTitles = new Map<number, string>();

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
        if (this.knownPids.has(relationship.pid)) {
          if (relationship.executableName) {
            this.executableNames.set(
              relationship.pid,
              relationship.executableName
            );
          }
          if (relationship.windowTitle) {
            this.windowTitles.set(
              relationship.pid,
              relationship.windowTitle
            );
          }
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

  getKnownProcesses(): Array<{
    pid: number;
    executableName?: string;
    windowTitle?: string;
  }> {
    return this.getKnownPids().map((pid) => ({
      pid,
      ...(this.executableNames.get(pid)
        ? { executableName: this.executableNames.get(pid) }
        : {}),
      ...(this.windowTitles.get(pid)
        ? { windowTitle: this.windowTitles.get(pid) }
        : {}),
    }));
  }

  seedProvenPids(pids: Iterable<number>): void {
    for (const rawPid of pids) {
      const pid = Math.trunc(rawPid);
      if (pid > 0) {
        this.knownPids.add(pid);
      }
    }
  }

  hasLivingProcess(relationships: Iterable<ProcessRelationship>): boolean {
    const live = new Set<number>();
    for (const relationship of relationships) {
      live.add(relationship.pid);
    }
    return this.getKnownPids().some((pid) => live.has(pid));
  }
}
