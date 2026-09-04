import { describe, expect, test } from "bun:test";
import type { Storage } from "../src/storage.ts";
import { createHttpServer, createRequestHandler } from "../src/http.ts";
import { MemoryCleanupError } from "../src/memory-cleanup.ts";
import type { CleanupResult } from "../src/memory-helper.ts";
import type { EventRecord, HealthSnapshot, HistoryResponse, UsageResponse } from "../src/types.ts";
import type { MaintenanceStatus } from "../src/maintenance.ts";

function snapshot(observedAt: string): HealthSnapshot {
  return {
    observedAt,
    host: {
      observedAt,
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      availableBytes: 8 * 1024 ** 3,
      freeBytes: 8 * 1024 ** 3,
      cacheBytes: 0,
      swapTotalBytes: 4 * 1024 ** 3,
      swapUsedBytes: 0,
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      rootUsedBytes: 10,
      rootTotalBytes: 100,
      tmpUsedBytes: 20,
      tmpTotalBytes: 100,
      cgroupCurrentBytes: 8 * 1024 ** 3,
      cgroupLimitBytes: null,
      oomKillCount: 0,
      memoryPressure: {
        some: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
        full: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      },
      state: "ok",
      errors: [],
    },
    sessions: [],
    ompCount: 0,
    herdrSessionCount: 0,
    collectorErrors: [],
  };
}

class FakeStorage implements Storage {
  constructor(private readonly value: HealthSnapshot | null) {}
  insertSnapshot(): void {}
  insertEvents(): void {}
  current(): HealthSnapshot | null { return this.value; }
  history(from: Date, to: Date): HistoryResponse { return { from: from.toISOString(), to: to.toISOString(), points: [] }; }
  events(): EventRecord[] { return []; }
  prune(): void {}
  close(): void {}
}
const now = new Date("2026-08-20T12:00:05.000Z");
const usageResponse: UsageResponse = {
  status: "stale",
  snapshot: {
    generatedAt: "2027-01-15T08:00:00.000Z",
    reports: [{
      provider: "anthropic",
      accountLabel: "Account 1",
      plan: null,
      fetchedAt: "2027-01-15T08:00:01.000Z",
      limits: [{
        id: "anthropic:5h",
        label: "Claude 5 Hour",
        amount: { used: 13, limit: 100, remaining: 87, unit: "percent" },
        window: { id: "5h", label: "5 Hour", resetsAt: "2027-01-15T13:00:00.000Z" },
        status: "ok",
      }],
      resetCredits: null,
    }],
    accountsWithoutUsage: [{ provider: "kimi-code", type: "oauth" }],
    disabledCredentials: [],
  },
  lastAttemptAt: "2027-01-15T08:01:00.000Z",
  lastSuccessfulAt: "2027-01-15T08:00:01.000Z",
  nextRefreshAt: "2027-01-15T09:01:00.000Z",
  error: "provider unavailable",
  cliProviders: [{ provider: "perplexity", status: "no-usage-data", accounts: 1, reports: 0, error: null }],
  models: { status: "ok", fetchedAt: "2027-01-15T08:00:02.000Z", models: [], error: null },
};
const usageHandler = createRequestHandler({
  storage: new FakeStorage(snapshot("2026-08-20T12:00:00.000Z")),
  usage: { current: () => usageResponse },
  assets: {},
});

const handler = createRequestHandler({
  storage: new FakeStorage(snapshot("2026-08-20T12:00:00.000Z")),
  now: () => now,
  assets: {
    "/": "<!doctype html><title>deathstar</title>",
    "/index.html": "<!doctype html><title>deathstar</title>",
    "/app.js": "console.log('deathstar')",
    "/styles.css": "body {}",
  },
});

const dashboardOrigin = "http://127.0.0.1:3848";
const cleanupResult: CleanupResult = {
  version: 1,
  status: "ok",
  actions: { dropCaches: "done", swapCycle: "done" },
  before: { totalBytes: 100, availableBytes: 80, swapTotalBytes: 40, swapUsedBytes: 20, tmpUsedBytes: 50, tmpTotalBytes: 100 },
  after: { totalBytes: 100, availableBytes: 90, swapTotalBytes: 40, swapUsedBytes: 0, tmpUsedBytes: 50, tmpTotalBytes: 100 },
  reclaimed: { availableBytes: 10, swapBytes: 20, tmpBytes: 0 },
  durationMs: 10,
  completedAt: now.toISOString(),
};
const maintenanceStatus: MaintenanceStatus = {
  helperPath: "/usr/local/libexec/deathstar-memory-clean",
  wrapperPresent: false,
  wrapperExecutable: false,
  wrapperRootOwned: null,
  binaryPresent: false,
  binaryExecutable: false,
  binaryRootOwned: null,
  sudoersPresent: false,
  authorization: "helper-missing",
  ready: false,
  autoCleanupMode: "off",
  remediation: "Run ops/install-memory-cleanup from an interactive terminal.",
  lastCleanup: null,
};
let cleanupCalls = 0;
const cleanupHandler = createRequestHandler({
  storage: new FakeStorage(snapshot("2026-08-20T12:00:00.000Z")),
  now: () => now,
  dashboardOrigin,
  memoryCleanup: {
    run: async () => { cleanupCalls += 1; return cleanupResult; },
    status: async () => maintenanceStatus,
  },
  assets: {
    "/": "<!doctype html><title>deathstar</title>",
    "/index.html": "<!doctype html><title>deathstar</title>",
    "/app.js": "console.log('deathstar')",
    "/styles.css": "body {}",
  },
});

