import type { Clock } from "./clock.ts";
import type { HerdrSource } from "./sources/herdr.ts";
import type { ProcSource } from "./sources/proc.ts";
import type { EventRecord, HealthSnapshot, HealthState, HostSnapshot, SessionSnapshot } from "./types.ts";

export interface CollectorOptions {
  clock: Clock;
  hostSource: Pick<ProcSource, "readHost">;
  herdrSource: Pick<HerdrSource, "listSessions">;
  stateConfirmSamples?: number;
  stateRecoveryConfirmSamples?: number;
  memoryGrowthBytes?: number;
  memoryGrowthWindowMs?: number;
}

export interface CollectedHealth {
  snapshot: HealthSnapshot;
  events: EventRecord[];
}

export interface Collector {
  collect(): Promise<CollectedHealth>;
}

function ompPid(session: SessionSnapshot): number | null {
  return session.ompPid;
}
function sessionRss(session: SessionSnapshot): number {
  return session.processes.reduce((total, process) => total + process.rssBytes, 0);
}

const STATE_RANK: Record<HealthState, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };

function eventRecord(
  observedAt: string,
  kind: EventRecord["kind"],
  severity: EventRecord["severity"],
  session: string | null,
  message: string,
  details: EventRecord["details"],
): EventRecord {
  return { observedAt, kind, severity, session, message, details };
}

function diffSnapshots(previous: HealthSnapshot | null, current: HealthSnapshot): EventRecord[] {
  if (!previous) return [];
  const events: EventRecord[] = [];
  const previousSessions = new Map(previous.sessions.map((session) => [session.name, session]));
  const previousGroups = new Map<string, { count: number; sessions: string[]; shared: boolean }>();
  const currentGroups = new Map<string, { count: number; sessions: string[]; shared: boolean }>();

  for (const session of previous.sessions) {
    if (!session.cgroupPath || session.cgroupOomKillCount === null) continue;
    const group = previousGroups.get(session.cgroupPath) || { count: session.cgroupOomKillCount, sessions: [], shared: false };
    group.count = Math.max(group.count, session.cgroupOomKillCount);
    group.sessions.push(session.name);
    group.shared ||= session.cgroupShared;
    previousGroups.set(session.cgroupPath, group);
  }

  for (const session of current.sessions) {
    const prior = previousSessions.get(session.name);
    if (prior) {
      const priorPid = ompPid(prior);
      const currentPid = ompPid(session);
      if (priorPid !== null && currentPid === null) {
        events.push(eventRecord(current.observedAt, "omp-exited", "critical", session.name, "OMP process disappeared", { previousPid: priorPid }));
      } else if (priorPid !== null && currentPid !== null && priorPid !== currentPid) {
        events.push(eventRecord(current.observedAt, "omp-restarted", "warning", session.name, "OMP process PID changed", { previousPid: priorPid, currentPid }));
      }
    }
    if (!session.cgroupPath || session.cgroupOomKillCount === null) continue;
    const group = currentGroups.get(session.cgroupPath) || { count: session.cgroupOomKillCount, sessions: [], shared: false };
    group.count = Math.max(group.count, session.cgroupOomKillCount);
    group.sessions.push(session.name);
    group.shared ||= session.cgroupShared;
    currentGroups.set(session.cgroupPath, group);
  }

  for (const [cgroupPath, group] of currentGroups) {
    const previousGroup = previousGroups.get(cgroupPath);
    const previousCount = previousGroup?.count ?? 0;
    if (group.count <= previousCount) continue;
    const uniqueSessions = [...new Set(group.sessions)];
    const shared = group.shared || uniqueSessions.length > 1;
    const session = uniqueSessions.length === 1 && !shared ? uniqueSessions[0]! : null;
    events.push(eventRecord(current.observedAt, "oom-increased", "critical", session, "Session cgroup OOM counter increased", {
      previousCount,
      currentCount: group.count,
      cgroupPath,
      sessions: uniqueSessions.join(","),
      shared,
    }));
  }

  if (current.host.oomKillCount > previous.host.oomKillCount) {
    events.push(eventRecord(current.observedAt, "oom-increased", "critical", null, "Aggregate cgroup OOM counter increased", {
      previousCount: previous.host.oomKillCount,
      currentCount: current.host.oomKillCount,
    }));
  }

  if (current.host.state !== previous.host.state) {
    const severity: EventRecord["severity"] = current.host.state === "critical"
      ? "critical"
      : current.host.state === "warning"
        ? "warning"
        : "info";
    events.push(eventRecord(current.observedAt, "threshold", severity, null, `Host health changed to ${current.host.state}`, {
      previousState: previous.host.state,
      currentState: current.host.state,
    }));
  }

  return events;
}

