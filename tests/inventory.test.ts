import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInventoryCollector, type InventoryCollector, type InventoryCollectorOptions } from "../src/inventory.ts";
import { createStorage } from "../src/storage.ts";
import type { InventorySnapshot, MemoryBreakdown, ProcessSnapshot, SessionSnapshot } from "../src/types.ts";

interface InventoryInput {
  rows: Array<{ pid: number; rssBytes: number; cgroup: string | null }>;
  trees: Record<string, number[]>;
  cgroupSessions: Record<string, string[]>;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function processSnapshot(pid: number, rssBytes: number): ProcessSnapshot {
  return {
    pid,
    ppid: 1,
    command: `process-${pid}`,
    cwd: null,
    rssBytes,
    virtualBytes: rssBytes,
    state: "running",
    startedAt: null,
  };
}

function sessionsFor(input: InventoryInput): SessionSnapshot[] {
  const cgroupBySession = new Map<string, string>();
  for (const [path, names] of Object.entries(input.cgroupSessions)) {
    for (const name of names) cgroupBySession.set(name, path);
  }
  const names = new Set<string>([
    ...Object.keys(input.trees),
    ...Object.values(input.cgroupSessions).flat(),
  ]);
  return [...names].map((name) => ({
    name,
    status: "running",
    directory: null,
    paneId: null,
    agentStatus: null,
    ompPid: input.trees[name]?.[0] ?? null,
    cgroupShared: false,
    ompState: "working",
    processes: (input.trees[name] ?? []).map((pid) => processSnapshot(pid, 0)),
    paneProcesses: [],
    treeRssBytes: null,
    paneRssBytes: null,
    cgroupPath: cgroupBySession.get(name) ?? null,
    cgroupCurrentBytes: null,
    cgroupPeakBytes: null,
    cgroupOomKillCount: null,
    observedAt: "2026-09-06T00:00:00.000Z",
    error: null,
  }));
}

function collectorFor(input: InventoryInput, initialSnapshot?: InventorySnapshot | null): InventoryCollector {
  const rows = new Map(input.rows.map((row) => [row.pid, row]));
  const options: InventoryCollectorOptions = {
    procSource: {
      listAllPids: async () => input.rows.map((row) => row.pid),
      readMemoryBreakdown: async () => ({
        anonPagesBytes: 1,
        shmemBytes: 2,
        fileCacheBytes: 3,
        slabBytes: 4,
      }),
      readProcess: async (pid) => {
        const row = rows.get(pid);
        return row ? processSnapshot(row.pid, row.rssBytes) : null;
      },
      readProcessCgroup: async (pid) => {
        const row = rows.get(pid);
        return row?.cgroup
          ? { path: row.cgroup, currentBytes: 0, peakBytes: null, oomKillCount: 0 }
          : null;
      },
    },
    herdrSource: { listSessions: async () => sessionsFor(input) },
    initialSnapshot,
    now: () => new Date("2026-09-06T00:00:00.000Z"),
  };
  return createInventoryCollector(options);
}

async function collectInventory(input: InventoryInput): Promise<InventorySnapshot> {
  const collector = collectorFor(input);
  await collector.refreshOnce();
  const snapshot = collector.current();
  if (!snapshot) throw new Error("inventory collection did not produce a snapshot");
  return snapshot;
}

describe("inventory collector", () => {
  test("associates inventory PIDs with precedence", async () => {
    const snapshot = await collectInventory({
      rows: [
        { pid: 100, rssBytes: 500, cgroup: "/scope-a" },
        { pid: 200, rssBytes: 700, cgroup: "/scope-a" },
        { pid: 300, rssBytes: 100, cgroup: "/other" },
      ],
      trees: { alpha: [100] },
      cgroupSessions: { "/scope-a": ["alpha", "beta"] },
    });
    expect(snapshot.processes.map((p) => `${p.pid}:${p.association}`)).toEqual([
      "200:shared-cgroup:alpha,beta",
      "100:session:alpha",
      "300:unassociated",
    ]);
  });

  test("marks conflicting tree and cgroup evidence as ambiguous", async () => {
    const snapshot = await collectInventory({
      rows: [{ pid: 100, rssBytes: 500, cgroup: "/scope-b" }],
      trees: { alpha: [100] },
      cgroupSessions: { "/scope-b": ["beta"] },
    });
    expect(snapshot.processes[0]?.association).toBe("ambiguous");
  });
  test("deduplicates PIDs and keeps only the top ten by RSS", async () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, index) => ({
        pid: index + 1,
        rssBytes: (index + 1) * 100,
        cgroup: null,
      })),
      { pid: 11, rssBytes: 1_100, cgroup: null },
    ];
    const snapshot = await collectInventory({ rows, trees: {}, cgroupSessions: {} });
    expect(snapshot.processes).toHaveLength(10);
    expect(snapshot.processes.map((process) => process.pid)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
    );
  });

  test("groups rows by association with remaining RSS outside top ten", async () => {
    const rows = [
      { pid: 100, rssBytes: 500, cgroup: "/scope-a" },
      { pid: 200, rssBytes: 700, cgroup: "/scope-a" },
      ...Array.from({ length: 10 }, (_, index) => ({
        pid: 300 + index,
        rssBytes: 10 + index,
        cgroup: null,
      })),
    ];
    const snapshot = await collectInventory({
      rows,
      trees: { alpha: [100] },
      cgroupSessions: { "/scope-a": ["alpha", "beta"] },
    });
    expect(snapshot.processCount).toBe(12);
    expect(snapshot.totalRssBytes).toBe(500 + 700 + 145);
    expect(snapshot.remainingProcessCount).toBe(2);
    expect(snapshot.remainingRssBytes).toBe(10 + 11);
    const keys = Object.fromEntries(snapshot.groups.map((group) => [group.key, group]));
    expect(keys["session:alpha"]?.processCount).toBe(1);
    expect(keys["shared-cgroup:alpha,beta"]?.processCount).toBe(1);
    expect(keys["unassociated"]?.processCount).toBe(10);
  });

  test("redacts session paths and keeps full rows outside top ten", async () => {
    const procSource = {
      listAllPids: async () => [1, 2],
      readMemoryBreakdown: async () => ({ anonPagesBytes: 1, shmemBytes: 2, fileCacheBytes: 3, slabBytes: 4 }),
      readProcess: async (pid: number) => ({
        pid,
        ppid: 0,
        command: pid === 1
          ? "omp --resume /synthetic/agent/sessions/-tmp/abc.jsonl"
          : "chrome",
        cwd: null,
        rssBytes: pid === 1 ? 100 : 50,
        virtualBytes: 100,
        state: "running",
        startedAt: null,
      }),
      readProcessCgroup: async () => null,
    };
    const collector = createInventoryCollector({
      procSource,
      herdrSource: { listSessions: async () => [] },
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    await collector.refreshOnce();
    const snapshot = collector.current();
    expect(snapshot?.allProcesses).toHaveLength(2);
    expect(snapshot?.allProcesses[0]?.command).toBe("omp --resume <session>");
    expect(snapshot?.allProcesses[0]?.command).not.toContain(".jsonl");
  });

  test("redacts session paths under any home directory", async () => {
    const procSource = {
      listAllPids: async () => [1],
      readMemoryBreakdown: async () => ({ anonPagesBytes: 1, shmemBytes: 2, fileCacheBytes: 3, slabBytes: 4 }),
      readProcess: async (pid: number) => ({
        pid,
        ppid: 0,
        command: "code /synthetic/home/.omp/agent/sessions/-tmp/abc.jsonl",
        cwd: null,
        rssBytes: 100,
        virtualBytes: 100,
        state: "running",
        startedAt: null,
      }),
      readProcessCgroup: async () => null,
    };
    const collector = createInventoryCollector({
      procSource,
      herdrSource: { listSessions: async () => [] },
      now: () => new Date("2026-09-06T00:00:00.000Z"),
    });
    await collector.refreshOnce();
    const snapshot = collector.current();
    expect(snapshot?.allProcesses[0]?.command).toBe("code <session>");
    expect(snapshot?.allProcesses[0]?.command).not.toContain("/synthetic/home");
  });

  test("shares one in-flight refresh between callers", async () => {
    let listCalls = 0;
    let resolveBreakdown: ((value: MemoryBreakdown) => void) | null = null;
    const breakdown = new Promise<MemoryBreakdown>((resolve) => { resolveBreakdown = resolve; });
    const collector = createInventoryCollector({
      procSource: {
        listAllPids: async () => {
          listCalls += 1;
          return [1];
        },
        readMemoryBreakdown: async () => breakdown,
        readProcess: async () => processSnapshot(1, 10),
        readProcessCgroup: async () => null,
      },
      herdrSource: { listSessions: async () => [] },
    });
    const first = collector.refreshOnce();
    const second = collector.refreshOnce();
    expect(second).toBe(first);
    resolveBreakdown!({ anonPagesBytes: null, shmemBytes: null, fileCacheBytes: null, slabBytes: null });
    await first;
    expect(listCalls).toBe(1);
  });


  test("settles stop after a failed active refresh", async () => {
    const collector = createInventoryCollector({
      procSource: {
        listAllPids: async () => [],
        readMemoryBreakdown: async () => { throw new Error("meminfo unavailable"); },
        readProcess: async () => null,
        readProcessCgroup: async () => null,
      },
      herdrSource: { listSessions: async () => [] },
    });
    collector.start();
    await collector.stop();
    expect(collector.current()).toBeNull();
  });

  test("hydrates a stored snapshot before the first refresh", async () => {
    const stored: InventorySnapshot = {
      observedAt: "2026-09-05T23:00:00.000Z",
      breakdown: { anonPagesBytes: null, shmemBytes: null, fileCacheBytes: null, slabBytes: null },
      processes: [{ pid: 9, command: "stored", rssBytes: 9, association: "unassociated" }],
      allProcesses: [{ pid: 9, command: "stored", rssBytes: 9, association: "unassociated" }],
      processCount: 1,
      totalRssBytes: 9,
      remainingRssBytes: 0,
      remainingProcessCount: 0,
      groups: [{ key: "unassociated", label: "Group", rssBytes: 9, processCount: 1, top: [{ pid: 9, command: "stored", rssBytes: 9, association: "unassociated" }],
        all: [{ pid: 9, command: "stored", rssBytes: 9, association: "unassociated" }] }],
    };
    const directory = mkdtempSync(join(tmpdir(), "deathstar-inventory-hydration-"));
    temporaryDirectories.push(directory);
    const storage = createStorage(join(directory, "monitor.sqlite3"));
    storage.saveInventory(stored);
    const collector = collectorFor({ rows: [], trees: {}, cgroupSessions: {} }, storage.currentInventory());
    expect(collector.current()).toEqual(stored);
    storage.close();
  });

  test("prunes old inventory rows while keeping fresh rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "deathstar-inventory-"));
    temporaryDirectories.push(directory);
    const storage = createStorage(join(directory, "monitor.sqlite3"));
    const old: InventorySnapshot = {
      observedAt: "2026-09-05T11:00:00.000Z",
      breakdown: { anonPagesBytes: 1, shmemBytes: 2, fileCacheBytes: 3, slabBytes: 4 },
      processes: [],
      allProcesses: [],
      processCount: 0,
      totalRssBytes: 0,
      remainingRssBytes: 0,
      remainingProcessCount: 0,
      groups: [],
    };
    const fresh: InventorySnapshot = {
      observedAt: "2026-09-05T12:00:00.000Z",
      breakdown: { anonPagesBytes: 5, shmemBytes: 6, fileCacheBytes: 7, slabBytes: 8 },
      processes: [],
      allProcesses: [],
      processCount: 0,
      totalRssBytes: 0,
      remainingRssBytes: 0,
      remainingProcessCount: 0,
      groups: [],
    };
    storage.saveInventory(old);
    storage.saveInventory(fresh);
    storage.prune(new Date("2026-09-05T12:00:00.000Z"));
    expect(storage.currentInventory()).toEqual(fresh);
    storage.close();
  });
});