describe("http API", () => {
  test("reports health and current snapshot", async () => {
    const health = await handler(new Request("http://127.0.0.1:3848/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", database: "ok", collector: "ok" });

    const current = await handler(new Request("http://127.0.0.1:3848/api/current"));
    expect(current.status).toBe(200);
    expect((await current.json()).snapshot.observedAt).toBe("2026-08-20T12:00:00.000Z");
  });
  test("serves the cached usage response", async () => {
    const response = await usageHandler(new Request("http://127.0.0.1:3848/api/usage"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(usageResponse);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await usageHandler(new Request("http://127.0.0.1:3848/api/usage", { method: "POST" }))).status).toBe(405);
  });

  test("returns unknown usage when no monitor is injected", async () => {
    const response = await handler(new Request("http://127.0.0.1:3848/api/usage"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "unknown",
      snapshot: null,
      lastAttemptAt: null,
      lastSuccessfulAt: null,
      nextRefreshAt: null,
      error: "usage monitor unavailable",
      cliProviders: [],
      models: { status: "unknown", fetchedAt: null, models: [], error: null },
    });
  });


  test("serves history, events, and static assets", async () => {
    const history = await handler(new Request("http://127.0.0.1:3848/api/history?range=24h"));
    expect(history.status).toBe(200);
    expect((await history.json()).points).toEqual([]);

    const events = await handler(new Request("http://127.0.0.1:3848/api/events?range=24h"));
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual([]);

    const page = await handler(new Request("http://127.0.0.1:3848/"));
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("deathstar");
    const logic = await handler(new Request("http://127.0.0.1:3848/logic.js"));
    expect(logic.status).toBe(200);
    expect(logic.headers.get("content-type")).toContain("text/javascript");
    expect(await logic.text()).toContain("export function chartValue");
  });

  test("rejects mutations and unknown paths", async () => {
    expect((await handler(new Request("http://127.0.0.1:3848/api/current", { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request("http://127.0.0.1:3848/nope"))).status).toBe(404);
  });
  test("requires exact dashboard Origin for cleanup", async () => {
    const path = "http://127.0.0.1:3848/api/memory/cleanup";
    expect((await cleanupHandler(new Request(path, { method: "GET" }))).status).toBe(405);
    expect((await cleanupHandler(new Request(path, { method: "POST" }))).status).toBe(403);
    expect((await cleanupHandler(new Request(path, { method: "POST", headers: { Origin: "https://evil.example" } }))).status).toBe(403);

    const response = await cleanupHandler(new Request(path, { method: "POST", headers: { Origin: dashboardOrigin } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cleanupResult);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(cleanupCalls).toBe(1);
  });

  test("reports maintenance status", async () => {
    const response = await cleanupHandler(new Request("http://127.0.0.1:3848/api/maintenance"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ready: false,
      authorization: "helper-missing",
      remediation: "Run ops/install-memory-cleanup from an interactive terminal.",
    });
  });
  test("rejects cleanup bodies and maps controller errors", async () => {
    const path = "http://127.0.0.1:3848/api/memory/cleanup";
    const bodyResponse = await cleanupHandler(new Request(path, { method: "POST", headers: { Origin: dashboardOrigin }, body: "nope" }));
    expect(bodyResponse.status).toBe(400);

    const errorHandler = createRequestHandler({
      storage: new FakeStorage(snapshot("2026-08-20T12:00:00.000Z")),
      dashboardOrigin,
      memoryCleanup: {
        run: async () => { throw new MemoryCleanupError(409, "cooldown"); },
        status: async () => maintenanceStatus,
      },
      assets: {},
    });
    const errorResponse = await errorHandler(new Request(path, { method: "POST", headers: { Origin: dashboardOrigin } }));
    expect(errorResponse.status).toBe(409);
    expect(await errorResponse.json()).toMatchObject({ status: "error", code: "cleanup_busy" });
  });

  test("supports an ephemeral loopback port for tests", async () => {
    const server = createHttpServer({
      storage: new FakeStorage(snapshot("2026-08-20T12:00:00.000Z")),
      host: "127.0.0.1",
      port: 0,
      assets: { "/": "deathstar" },
    });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.port).not.toBe(3848);
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(response.status).toBe(200);
    } finally {
      server.stop();
    }
  });
});
