import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventRecord, HealthSnapshot } from "../src/types.ts";
import { createStorage, type Storage } from "../src/storage.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeStorage(): Storage {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-storage-"));
  temporaryDirectories.push(directory);
  return createStorage(join(directory, "monitor.sqlite3"));
}

function snapshot(observedAt: string, availableBytes = 8 * 1024 ** 3): HealthSnapshot {
  return {
    observedAt,
    host: {
      observedAt,
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      availableBytes,
      freeBytes: availableBytes,
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
      oomKillCount: 2,
      memoryPressure: {
        some: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
        full: { avg10: 0, avg60: 0, avg300: 0, total: 0 },
      },
      state: "ok",
      errors: [],
    },
    sessions: [{
      name: "agent-alpha",
      status: "running",
      directory: null,
      paneId: null,
      agentStatus: "idle",
      ompPid: 42,
      cgroupShared: false,
      ompState: "idle",
      processes: [],
      cgroupPath: null,
      cgroupCurrentBytes: 1024,
      cgroupPeakBytes: 2048,
      cgroupOomKillCount: 0,
      observedAt,
      error: null,
    }],
    ompCount: 1,
    herdrSessionCount: 1,
    collectorErrors: [],
  };
}

function event(observedAt: string, message: string): EventRecord {
  return {
    observedAt,
    severity: "critical",
    kind: "oom-increased",
    session: "agent-alpha",
    message,
    details: { before: 1, after: 2 },
  };
}

describe("storage", () => {
  test("creates a database and returns the latest snapshot", () => {
    const storage = makeStorage();
    const expected = snapshot("2026-08-20T12:00:00.000Z");

    storage.insertSnapshot(expected);

    expect(storage.current()).toEqual(expected);
    storage.close();
  });

  test("returns history points and newest events", () => {
    const storage = makeStorage();
    storage.insertSnapshot(snapshot("2026-08-20T12:00:00.000Z"));
    storage.insertSnapshot(snapshot("2026-08-20T12:05:00.000Z", 4 * 1024 ** 3));
    storage.insertEvents([
      event("2026-08-20T12:00:01.000Z", "older"),
      event("2026-08-20T12:05:01.000Z", "newer"),
    ]);

    const history = storage.history(new Date("2026-08-20T11:00:00.000Z"), new Date("2026-08-20T13:00:00.000Z"));
    expect(history.points).toHaveLength(2);
    expect(history.points[1]?.availableBytes).toBe(4 * 1024 ** 3);
    expect(storage.events(new Date("2026-08-20T11:00:00.000Z"), new Date("2026-08-20T13:00:00.000Z")).map((item) => item.message)).toEqual(["OOM counter increased", "OOM counter increased"]);
    storage.close();
  });
  test("history reads only numeric sample columns", () => {
    const storage = makeStorage();
    storage.insertSnapshot(snapshot("2026-08-20T12:00:00.000Z"));
    const queries: string[] = [];
    const originalQuery = Database.prototype.query;
    Database.prototype.query = function (this: Database, sql: string) {
      queries.push(sql);
      return Reflect.apply(originalQuery, this, [sql]);
    } as typeof originalQuery;

    try {
      storage.history(new Date("2026-08-20T11:00:00.000Z"), new Date("2026-08-20T13:00:00.000Z"));
    } finally {
      Database.prototype.query = originalQuery;
      storage.close();
    }

    expect(queries).toContain(
      "SELECT observed_at, available_bytes, swap_used_bytes, cgroup_current_bytes, oom_kill_count, omp_count, tmp_used_bytes FROM samples WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at ASC",
    );
  });

  test("downsamples older buckets and keeps recent raw points", () => {
    const storage = makeStorage();
    storage.insertSnapshot(snapshot("2026-08-20T10:00:00.000Z", 8 * 1024 ** 3));
    storage.insertSnapshot(snapshot("2026-08-20T10:01:00.000Z", 6 * 1024 ** 3));
    storage.insertSnapshot(snapshot("2026-08-20T10:04:00.000Z", 7 * 1024 ** 3));
    storage.insertSnapshot(snapshot("2026-08-20T12:10:00.000Z", 5 * 1024 ** 3));
    storage.insertSnapshot(snapshot("2026-08-20T12:11:00.000Z", 4 * 1024 ** 3));

    const history = storage.history(new Date("2026-08-20T10:00:00.000Z"), new Date("2026-08-20T13:00:00.000Z"));

    expect(history.points).toHaveLength(3);
    expect(history.points[0]).toMatchObject({
      observedAt: "2026-08-20T10:00:00.000Z",
      availableBytes: 7 * 1024 ** 3,
      availableMinBytes: 6 * 1024 ** 3,
      availableMaxBytes: 8 * 1024 ** 3,
      sampleCount: 3,
    });
    expect(history.points[1]).toMatchObject({
      observedAt: "2026-08-20T12:10:00.000Z",
      availableBytes: 5 * 1024 ** 3,
      sampleCount: 1,
    });
    expect(history.points[2]).toMatchObject({
      observedAt: "2026-08-20T12:11:00.000Z",
      availableBytes: 4 * 1024 ** 3,
      sampleCount: 1,
    });
    storage.close();
  });

  test("prunes samples and events older than the cutoff", () => {
    const storage = makeStorage();
    storage.insertSnapshot(snapshot("2026-08-20T11:00:00.000Z"));
    storage.insertSnapshot(snapshot("2026-08-20T12:00:00.000Z"));
    storage.insertEvents([
      event("2026-08-20T11:00:01.000Z", "old"),
      event("2026-08-20T12:00:01.000Z", "new"),
    ]);

    storage.prune(new Date("2026-08-20T12:00:00.000Z"));

    const history = storage.history(new Date("2026-08-20T00:00:00.000Z"), new Date("2026-08-21T00:00:00.000Z"));
    expect(history.points).toHaveLength(1);
    expect(storage.events(new Date("2026-08-20T00:00:00.000Z"), new Date("2026-08-21T00:00:00.000Z")).map((item) => item.message)).toEqual(["OOM counter increased"]);
    storage.close();
  });
});
