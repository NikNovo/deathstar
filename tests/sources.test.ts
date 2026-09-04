import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/command.ts";
import type { CgroupSnapshot, FileReader, ProcSource, ProcSourceOptions } from "../src/sources/proc.ts";
import type { ProcessSnapshot } from "../src/types.ts";
import { createHerdrSource } from "../src/sources/herdr.ts";
import { createProcSource } from "../src/sources/proc.ts";

class MapReader implements FileReader {
  constructor(private readonly files: Map<string, string>) {}

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing fixture: ${path}`);
    return value;
  }
}
class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly responses: Record<string, CommandResult>) {}

  async run(args: string[], _timeoutMs: number): Promise<CommandResult> {
    this.calls.push(args);
    const response = this.responses[args.join(" ")];
    if (!response) throw new Error(`missing command fixture: ${args.join(" ")}`);
    return response;
  }
}

function options(files: Map<string, string>): ProcSourceOptions {
  return {
    reader: new MapReader(files),
    procRoot: "/proc-fixture",
    cgroupRoot: "/cgroup-fixture",
    statfs: async () => ({
      blockSize: 4096,
      blocks: 100,
      availableBlocks: 25,
    }),
    listPids: async () => [42, 43],
    readlink: async () => "/tmp/agent-alpha",
  };
}

function baseFiles(): Map<string, string> {
  return new Map([
    ["/proc-fixture/meminfo", "MemTotal:       16777216 kB\nMemFree:         4194304 kB\nMemAvailable:    8388608 kB\nBuffers:          524288 kB\nCached:          2097152 kB\nSwapTotal:       4194304 kB\nSwapFree:        3145728 kB\n"],
    ["/proc-fixture/swaps", "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/swapfile file 4194300 1048576 -1\n"],
    ["/proc-fixture/loadavg", "0.12 0.34 0.56 2/1234 5678\n"],
    ["/proc-fixture/pressure/memory", "some avg10=0.00 avg60=0.10 avg300=1.20 total=120000\nfull avg10=0.00 avg60=0.05 avg300=0.60 total=60000\n"],
    ["/proc-fixture/stat", "btime 1700000000\n"],
    ["/cgroup-fixture/memory.current", "8589934592\n"],
    ["/cgroup-fixture/memory.max", "max\n"],
    ["/cgroup-fixture/memory.events", "low 0\nhigh 0\nmax 0\noom 0\noom_kill 7\noom_group_kill 0\n"],
    ["/proc-fixture/42/stat", "42 (omp) S 7 42 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 250 0 0\n"],
    ["/proc-fixture/42/status", "Name:\tomp\nState:\tS (sleeping)\nPPid:\t7\nVmSize:\t2048 kB\nVmRSS:\t1024 kB\n"],
    ["/proc-fixture/42/cmdline", "bun\u0000/synthetic/bin/omp\u0000"],
    ["/proc-fixture/43/status", "Name:\tbash\nState:\tS (sleeping)\nPPid:\t7\nVmSize:\t512 kB\nVmRSS:\t256 kB\n"],
    ["/proc-fixture/43/cmdline", "bash\u0000"],
  ]);
}

describe("proc source", () => {
  test("parses memory, swap, load, cgroup, and filesystem values", async () => {
    const source = createProcSource(options(baseFiles()));
    const host = await source.readHost();

    expect(host.totalBytes).toBe(16777216 * 1024);
    expect(host.availableBytes).toBe(8388608 * 1024);
    expect(host.usedBytes).toBe((16777216 - 8388608) * 1024);
    expect(host.swapTotalBytes).toBe(4194300 * 1024);
    expect(host.swapUsedBytes).toBe(1048576 * 1024);
    expect(host.load1).toBe(0.12);
    expect(host.load15).toBe(0.56);
    expect(host.cgroupCurrentBytes).toBe(8589934592);
    expect(host.cgroupLimitBytes).toBeNull();
    expect(host.oomKillCount).toBe(7);
    expect(host.memoryPressure).toEqual({
      some: { avg10: 0, avg60: 0.1, avg300: 1.2, total: 120000 },
      full: { avg10: 0, avg60: 0.05, avg300: 0.6, total: 60000 },
    });
    expect(host.rootTotalBytes).toBe(409600);
    expect(host.rootUsedBytes).toBe(307200);
    expect(host.tmpTotalBytes).toBe(409600);
    expect(host.tmpUsedBytes).toBe(307200);
    expect(host.state).toBe("ok");
  });

  test("parses OMP process and filters non-OMP PIDs", async () => {
    const source = createProcSource(options(baseFiles()));

    expect(await source.listOmpPids()).toEqual([42]);
    expect(await source.readProcess(42)).toMatchObject({
      pid: 42,
      ppid: 7,
      command: "bun /synthetic/bin/omp",
      cwd: "/tmp/agent-alpha",
      rssBytes: 1024 * 1024,
      virtualBytes: 2048 * 1024,
      state: "S (sleeping)",
      startedAt: "2023-11-14T22:13:22.500Z",
    });
  });

  test("reads process cgroup membership and worker PIDs", async () => {
    const files = baseFiles();
    files.set("/proc-fixture/42/cgroup", "0::/user.slice/user-1000.slice/session-42.scope\n");
    files.set("/cgroup-fixture-root/user.slice/user-1000.slice/session-42.scope/memory.current", "4096\n");
    files.set("/cgroup-fixture-root/user.slice/user-1000.slice/session-42.scope/memory.peak", "8192\n");
    files.set("/cgroup-fixture-root/user.slice/user-1000.slice/session-42.scope/memory.events", "oom_kill 3\n");
    files.set("/cgroup-fixture-root/user.slice/user-1000.slice/session-42.scope/cgroup.procs", "42\n43\n");
    const source = createProcSource({
      ...options(files),
      cgroupFsRoot: "/cgroup-fixture-root",
    });

    expect(await source.readProcessCgroup(42)).toEqual({
      path: "/user.slice/user-1000.slice/session-42.scope",
      currentBytes: 4096,
      peakBytes: 8192,
      oomKillCount: 3,
    });
    expect(await source.listPidsInCgroup("/user.slice/user-1000.slice/session-42.scope")).toEqual([42, 43]);
  });

  test("rejects malformed host input instead of returning healthy zeros", async () => {
    const files = baseFiles();
    files.set("/proc-fixture/meminfo", "MemTotal: malformed\n");
    const source = createProcSource(options(files));

    await expect(source.readHost()).rejects.toThrow("MemTotal");
  });
});
function commandResult(stdout: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: "" };
}

function fakeProcess(pid: number, command: string): ProcessSnapshot {
  return {
    pid,
    ppid: pid === 43 ? 42 : 7,
    command,
    cwd: "/synthetic/events",
    rssBytes: pid === 42 ? 1024 * 1024 : 256 * 1024,
    virtualBytes: pid === 42 ? 2048 * 1024 : 512 * 1024,
    state: "S (sleeping)",
    startedAt: "2023-11-14T22:13:22.500Z",
  };
}

function fakeCgroup(oomKillCount = 2): CgroupSnapshot {
  return {
    path: "/user.slice/user-1000.slice/session-42.scope",
    currentBytes: 4 * 1024 ** 3,
    peakBytes: 5 * 1024 ** 3,
    oomKillCount,
  };
}

test("collects a named Herdr session and preserves zero OOM counts", async () => {
  const runner = new FakeRunner({
    "herdr session list --json": commandResult({
      sessions: [{
        default: false,
        name: "agent-alpha",
        running: true,
        session_dir: "/synthetic/events",
        socket_path: "/synthetic/herdr/sessions/agent-alpha/herdr.sock",
      }],
    }),
    "herdr --session agent-alpha api snapshot": commandResult({
      result: {
        snapshot: {
          agents: [{ agent: "omp", agent_status: "working", pane_id: "w1:p1" }],
          panes: [{ pane_id: "w1:p1", cwd: "/synthetic/events", foreground_cwd: "/synthetic/events" }],
        },
      },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": commandResult({
      result: {
        process_info: {
          foreground_processes: [{
            argv: ["bun", "/synthetic/bin/omp"],
            cmdline: "bun /synthetic/bin/omp",
            cwd: "/synthetic/events",
            name: "omp",
            pid: 42,
          }],
        },
      },
    }),
  });
  let oomKillCount = 2;
  const procSource: ProcSource = {
    readHost: async () => { throw new Error("unused"); },
    readProcess: async (pid) => fakeProcess(pid, pid === 42 ? "bun /synthetic/bin/omp" : "python worker"),
    listOmpPids: async () => [42],
    readProcessCgroup: async () => fakeCgroup(oomKillCount),
    listPidsInCgroup: async () => [42, 43],
  };
  const source = createHerdrSource({ runner, procSource, herdrBinary: "herdr", commandTimeoutMs: 1000 });

  const [session] = await source.listSessions();

  expect(session).toMatchObject({
    name: "agent-alpha",
    status: "running",
    directory: "/synthetic/events",
    paneId: "w1:p1",
    agentStatus: "working",
    ompState: "working",
    ompPid: 42,
    cgroupShared: false,
    cgroupPath: "/user.slice/user-1000.slice/session-42.scope",
    cgroupCurrentBytes: 4 * 1024 ** 3,
    cgroupPeakBytes: 5 * 1024 ** 3,
    cgroupOomKillCount: 2,
    error: null,
  });
  expect(session.processes.map((process) => process.pid)).toEqual([42, 43]);
  expect(runner.calls).toHaveLength(3);
  oomKillCount = 0;
  const [zeroSession] = await source.listSessions();
  expect(zeroSession?.cgroupOomKillCount).toBe(0);
});
test("separates a foreground OMP from sibling processes in a shared cgroup", async () => {
  const runner = new FakeRunner({
    "herdr session list --json": commandResult({
      sessions: [{ default: false, name: "agent-alpha", running: true, session_dir: "/synthetic/events" }],
    }),
    "herdr --session agent-alpha api snapshot": commandResult({
      result: { snapshot: { agents: [{ agent: "omp", agent_status: "working", pane_id: "w1:p1" }] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": commandResult({
      result: { process_info: { foreground_processes: [{ name: "omp", pid: 42, cmdline: "bun /synthetic/bin/omp" }] } },
    }),
  });
  const procSource: ProcSource = {
    readHost: async () => { throw new Error("unused"); },
    readProcess: async (pid) => fakeProcess(pid, pid === 42 || pid === 44 ? "bun /synthetic/bin/omp" : "python worker"),
    listOmpPids: async () => [42, 44],
    readProcessCgroup: async () => fakeCgroup(2),
    listPidsInCgroup: async () => [42, 43, 44],
  };
  const source = createHerdrSource({ runner, procSource, herdrBinary: "herdr", commandTimeoutMs: 1000 });

  const [session] = await source.listSessions();

  expect(session?.ompPid).toBe(42);
  expect(session?.processes.map((process) => process.pid)).toEqual([42, 43]);
  expect(session?.cgroupShared).toBe(true);
});
test("does not trust a foreground OMP missing from the global PID scan", async () => {
  const runner = new FakeRunner({
    "herdr session list --json": commandResult({
      sessions: [{ default: false, name: "agent-alpha", running: true, session_dir: "/synthetic/events" }],
    }),
    "herdr --session agent-alpha api snapshot": commandResult({
      result: { snapshot: { agents: [{ agent: "omp", agent_status: "working", pane_id: "w1:p1" }] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": commandResult({
      result: { process_info: { foreground_processes: [{ name: "omp", pid: 42, cmdline: "bun /synthetic/bin/omp" }] } },
    }),
  });
  const procSource: ProcSource = {
    readHost: async () => { throw new Error("unused"); },
    readProcess: async (pid) => fakeProcess(pid, "bun /synthetic/bin/omp"),
    listOmpPids: async () => [44],
    readProcessCgroup: async () => fakeCgroup(0),
    listPidsInCgroup: async () => [42],
  };
  const source = createHerdrSource({ runner, procSource, herdrBinary: "herdr", commandTimeoutMs: 1000 });

  const [session] = await source.listSessions();

  expect(session?.ompPid).toBeNull();
  expect(session?.ompState).toBe("missing");
  expect(session?.processes).toEqual([]);
});
