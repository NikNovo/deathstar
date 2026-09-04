import { basename } from "node:path";
import type { EventRecord, HealthSnapshot } from "./types.ts";

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
    })),
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
