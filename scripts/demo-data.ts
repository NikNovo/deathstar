import type { MaintenanceStatus } from "../src/maintenance.ts";
import type {
  EventRecord,
  HealthSnapshot,
  UsageReport,
  UsageResponse,
} from "../src/types.ts";

export type DemoState = "healthy" | "pressure" | "unavailable";

export const DEMO_OBSERVED_AT = "2026-01-15T12:00:00.000Z";
const GIB = 1024 ** 3;

function demoHost(state: DemoState): HealthSnapshot["host"] {
  const pressure = state === "pressure";
  return {
    observedAt: DEMO_OBSERVED_AT,
    totalBytes: 16 * GIB,
    usedBytes: pressure ? 14 * GIB : 9 * GIB,
    availableBytes: pressure ? 1.5 * GIB : 7 * GIB,
    freeBytes: pressure ? 512 * 1024 ** 2 : 3 * GIB,
    cacheBytes: pressure ? 2 * GIB : 5 * GIB,
    swapTotalBytes: 4 * GIB,
    swapUsedBytes: pressure ? 3 * GIB : 512 * 1024 ** 2,
    load1: pressure ? 3.4 : 0.42,
    load5: pressure ? 2.8 : 0.36,
    load15: pressure ? 2.1 : 0.31,
    rootUsedBytes: 80 * GIB,
    rootTotalBytes: 160 * GIB,
    tmpUsedBytes: pressure ? 7 * GIB : 2 * GIB,
    tmpTotalBytes: 16 * GIB,
    cgroupCurrentBytes: pressure ? 8 * GIB : 2 * GIB,
    cgroupLimitBytes: null,
    oomKillCount: pressure ? 3 : 0,
    memoryPressure: {
      some: pressure
        ? { avg10: 0.31, avg60: 0.22, avg300: 0.14, total: 182000 }
        : { avg10: 0.01, avg60: 0.01, avg300: 0.01, total: 1200 },
      full: pressure
        ? { avg10: 0.04, avg60: 0.02, avg300: 0.01, total: 21000 }
        : { avg10: 0, avg60: 0, avg300: 0, total: 0 },
    },
    state: pressure ? "critical" : "ok",
    errors: [],
  };
}

function demoSession(name: string, rssBytes: number): HealthSnapshot["sessions"][number] {
  return {
    name,
    status: "running",
    directory: null,
    paneId: null,
    agentStatus: "working",
    ompPid: name === "agent-alpha" ? 42 : 43,
    cgroupShared: false,
    ompState: "working",
    processes: [{
      pid: name === "agent-alpha" ? 42 : 43,
      ppid: 1,
      command: "omp",
      cwd: null,
      rssBytes,
      virtualBytes: rssBytes * 2,
      state: "S",
      startedAt: DEMO_OBSERVED_AT,
    }],
    cgroupPath: null,
    cgroupCurrentBytes: rssBytes,
    cgroupPeakBytes: rssBytes * 2,
    cgroupOomKillCount: 0,
    observedAt: DEMO_OBSERVED_AT,
    error: null,
  };
}

export function createDemoSnapshot(state: DemoState): HealthSnapshot {
  const sessions = state === "unavailable"
    ? []
    : [demoSession("agent-alpha", state === "pressure" ? 5 * GIB : 800 * 1024 ** 2), demoSession("agent-beta", 600 * 1024 ** 2)];
  return {
    observedAt: DEMO_OBSERVED_AT,
    host: demoHost(state),
    sessions,
    ompCount: sessions.length,
    herdrSessionCount: sessions.length,
    collectorErrors: state === "unavailable" ? ["Herdr integration unavailable"] : [],
  };
}

export function createDemoEvents(state: DemoState): EventRecord[] {
  if (state === "healthy") return [];
  if (state === "unavailable") {
    return [{
      observedAt: DEMO_OBSERVED_AT,
      severity: "warning",
      kind: "source-error",
      session: null,
      message: "Herdr integration unavailable",
      details: { source: "herdr" },
    }];
  }
  return [
    {
      observedAt: DEMO_OBSERVED_AT,
      severity: "critical",
      kind: "oom-increased",
      session: "agent-alpha",
      message: "OOM counter increased",
      details: { previousCount: 1, currentCount: 3, shared: false },
    },
    {
      observedAt: DEMO_OBSERVED_AT,
      severity: "warning",
      kind: "memory-growth",
      session: "agent-alpha",
      message: "OMP memory growth detected",
      details: { previousRssBytes: 2 * GIB, currentRssBytes: 5 * GIB, elapsedMs: 300000 },
    },
  ];
}

function demoReport(provider: string, resetsAt: string, remaining: number, status: "ok" | "warning"): UsageReport {
  return {
    provider,
    accountLabel: "demo-account",
    plan: "demo-plan",
    fetchedAt: DEMO_OBSERVED_AT,
    limits: [{
      id: "window-1",
      label: "five-hour window",
      amount: { used: 100 - remaining, limit: 100, remaining, unit: "percent" },
      window: { id: "window-1", label: "five-hour window", resetsAt },
      status,
    }],
    resetCredits: null,
  };
}

export function createDemoUsage(state: DemoState): UsageResponse {
  const nextReset = "2026-01-15T17:00:00.000Z";
  if (state === "unavailable") {
    return {
      status: "unknown",
      snapshot: null,
      lastAttemptAt: DEMO_OBSERVED_AT,
      lastSuccessfulAt: null,
      nextRefreshAt: null,
      error: "usage monitor unavailable",
      cliProviders: [],
      models: { status: "unknown", fetchedAt: null, models: [], error: null },
    };
  }
  return {
    status: state === "pressure" ? "stale" : "ok",
    snapshot: {
      generatedAt: DEMO_OBSERVED_AT,
      reports: [
        demoReport("provider-a", nextReset, state === "pressure" ? 8 : 64, state === "pressure" ? "warning" : "ok"),
        demoReport("provider-b", nextReset, 82, "ok"),
      ],
      accountsWithoutUsage: [],
      disabledCredentials: [],
    },
    lastAttemptAt: DEMO_OBSERVED_AT,
    lastSuccessfulAt: DEMO_OBSERVED_AT,
    nextRefreshAt: "2026-01-15T13:00:00.000Z",
    error: null,
    cliProviders: [],
    models: { status: "ok", fetchedAt: DEMO_OBSERVED_AT, models: [], error: null },
  };
}

export function createDemoMaintenance(state: DemoState): MaintenanceStatus {
  const ready = state !== "unavailable";
  return {
    helperPath: "/usr/local/libexec/deathstar-memory-clean",
    wrapperPresent: ready,
    wrapperExecutable: ready,
    binaryPresent: ready,
    binaryExecutable: ready,
    binaryRootOwned: ready ? true : null,
    wrapperRootOwned: ready ? true : null,
    sudoersPresent: ready ? true : false,
    authorization: ready ? "ready" : "helper-missing",
    ready,
    autoCleanupMode: "off",
    remediation: ready ? null : "Install the optional cleanup helper from an interactive terminal.",
    lastCleanup: null,
  };
}
