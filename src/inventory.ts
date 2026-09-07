import type { HerdrSource } from "./sources/herdr.ts";
import type { ProcSource } from "./sources/proc.ts";
import type { InventoryStorage } from "./storage.ts";
import type { InventoryAssociation, InventoryGroup, InventoryProcess, InventorySnapshot, SessionSnapshot } from "./types.ts";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

type InventoryProcSource = Pick<
  ProcSource,
  "listAllPids" | "readMemoryBreakdown" | "readProcess" | "readProcessCgroup"
>;

type InventorySessionSource = Pick<HerdrSource, "listSessions">;

export interface InventoryCollectorOptions {
  procSource: InventoryProcSource;
  herdrSource: InventorySessionSource;
  storage?: Pick<InventoryStorage, "saveInventory">;
  initialSnapshot?: InventorySnapshot | null;
  intervalMs?: number;
  now?: () => Date;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface InventoryCollector {
  current(): InventorySnapshot | null;
  refreshOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

interface SessionEvidence {
  treeNamesByPid: Map<number, string[]>;
  cgroupNamesByPath: Map<string, string[]>;
}

function sessionEvidence(sessions: SessionSnapshot[]): SessionEvidence {
  const treeNamesByPid = new Map<number, string[]>();
  const cgroupNamesByPath = new Map<string, string[]>();

  for (const session of sessions) {
    for (const process of session.processes) {
      const names = treeNamesByPid.get(process.pid) ?? [];
      if (!names.includes(session.name)) names.push(session.name);
      treeNamesByPid.set(process.pid, names);
    }
    if (session.cgroupPath) {
      const names = cgroupNamesByPath.get(session.cgroupPath) ?? [];
      if (!names.includes(session.name)) names.push(session.name);
      cgroupNamesByPath.set(session.cgroupPath, names);
    }
  }

  return { treeNamesByPid, cgroupNamesByPath };
}

function associationFor(
  processPid: number,
  cgroupPath: string | null,
  evidence: SessionEvidence,
): InventoryAssociation {
  const treeNames = evidence.treeNamesByPid.get(processPid) ?? [];
  const cgroupNames = cgroupPath ? (evidence.cgroupNamesByPath.get(cgroupPath) ?? []) : [];

  if (treeNames.length > 1) return "ambiguous";
  const treeName = treeNames[0];
  if (treeName) {
    if (cgroupNames.length === 0 || cgroupNames.includes(treeName)) return `session:${treeName}`;
    return "ambiguous";
  }
  if (cgroupNames.length > 1) return `shared-cgroup:${cgroupNames.join(",")}`;
  if (cgroupNames.length === 1) return `session:${cgroupNames[0]}`;
  return "unassociated";
}

function redactCommand(command: string): string {
  return command
    .replace(/--resume\s+\S+/g, "--resume <session>")
    .replace(/\/home\/dev\/\.omp\/agent\/sessions\/\S*/g, "<session>");
}

async function readProcessRow(
  pid: number,
  procSource: InventoryProcSource,
  evidence: SessionEvidence,
): Promise<InventoryProcess | null> {
  const process = await procSource.readProcess(pid);
  if (!process) return null;

  let cgroupPath: string | null = null;
  try {
    cgroupPath = (await procSource.readProcessCgroup(pid))?.path ?? null;
  } catch (error) {
    if (!(error instanceof Error && /ENOENT|missing fixture/.test(error.message))) throw error;
  }

  return {
    pid: process.pid,
    command: redactCommand(process.command),
    rssBytes: process.rssBytes,
    association: associationFor(process.pid, cgroupPath, evidence),
  };
}

async function collectSnapshot(
  options: InventoryCollectorOptions,
  now: () => Date,
): Promise<InventorySnapshot> {
  const [breakdown, pids, sessions] = await Promise.all([
    options.procSource.readMemoryBreakdown(),
    options.procSource.listAllPids(),
    options.herdrSource.listSessions(),
  ]);
  const evidence = sessionEvidence(sessions);
  const uniquePids = [...new Set(pids)];
  const rows = (await Promise.all(uniquePids.map((pid) => readProcessRow(pid, options.procSource, evidence))))
    .filter((process): process is InventoryProcess => process !== null)
    .sort((left, right) => right.rssBytes - left.rssBytes || left.pid - right.pid);
  const totalRssBytes = rows.reduce((sum, process) => sum + process.rssBytes, 0);
  const top = rows.slice(0, 10);
  const rest = rows.slice(10);
  const remainingRssBytes = rest.reduce((sum, process) => sum + process.rssBytes, 0);
  const groupMap = new Map<string, InventoryProcess[]>();
  for (const process of rows) {
    const group = groupMap.get(process.association) ?? [];
    group.push(process);
    groupMap.set(process.association, group);
  }
  const groupLabel = (key: string): string => key.startsWith("session:")
    ? `OMP tree of herdr session “${key.slice(8)}”`
    : key.startsWith("shared-cgroup:")
      ? `Shared cgroup with sessions ${key.slice(14).split(",").map((name) => `“${name}”`).join(", ")}`
      : key === "ambiguous"
        ? "Conflicting session evidence — not assigned"
        : "No herdr session match (host service, browser, tool worker)";
  const groups = [...groupMap.entries()]
    .map(([key, members]) => {
      const sorted = [...members].sort((left, right) => right.rssBytes - left.rssBytes || left.pid - right.pid);
      return {
        key,
        label: groupLabel(key),
        rssBytes: sorted.reduce((sum, process) => sum + process.rssBytes, 0),
        processCount: sorted.length,
        top: sorted.slice(0, 5),
        all: sorted,
      };
    })
    .sort((left, right) => right.rssBytes - left.rssBytes);

  return {
    observedAt: now().toISOString(),
    breakdown,
    processes: top,
    allProcesses: rows,
    processCount: rows.length,
    totalRssBytes,
    remainingRssBytes,
    remainingProcessCount: rest.length,
    groups,
  };
}

export function createInventoryCollector(options: InventoryCollectorOptions): InventoryCollector {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let snapshot = options.initialSnapshot ?? null;
  let active: Promise<void> | null = null;
  let timer: unknown = null;
  let running = false;

  const scheduleNext = (): void => {
    if (!running || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void refreshOnce().catch(() => undefined);
    }, intervalMs);
  };

  const refreshOnce = (): Promise<void> => {
    if (active) return active;
    const attempt = (async () => {
      try {
        const next = await collectSnapshot(options, now);
        options.storage?.saveInventory?.(next);
        snapshot = next;
      } finally {
        active = null;
        scheduleNext();
      }
    })();
    active = attempt;
    return attempt;
  };

  return {
    current() {
      return snapshot;
    },

    refreshOnce,

    start() {
      if (running) return;
      running = true;
      void refreshOnce().catch(() => undefined);
    },

    async stop() {
      running = false;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (active) await active.catch(() => undefined);
    },
  };
}
