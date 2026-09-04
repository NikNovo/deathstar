import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomaticCleanupController } from "../src/auto-cleanup.ts";
import { FixedClock } from "../src/clock.ts";
import { createCollector } from "../src/collector.ts";
import { createSampler } from "../src/sampler.ts";
import type { CleanupResult } from "../src/memory-helper.ts";
import type { MaintenanceStatus } from "../src/maintenance.ts";
import { createStorage, type Storage } from "../src/storage.ts";
import type { EventRecord, HealthSnapshot, HostSnapshot, SessionSnapshot } from "../src/types.ts";

function host(oomKillCount: number, state: HostSnapshot["state"] = "ok"): HostSnapshot {
  return {
    observedAt: "",
    totalBytes: 16 * 1024 ** 3,
    usedBytes: 8 * 1024 ** 3,
    availableBytes: state === "warning" ? 3 * 1024 ** 3 : 8 * 1024 ** 3,
    freeBytes: 8 * 1024 ** 3,
    cacheBytes: 1 * 1024 ** 3,
    swapTotalBytes: 4 * 1024 ** 3,
    swapUsedBytes: 1 * 1024 ** 3,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    rootUsedBytes: 1,
    rootTotalBytes: 10,
    tmpUsedBytes: 2,
    tmpTotalBytes: 10,
    cgroupCurrentBytes: 8 * 1024 ** 3,
    cgroupLimitBytes: null,
    oomKillCount,
    memoryPressure: {
      some: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      full: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
    },
    state,
    errors: [],
  };
}

function session(pid: number | null, ompState: SessionSnapshot["ompState"] = "working", cgroupOomKillCount = 0): SessionSnapshot {
  return {
    name: "agent-alpha",
    status: "running",
    directory: "/synthetic/events",
    paneId: "w1:p1",
    agentStatus: "working",
    ompState,
    ompPid: pid,
    cgroupShared: false,
    processes: pid === null ? [] : [{
      pid,
      ppid: 1,
      command: "bun /synthetic/bin/omp",
      cwd: "/synthetic/events",
      rssBytes: 1024,
      virtualBytes: 2048,
      state: "S",
      startedAt: "2023-11-14T22:13:22.500Z",
    }],
    cgroupPath: "/session/events",
    cgroupCurrentBytes: 1024,
    cgroupPeakBytes: 2048,
    cgroupOomKillCount,
    observedAt: "",
    error: null,
  };
}

class FakeStorage implements Storage {
  snapshots: HealthSnapshot[] = [];
  eventsWritten: EventRecord[] = [];
  pruned: Date[] = [];

  insertSnapshot(snapshot: HealthSnapshot): void { this.snapshots.push(snapshot); }
  insertEvents(events: EventRecord[]): void { this.eventsWritten.push(...events); }
  current(): HealthSnapshot | null { return this.snapshots.at(-1) || null; }
  history(): { from: string; to: string; points: [] } { return { from: "", to: "", points: [] }; }
  events(): EventRecord[] { return this.eventsWritten; }
  prune(before: Date): void { this.pruned.push(before); }
  close(): void {}
}

test("collector emits restart, exit, OOM, and threshold events", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const hosts = [host(1), host(2, "warning"), host(2, "warning")];
  const sessions = [session(42, "working", 0), session(43, "working", 1), session(null, "missing")];
  const collector = createCollector({
    clock,
    hostSource: { readHost: async () => hosts.shift()! },
    herdrSource: { listSessions: async () => { const next = sessions.shift(); return next ? [next] : []; } },
  });

  const first = await collector.collect();
  clock.advance(5000);
  const second = await collector.collect();
  clock.advance(5000);
  const third = await collector.collect();
  expect(second.events.map((event) => event.kind)).toEqual(["omp-restarted", "oom-increased", "oom-increased"]);
  expect(second.events.filter((event) => event.kind === "oom-increased").map((event) => event.session)).toEqual(["agent-alpha", null]);
  expect(third.events.map((event) => event.kind)).toEqual(["omp-exited", "threshold"]);
});

