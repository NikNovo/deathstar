import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicEvent, publicSnapshot } from "../src/privacy.ts";
import { createStorage } from "../src/storage.ts";
import type { EventRecord, HealthSnapshot } from "../src/types.ts";

const observedAt = "2026-01-15T12:00:00.000Z";

function sensitiveSnapshot(): HealthSnapshot {
  return {
    observedAt,
    host: {
      observedAt,
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      availableBytes: 8 * 1024 ** 3,
      freeBytes: 4 * 1024 ** 3,
      cacheBytes: 4 * 1024 ** 3,
      swapTotalBytes: 4 * 1024 ** 3,
      swapUsedBytes: 512 * 1024 ** 2,
      load1: 0.2,
      load5: 0.2,
      load15: 0.2,
      rootUsedBytes: 1,
      rootTotalBytes: 2,
      tmpUsedBytes: 1,
      tmpTotalBytes: 2,
      cgroupCurrentBytes: 2 * 1024 ** 3,
      cgroupLimitBytes: null,
      oomKillCount: 0,
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
      directory: "/synthetic/private/project",
      paneId: "workspace-private:tab-private:pane-private",
      agentStatus: "working",
      ompPid: 42,
      cgroupShared: false,
      ompState: "working",
      processes: [{
        pid: 42,
        ppid: 1,
        command: "bun /synthetic/private/omp --resume /synthetic/private/transcript.jsonl",
        cwd: "/synthetic/private/project",
        rssBytes: 1024,
        virtualBytes: 2048,
        state: "S",
        startedAt: observedAt,
      }],
      cgroupPath: "/user.slice/private.scope",
      cgroupCurrentBytes: 1024,
      cgroupPeakBytes: 2048,
      cgroupOomKillCount: 0,
      observedAt,
      error: "failed at /synthetic/private/transcript.jsonl",
    }],
    ompCount: 1,
    herdrSessionCount: 1,
    collectorErrors: [],
  };
}

function sensitiveEvent(): EventRecord {
  return {
    observedAt,
    severity: "critical",
    kind: "oom-increased",
    session: "agent-alpha",
    message: "raw /synthetic/private message",
    details: {
      cgroupPath: "/user.slice/private.scope",
      currentCount: 4,
      error: "/synthetic/private/error",
    },
  };
}

test("redacts paths, pane identity, command arguments and raw event details before persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-privacy-"));
  const storage = createStorage(join(directory, "monitor.sqlite3"));
  try {
    storage.insertSnapshot(sensitiveSnapshot());
    storage.insertEvents([sensitiveEvent()]);

    const current = storage.current();
    const events = storage.events(new Date("2026-01-15T11:00:00.000Z"), new Date("2026-01-15T13:00:00.000Z"));
    const serialized = JSON.stringify({ current, events });

    expect(serialized).not.toContain("/synthetic/private");
    expect(serialized).not.toContain("workspace-private");
    expect(serialized).not.toContain("--resume");
    expect(current?.sessions[0]?.directory).toBeNull();
    expect(current?.sessions[0]?.paneId).toBeNull();
    expect(current?.sessions[0]?.cgroupPath).toBeNull();
    expect(current?.sessions[0]?.processes[0]?.cwd).toBeNull();
    expect(current?.sessions[0]?.processes[0]?.command).toBe("omp");
    expect(events[0]?.details).not.toHaveProperty("cgroupPath");
    expect(events[0]?.details).not.toHaveProperty("error");
    expect(events[0]?.message).toBe("OOM counter increased");
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("public projections preserve metrics and replace optional integration errors", () => {
  const snapshot = publicSnapshot(sensitiveSnapshot());
  const event = publicEvent({
    ...sensitiveEvent(),
    kind: "source-error",
    details: { error: "raw error", source: "herdr" },
  });

  expect(snapshot.ompCount).toBe(1);
  expect(snapshot.host.availableBytes).toBe(8 * 1024 ** 3);
  expect(snapshot.sessions[0]?.error).toBe("Session integration unavailable");
  expect(snapshot.sessions[0]?.processes[0]?.command).toBe("omp");
  expect(event.message).toBe("Optional integration unavailable");
  expect(event.details).toEqual({ source: "herdr" });
});
