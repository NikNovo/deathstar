import type { CommandRunner } from "../command.ts";
import type { OmpState, ProcessSnapshot, SessionSnapshot } from "../types.ts";
import type { ProcSource } from "./proc.ts";

export interface HerdrSourceOptions {
  runner: CommandRunner;
  procSource: Pick<ProcSource, "listOmpPids" | "readProcess" | "readProcessCgroup" | "listPidsInCgroup">;
  herdrBinary?: string;
  commandTimeoutMs?: number;
}

export interface HerdrSource {
  listSessions(): Promise<SessionSnapshot[]>;
}

interface SessionRecord {
  name: string;
  running: boolean;
  session_dir?: string;
}

interface AgentRecord {
  agent?: string;
  agent_status?: string;
  pane_id?: string;
}

interface SnapshotRecord {
  agents?: AgentRecord[];
  panes?: Array<{ pane_id?: string; cwd?: string; foreground_cwd?: string }>;
  focused_pane_id?: string;
}

interface ForegroundProcessRecord {
  name?: string;
  pid?: number;
  cmdline?: string;
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${reason}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateFromAgent(agentStatus: string | null, hasOmp: boolean): OmpState {
  if (!hasOmp) return "missing";
  if (agentStatus === "working") return "working";
  if (agentStatus === "idle" || agentStatus === "done") return "idle";
  return "unknown";
}
function isOmpProcess(process: ProcessSnapshot): boolean {
  return process.command.split(/\s+/).some((part) => part === "omp" || part.endsWith("/omp"));
}

function foregroundTree(processes: ProcessSnapshot[], rootPid: number): ProcessSnapshot[] {
  const children = new Map<number, number[]>();
  for (const process of processes) {
    if (process.ppid === null) continue;
    const group = children.get(process.ppid) || [];
    group.push(process.pid);
    children.set(process.ppid, group);
  }
  const selected = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of children.get(parent) || []) {
      if (selected.has(child)) continue;
      selected.add(child);
      queue.push(child);
    }
  }
  return processes.filter((process) => selected.has(process.pid));
}

function baseSession(session: SessionRecord, observedAt: string): SessionSnapshot {
  return {
    name: session.name,
    status: session.running ? "running" : "stopped",
    directory: session.session_dir || null,
    paneId: null,
    agentStatus: null,
    ompPid: null,
    cgroupShared: false,
    ompState: session.running ? "unknown" : "missing",
    processes: [],
    cgroupPath: null,
    cgroupCurrentBytes: null,
    cgroupPeakBytes: null,
    cgroupOomKillCount: null,
    observedAt,
    error: null,
  };
}

export function createHerdrSource(options: HerdrSourceOptions): HerdrSource {
  const herdrBinary = options.herdrBinary || "herdr";
  const commandTimeoutMs = options.commandTimeoutMs || 2000;

  async function runJson(args: string[], label: string): Promise<any> {
    const result = await options.runner.run([herdrBinary, ...args], commandTimeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`${label} failed with exit ${result.exitCode}: ${result.stderr.trim()}`);
    }
    return parseJson(result.stdout, label);
  }

  async function collectSession(session: SessionRecord): Promise<SessionSnapshot> {
    const observedAt = new Date().toISOString();
    const result = baseSession(session, observedAt);
    if (!session.running) return result;

    try {
      const snapshotResponse = await runJson(["--session", session.name, "api", "snapshot"], `session ${session.name} snapshot`);
      const snapshot = snapshotResponse?.result?.snapshot as SnapshotRecord | undefined;
      const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
      const agent = agents.find((candidate) => candidate.agent === "omp") || agents[0];
      const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
      const paneId = agent?.pane_id || snapshot?.focused_pane_id || panes[0]?.pane_id || null;
      const agentStatus = typeof agent?.agent_status === "string" ? agent.agent_status : null;
      result.paneId = paneId;
      result.agentStatus = agentStatus;

      if (!paneId) {
        result.ompState = "missing";
        return result;
      }

      const processResponse = await runJson(
        ["--session", session.name, "pane", "process-info", "--pane", paneId],
        `session ${session.name} process info`,
      );
      const foreground = (processResponse?.result?.process_info?.foreground_processes || []) as ForegroundProcessRecord[];
      const foregroundOmp = foreground.filter((process) => {
        const command = process.cmdline || "";
        return process.name === "omp" || command.split(/\s+/).some((part) => part === "omp" || part.endsWith("/omp"));
      });
      const knownOmpPids = new Set(await options.procSource.listOmpPids());
      const foregroundProcess = foregroundOmp.find((process) => process.pid !== undefined && knownOmpPids.has(process.pid));
      const ompPid = foregroundProcess?.pid;
      if (ompPid === undefined) {
        result.ompState = "missing";
        return result;
      }

      result.ompPid = ompPid;
      const cgroup = await options.procSource.readProcessCgroup(ompPid);
      const pids = cgroup ? await options.procSource.listPidsInCgroup(cgroup.path) : [ompPid];
      const processes = (await Promise.all(pids.map((pid) => options.procSource.readProcess(pid)))).filter(
        (process): process is ProcessSnapshot => process !== null,
      );
      const selectedProcesses = foregroundTree(processes, ompPid);
      const cgroupOmpPids = processes.filter(isOmpProcess).map((process) => process.pid);
      result.processes = selectedProcesses;
      result.cgroupShared = cgroup !== null
        && (pids.length !== processes.length || selectedProcesses.length !== processes.length || cgroupOmpPids.some((pid) => pid !== ompPid));
      result.cgroupPath = cgroup?.path ?? null;
      result.cgroupCurrentBytes = cgroup?.currentBytes ?? null;
      result.cgroupPeakBytes = cgroup?.peakBytes ?? null;
      result.cgroupOomKillCount = cgroup?.oomKillCount ?? null;
      result.ompState = stateFromAgent(agentStatus, selectedProcesses.some((process) => process.pid === ompPid));
      return result;
    } catch (error) {
      result.error = errorMessage(error);
      result.ompState = "unknown";
      return result;
    }
  }

  return {
    async listSessions() {
      const response = await runJson(["session", "list", "--json"], "session list");
      const sessions = Array.isArray(response?.sessions) ? response.sessions as SessionRecord[] : [];
      return Promise.all(sessions.map((session) => collectSession(session)));
    },
  };
}