test("keeps host health when the optional Herdr source is unavailable", async () => {
  const collector = createCollector({
    clock: new FixedClock(new Date("2026-08-20T12:00:00.000Z")),
    hostSource: { readHost: async () => host(0, "ok") },
    herdrSource: { listSessions: async () => { throw new Error("herdr binary not found"); } },
  });

  const result = await collector.collect();

  expect(result.snapshot.host.state).toBe("ok");
  expect(result.snapshot.sessions).toEqual([]);
  expect(result.snapshot.collectorErrors).toEqual(["Herdr integration unavailable"]);
  expect(result.events).toContainEqual(expect.objectContaining({
    kind: "source-error",
    severity: "warning",
    message: "Herdr integration unavailable",
    details: { source: "herdr" },
  }));
});
test("deduplicates OOM increments for shared cgroups", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const firstSessions = [
    { ...session(42, "working", 1), name: "left", cgroupPath: "/shared" },
    { ...session(43, "working", 1), name: "right", cgroupPath: "/shared" },
  ];
  const secondSessions = [
    { ...session(42, "working", 2), name: "left", cgroupPath: "/shared" },
    { ...session(43, "working", 2), name: "right", cgroupPath: "/shared" },
  ];
  const collector = createCollector({
    clock,
    hostSource: { readHost: async () => host(0) },
    herdrSource: {
      listSessions: async () => (firstSessions.length ? firstSessions.splice(0, 2) : secondSessions),
    },
  });

  await collector.collect();
  clock.advance(5000);
  const result = await collector.collect();
  const oomEvents = result.events.filter((event) => event.kind === "oom-increased");

  expect(oomEvents).toHaveLength(1);
  expect(oomEvents[0]).toMatchObject({
    session: null,
    details: { previousCount: 1, currentCount: 2, cgroupPath: "/shared", sessions: "left,right" },
  });
});
test("does not name a session when its cgroup is shared", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const first = { ...session(42, "working", 1), name: "left", cgroupPath: "/shared", cgroupShared: true };
  const second = { ...session(42, "working", 2), name: "left", cgroupPath: "/shared", cgroupShared: true };
  let call = 0;
  const collector = createCollector({
    clock,
    hostSource: { readHost: async () => host(0) },
    herdrSource: { listSessions: async () => [call++ === 0 ? first : second] },
  });

  await collector.collect();
  clock.advance(5000);
  const result = await collector.collect();

  expect(result.events.find((event) => event.kind === "oom-increased")).toMatchObject({
    session: null,
    details: { shared: true },
  });
});
test("keeps aggregate OOM when a mapped cgroup also increments", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  let call = 0;
  const collector = createCollector({
    clock,
    hostSource: { readHost: async () => host(call++ === 0 ? 1 : 2) },
    herdrSource: {
      listSessions: async () => call === 1
        ? [{ ...session(42, "working", 1), name: "left", cgroupPath: "/left" }, { ...session(43, "working", 0), name: "right", cgroupPath: "/right" }]
        : [{ ...session(42, "working", 2), name: "left", cgroupPath: "/left" }, { ...session(43, "working", 0), name: "right", cgroupPath: "/right" }],
    },
  });

  await collector.collect();
  clock.advance(5000);
  const result = await collector.collect();
  const oomEvents = result.events.filter((event) => event.kind === "oom-increased");

  expect(oomEvents).toHaveLength(2);
  expect(oomEvents.map((event) => event.session)).toEqual(["left", null]);
});
test("debounces threshold state transitions", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const rawStates: HostSnapshot["state"][] = ["ok", "critical", "warning", "critical", "critical", "warning", "warning", "warning"];
  const hosts = rawStates.map((state) => host(0, state));
  const snapshots: HealthSnapshot[] = [];
  const events: EventRecord[] = [];
  const collector = createCollector({
    clock,
    stateConfirmSamples: 2,
    stateRecoveryConfirmSamples: 3,
    hostSource: { readHost: async () => hosts.shift()! },
    herdrSource: { listSessions: async () => [] },
  } as never);

  for (let index = 0; index < rawStates.length; index += 1) {
    const result = await collector.collect();
    snapshots.push(result.snapshot);
    events.push(...result.events);
    clock.advance(5000);
  }

  expect(snapshots.map((snapshot) => snapshot.host.state)).toEqual([
    "ok", "ok", "ok", "ok", "critical", "critical", "critical", "warning",
  ]);
  expect(events.filter((event) => event.kind === "threshold")).toHaveLength(2);
});
test("emits a threshold event after stable recovery to ok", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const rawStates: HostSnapshot["state"][] = ["critical", "critical", "ok", "ok", "ok"];
  const hosts = rawStates.map((state) => host(0, state));
  const collector = createCollector({
    clock,
    stateConfirmSamples: 2,
    stateRecoveryConfirmSamples: 3,
    hostSource: { readHost: async () => hosts.shift()! },
    herdrSource: { listSessions: async () => [] },
  } as never);

  const events: EventRecord[] = [];
  for (let index = 0; index < rawStates.length; index += 1) {
    events.push(...(await collector.collect()).events);
    clock.advance(5000);
  }

  expect(events.filter((event) => event.kind === "threshold")).toContainEqual(expect.objectContaining({
    severity: "info",
    details: { previousState: "critical", currentState: "ok" },
  }));
});

