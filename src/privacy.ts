import { basename } from "node:path";
import type { EventRecord, HealthSnapshot, InventoryAssociation, InventoryGroup, InventoryProcess, InventorySnapshot } from "./types.ts";

const EVENT_MESSAGES: Record<EventRecord["kind"], string> = {
  "omp-exited": "OMP process disappeared",
  "omp-restarted": "OMP process restarted",
  "oom-increased": "OOM counter increased",
  "source-error": "Optional integration unavailable",
  threshold: "Host health changed",
  "memory-growth": "OMP memory growth detected",
  "cleanup-unavailable": "Memory cleanup unavailable",
  "cleanup-auto": "Automatic cleanup completed",
};

const SAFE_DETAIL_KEYS = new Set([
  "previousCount",
  "currentCount",
  "previousPid",
  "currentPid",
  "elapsedMs",
  "cgroupShared",
  "shared",
  "sessions",
  "source",
  "status",
]);

function publicCommand(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const executable = tokens.find((token) => basename(token) === "omp") || tokens[0];
  return executable ? basename(executable) : "unknown";
}

export function publicSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
  return {
    ...snapshot,
    host: {
      ...snapshot.host,
      errors: snapshot.host.errors.length ? ["Host collector reported an unavailable signal"] : [],
    },
    collectorErrors: snapshot.collectorErrors.length ? ["Optional integration unavailable"] : [],
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      directory: null,
      paneId: null,
      cgroupPath: null,
      error: session.error ? "Session integration unavailable" : null,
      processes: session.processes.map((process) => ({
        ...process,
        command: publicCommand(process.command),
        cwd: null,
      })),
      paneProcesses: session.paneProcesses.map((process) => ({
        ...process,
        command: publicCommand(process.command),
        cwd: null,
      })),
    })),
  };
}

function publicInventoryCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "unknown";
  const withoutResume = trimmed
    .replace(/--resume[=\s]+\S+/g, "--resume <session>")
    .replace(/\/[^\s]*\.jsonl?/g, "<session>");
  const tokens = withoutResume.split(/\s+/).filter(Boolean);
  const executable = tokens.find((token) => basename(token) === "omp") || tokens[0];
  return executable ? basename(executable) : "unknown";
}

function publicInventoryProcess(process: InventoryProcess): InventoryProcess {
  return {
    ...process,
    command: publicInventoryCommand(process.command),
    association: publicInventoryAssociation(process.association),
  };
}

function publicInventoryAssociation(association: InventoryAssociation): InventoryAssociation {
  if (association === "unassociated" || association === "ambiguous") return association;
  if (association.startsWith("session:")) return "session:<name>";
  return "shared-cgroup:<sessions>";
}

function publicInventoryGroup(group: InventoryGroup): InventoryGroup {
  return {
    ...group,
    key: publicInventoryAssociation(group.key as InventoryAssociation) as string,
    label: "Group",
    top: group.top.map(publicInventoryProcess),
    all: group.all.map(publicInventoryProcess),
  };
}

export function publicInventory(snapshot: InventorySnapshot): InventorySnapshot {
  return {
    ...snapshot,
    error: snapshot.error ? "Inventory collection unavailable" : null,
    processes: snapshot.processes.map(publicInventoryProcess),
    allProcesses: snapshot.allProcesses.map(publicInventoryProcess),
    groups: snapshot.groups.map(publicInventoryGroup),
  };
}

export function publicEvent(event: EventRecord): EventRecord {
  const details = Object.fromEntries(
    Object.entries(event.details).filter(([key]) => SAFE_DETAIL_KEYS.has(key)),
  ) as EventRecord["details"];
  return {
    ...event,
    message: EVENT_MESSAGES[event.kind],
    details,
  };
}