function withObservationTime(host: HostSnapshot, observedAt: string): HostSnapshot {
  return { ...host, observedAt };
}

function withSessionObservationTime(session: SessionSnapshot, observedAt: string): SessionSnapshot {
  return { ...session, observedAt };
}

export function createCollector(options: CollectorOptions): Collector {
  let previous: HealthSnapshot | null = null;
  const stateConfirmSamples = options.stateConfirmSamples ?? 2;
  const stateRecoveryConfirmSamples = options.stateRecoveryConfirmSamples ?? 3;
  const memoryGrowthBytes = options.memoryGrowthBytes ?? 512 * 1024 ** 2;
  const memoryGrowthWindowMs = options.memoryGrowthWindowMs ?? 5 * 60 * 1000;
  let stableHostState: HealthState | null = null;
  let pendingHostState: HealthState | null = null;
  let pendingHostSamples = 0;
  const growthBaselines = new Map<string, { pid: number; observedAtMs: number; rssBytes: number }>();

  function stabilizeHost(host: HostSnapshot): HostSnapshot {
    const rawState = host.state;
    if (stableHostState === null) {
      stableHostState = rawState;
      return { ...host, state: rawState };
    }
    if (rawState === stableHostState) {
      pendingHostState = null;
      pendingHostSamples = 0;
      return { ...host, state: stableHostState };
    }
    const rawRank = STATE_RANK[rawState];
    const stableRank = STATE_RANK[stableHostState];
    if (pendingHostState === rawState) pendingHostSamples += 1;
    else {
      pendingHostState = rawState;
      pendingHostSamples = 1;
    }
    const requiredSamples = rawRank > stableRank ? stateConfirmSamples : stateRecoveryConfirmSamples;
    if (pendingHostSamples >= requiredSamples) {
      stableHostState = rawState;
      pendingHostState = null;
      pendingHostSamples = 0;
    }
    return { ...host, state: stableHostState };
  }

  function growthEvents(snapshot: HealthSnapshot, observedAtMs: number): EventRecord[] {
    const events: EventRecord[] = [];
    const currentNames = new Set<string>();
    for (const session of snapshot.sessions) {
      currentNames.add(session.name);
      if (session.ompPid === null) {
        growthBaselines.delete(session.name);
        continue;
      }
      const rssBytes = sessionRss(session);
      const baseline = growthBaselines.get(session.name);
      if (!baseline || baseline.pid !== session.ompPid) {
        growthBaselines.set(session.name, { pid: session.ompPid, observedAtMs, rssBytes });
        continue;
      }
      const elapsedMs = observedAtMs - baseline.observedAtMs;
      if (elapsedMs < memoryGrowthWindowMs) continue;
      if (rssBytes - baseline.rssBytes >= memoryGrowthBytes) {
        events.push(eventRecord(snapshot.observedAt, "memory-growth", "warning", session.name, "Foreground OMP memory increased", {
          previousRssBytes: baseline.rssBytes,
          currentRssBytes: rssBytes,
          elapsedMs,
          cgroupShared: session.cgroupShared,
        }));
      }
      growthBaselines.set(session.name, { pid: session.ompPid, observedAtMs, rssBytes });
    }
    for (const name of growthBaselines.keys()) {
      if (!currentNames.has(name)) growthBaselines.delete(name);
    }
    return events;
  }

  return {
    async collect() {
      const observedAt = options.clock.now().toISOString();
      const [hostResult, sessionsResult] = await Promise.allSettled([
        options.hostSource.readHost(),
        options.herdrSource.listSessions(),
      ]);
      if (hostResult.status === "rejected") throw hostResult.reason;
      const host = hostResult.value;
      const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
      const collectorErrors = sessionsResult.status === "fulfilled" ? [] : ["Herdr integration unavailable"];
      const integrationEvents = collectorErrors.length === 0
        ? []
        : [eventRecord(observedAt, "source-error", "warning", null, "Herdr integration unavailable", { source: "herdr" })];
      const observedHost = withObservationTime(stabilizeHost(host), observedAt);
      const observedSessions = sessions.map((session) => withSessionObservationTime(session, observedAt));
      const snapshot: HealthSnapshot = {
        observedAt,
        host: observedHost,
        sessions: observedSessions,
        ompCount: observedSessions.filter((session) => session.ompPid !== null).length,
        herdrSessionCount: observedSessions.length,
        collectorErrors,
      };
      const events = [...diffSnapshots(previous, snapshot), ...growthEvents(snapshot, Date.parse(observedAt)), ...integrationEvents];
      previous = snapshot;
      return { snapshot, events };
    },
  };
}