test("emits foreground OMP memory growth after the configured window", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const initial = session(42);
  const growing = {
    ...initial,
    processes: [{ ...initial.processes[0]!, rssBytes: 1536 }],
  };
  const sessions = [initial, growing];
  const collector = createCollector({
    clock,
    memoryGrowthBytes: 512,
    memoryGrowthWindowMs: 5000,
    hostSource: { readHost: async () => host(0) },
    herdrSource: { listSessions: async () => [sessions.shift()!] },
  } as never);

  await collector.collect();
  clock.advance(5000);
  const result = await collector.collect();

  expect(result.events).toContainEqual(expect.objectContaining({
    kind: "memory-growth",
    session: "agent-alpha",
    details: expect.objectContaining({ previousRssBytes: 1024, currentRssBytes: 1536 }),
  }));
});
test("resets memory growth baseline when OMP PID changes", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const initial = session(42);
  const restarted = {
    ...session(43),
    processes: [{ ...session(43).processes[0]!, rssBytes: 1536 }],
  };
  const sessions = [initial, restarted];
  const collector = createCollector({
    clock,
    memoryGrowthBytes: 512,
    memoryGrowthWindowMs: 5000,
    hostSource: { readHost: async () => host(0) },
    herdrSource: { listSessions: async () => [sessions.shift()!] },
  } as never);

  await collector.collect();
  clock.advance(5000);
  const result = await collector.collect();

  expect(result.events.some((event) => event.kind === "memory-growth")).toBe(false);
});

test("sampler persists snapshots and records source failures", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const storage = new FakeStorage();
  let attempts = 0;
  const sampler = createSampler({
    clock,
    intervalMs: 5000,
    retentionMs: 24 * 60 * 60 * 1000,
    storage,
    collector: {
      collect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Herdr unavailable");
        return { snapshot: { observedAt: clock.now().toISOString(), host: host(0), sessions: [], ompCount: 0, herdrSessionCount: 0, collectorErrors: [] }, events: [] };
      },
    },
  });

  await sampler.sampleOnce();
  expect(storage.eventsWritten[0]?.kind).toBe("source-error");
  await sampler.sampleOnce();
  expect(storage.snapshots).toHaveLength(1);
  await sampler.stop();
});
test("sampler records automatic cleanup audit events", async () => {
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const storage = new FakeStorage();
  const cleanupEvent: EventRecord = {
    observedAt: clock.now().toISOString(),
    severity: "info",
    kind: "cleanup-auto",
    session: null,
    message: "Automatic cache cleanup completed",
    details: { status: "ok" },
  };
  const sampler = createSampler({
    clock,
    intervalMs: 5000,
    retentionMs: 24 * 60 * 60 * 1000,
    storage,
    collector: {
      collect: async () => ({ snapshot: { observedAt: clock.now().toISOString(), host: host(0), sessions: [], ompCount: 0, herdrSessionCount: 0, collectorErrors: [] }, events: [] }),
    },
    automaticCleanup: { observe: async () => [cleanupEvent] },
  } as never);

  await sampler.sampleOnce();

  expect(storage.eventsWritten).toContainEqual(cleanupEvent);
  await sampler.stop();
});
test("persists automatic cleanup audit events in SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-auto-cleanup-"));
  const storage = createStorage(join(directory, "monitor.sqlite3"));
  const clock = new FixedClock(new Date("2026-08-20T12:00:00.000Z"));
  const cleanupResult: CleanupResult = {
    version: 1,
    status: "ok",
    actions: { dropCaches: "done", swapCycle: "skipped" },
    before: { totalBytes: 100, availableBytes: 20, swapTotalBytes: 40, swapUsedBytes: 20, tmpUsedBytes: 50, tmpTotalBytes: 100 },
    after: { totalBytes: 100, availableBytes: 30, swapTotalBytes: 40, swapUsedBytes: 20, tmpUsedBytes: 50, tmpTotalBytes: 100 },
    reclaimed: { availableBytes: 10, swapBytes: 0, tmpBytes: 0 },
    durationMs: 10,
    completedAt: clock.now().toISOString(),
  };
  const maintenance: MaintenanceStatus = {
    helperPath: "/helper",
    wrapperPresent: true,
    wrapperExecutable: true,
    wrapperRootOwned: true,
    binaryPresent: true,
    binaryExecutable: true,
    binaryRootOwned: true,
    sudoersPresent: true,
    authorization: "ready",
    ready: true,
    autoCleanupMode: "cache",
    remediation: null,
    lastCleanup: null,
  };
  const automaticCleanup = createAutomaticCleanupController({
    mode: "cache",
    criticalConfirmSamples: 1,
    cooldownMs: 600000,
    probe: { read: async () => maintenance },
    cleaner: { run: async () => cleanupResult },
    now: () => clock.now().getTime(),
  });
  const sample: HealthSnapshot = {
    observedAt: clock.now().toISOString(),
    host: host(0, "critical"),
    sessions: [],
    ompCount: 0,
    herdrSessionCount: 0,
    collectorErrors: [],
  };
  const sampler = createSampler({
    clock,
    intervalMs: 5000,
    retentionMs: 24 * 60 * 60 * 1000,
    storage,
    collector: { collect: async () => ({ snapshot: sample, events: [] }) },
    automaticCleanup,
  });

  try {
    await sampler.sampleOnce();
    expect(storage.events(new Date("2026-08-20T11:00:00.000Z"), new Date("2026-08-20T13:00:00.000Z")).map((event) => event.kind)).toContain("cleanup-auto");
    await sampler.stop();
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
