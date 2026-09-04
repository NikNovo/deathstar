import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/cli.ts";
import { createMappingStore, validateSessionName } from "../src/recovery/mapping.ts";
import type { CommandResult, CommandRunner } from "../src/command.ts";
import type { ProcessFiles } from "../src/recovery/process-files.ts";
import { createProcessFiles } from "../src/recovery/process-files.ts";
import { createHerdrControl, type HerdrControl } from "../src/recovery/herdr-control.ts";
import { createRecoveryWorkflow } from "../src/recovery/workflow.ts";
import type { RecoveryMapping } from "../src/recovery/types.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function mapping(): RecoveryMapping {
  return {
    version: 1,
    herdrSession: "agent-alpha",
    paneId: "w1:p1",
    ompPid: 1174310,
    processStartedAt: "2026-08-20T09:00:00.000Z",
    sessionFile: "/sessions/-tmp/exact.jsonl",
    sessionRoot: "/sessions",
    cwd: "/tmp",
    capturedAt: "2026-08-23T12:00:00.000Z",
    fileSize: 100,
    fileMtimeMs: 200,
  };
}

test("parses one-session recovery commands and no-attach", () => {
  expect(parseArguments(["session", "open", "agent-alpha"])).toEqual({
    command: "open",
    name: "agent-alpha",
    noAttach: false,
    json: false,
  });
  expect(parseArguments(["session", "open", "agent-alpha", "--no-attach", "--json"])).toEqual({
    command: "open",
    name: "agent-alpha",
    noAttach: true,
    json: true,
  });
  expect(() => parseArguments(["session", "open", "bad/name"])).toThrow("session name");
  expect(() => parseArguments(["status", "agent-alpha"])).toThrow("session");
});

describe("mapping store", () => {
  test("round-trips an atomic mapping with secure directory/file modes", () => {
    const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
    tempDirectories.push(directory);
    const store = createMappingStore({ directory });
    const expected = mapping();

    store.write(expected);

    expect(store.read("agent-alpha")).toEqual(expected);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(store.path("agent-alpha")).mode & 0o777).toBe(0o600);
  });

  test("rejects unsafe names and unknown mapping versions", () => {
    expect(validateSessionName("agent-alpha")).toBe("agent-alpha");
    expect(() => validateSessionName("../dev" )).toThrow("session name");
    expect(() => validateSessionName("bad/name")).toThrow("session name");
    expect(() => validateSessionName(" ")).toThrow("session name");

    const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
    tempDirectories.push(directory);
    const store = createMappingStore({ directory });
    store.write(mapping());
    Bun.write(store.path("agent-alpha"), JSON.stringify({ version: 2 }));
    expect(() => store.read("agent-alpha")).toThrow("version");
  });
});

test("discovers one exact primary JSONL and rejects ambiguity", async () => {
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [
      sessionFile,
      "/sessions/-tmp/__advisor.jsonl",
      "/tmp/other.jsonl",
    ],
    readProcText: async (path) => {
      if (path === "/proc/stat") return "btime 1700000000";
      if (path.endsWith("/cmdline")) return "bun\\u0000/synthetic/bin/omp\\u0000";
      if (path.endsWith("/cwd")) return "/tmp";
      if (path.endsWith("/stat")) return "42 (omp) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 250 0 0";
      throw new Error(`unexpected path: ${path}`);
    },
    stat: async () => ({ size: 123, mtimeMs: 456 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });

  expect(await processFiles.findPrimarySessionFiles(42, "/sessions")).toEqual([sessionFile]);

  const duplicate = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [sessionFile, sessionFile],
    readProcText: async () => "",
    stat: async () => ({ size: 1, mtimeMs: 1 }),
    isAlive: () => true,
  });
  expect(await duplicate.findPrimarySessionFiles(42, "/sessions")).toEqual([sessionFile]);
  expect(await processFiles.processCommand(42)).toContain("/synthetic/bin/omp");
  expect(await processFiles.processCwd(42)).toBe("/tmp");
  expect(await processFiles.readProcessStartTime(42)).toBe("2023-11-14T22:13:22.500Z");
  expect(await processFiles.fileMetadata(sessionFile)).toEqual({ size: 123, mtimeMs: 456 });

  const ambiguous = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [sessionFile, "/sessions/-tmp/other.jsonl"],
    readProcText: async () => "",
    stat: async () => ({ size: 1, mtimeMs: 1 }),
    isAlive: () => true,
  });
  await expect(ambiguous.findPrimarySessionFiles(42, "/sessions")).rejects.toThrow("ambiguous");
});
class RecoveryCommandRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly responses: Record<string, CommandResult>) {}

  async run(args: string[], _timeoutMs: number): Promise<CommandResult> {
    this.calls.push(args);
    const response = this.responses[args.join(" ")];
    if (!response) throw new Error(`missing recovery command fixture: ${args.join(" ")}`);
    return response;
  }
}

function recoveryResult(value: unknown): CommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fakeProcessFiles(): ProcessFiles {
  return {
    findPrimarySessionFiles: async () => ["/sessions/europe.jsonl"],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => "bun /synthetic/bin/omp",
    processCwd: async () => "/tmp",
    isAlive: () => false,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
}

test("Herdr control uses exact pane command arrays", async () => {
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: {
        snapshot: {
          focused_pane_id: "w1:p1",
          panes: [{ pane_id: "w1:p1" }],
        },
      },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: {
        process_info: {
          shell_pid: 971679,
          foreground_processes: [{ pid: 1174310, name: "omp", cmdline: "bun /synthetic/bin/omp" }],
        },
      },
    }),
    "herdr --session agent-alpha pane send-keys w1:p1 ctrl+d": recoveryResult({}),
    "herdr session stop agent-alpha": recoveryResult({}),
  });
  const control = createHerdrControl({ runner, processFiles: fakeProcessFiles(), herdrBinary: "herdr" });

  expect(await control.currentPane("agent-alpha")).toEqual({
    paneId: "w1:p1",
    shellPid: 971679,
    foregroundPids: [1174310],
  });
  await control.sendExitKey("agent-alpha", "w1:p1");
  await control.stopSession("agent-alpha");
  expect(runner.calls.slice(-2)).toEqual([
    ["herdr", "--session", "agent-alpha", "pane", "send-keys", "w1:p1", "ctrl+d"],
    ["herdr", "session", "stop", "agent-alpha"],
  ]);
});

test("inspects a requested mapped pane instead of the focused pane", async () => {
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: {
        snapshot: {
          focused_pane_id: "w1:p2",
          panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }],
        },
      },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: {
        process_info: {
          shell_pid: 971679,
          foreground_processes: [{ pid: 99, name: "omp", cmdline: "bun /synthetic/bin/omp" }],
        },
      },
    }),
  });
  const control = createHerdrControl({ runner, processFiles: fakeProcessFiles() });

  await expect(control.currentPane("agent-alpha", "w1:p1")).resolves.toEqual({
    paneId: "w1:p1",
    shellPid: 971679,
    foregroundPids: [99],
  });
});

test("lists every Herdr pane with process-info command calls", async () => {
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: {
        snapshot: {
          focused_pane_id: "w1:p2",
          panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }],
        },
      },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: { process_info: { shell_pid: 971679, foreground_processes: [] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p2": recoveryResult({
      result: { process_info: { shell_pid: 971680, foreground_processes: [{ pid: 99 }] } },
    }),
  });
  const control = createHerdrControl({ runner, processFiles: fakeProcessFiles() });

  await expect(control.listPanes("agent-alpha")).resolves.toEqual([
    { paneId: "w1:p1", shellPid: 971679, foregroundPids: [] },
    { paneId: "w1:p2", shellPid: 971680, foregroundPids: [99] },
  ]);
  expect(runner.calls.filter((args) => args.includes("process-info"))).toEqual([
    ["herdr", "--session", "agent-alpha", "pane", "process-info", "--pane", "w1:p1"],
    ["herdr", "--session", "agent-alpha", "pane", "process-info", "--pane", "w1:p2"],
  ]);
});

test("bind close and open preserve one exact mapping", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  let pane = { paneId: "w1:p1", shellPid: 971679, foregroundPids: [1174310] };
  let alive = true;
  const controlCalls: string[] = [];
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => "bun /synthetic/bin/omp",
    processCwd: async () => "/tmp",
    isAlive: () => alive,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => pane,
    listPanes: async () => [pane],
    sendExitKey: async () => { controlCalls.push("exit"); alive = false; pane = { ...pane, foregroundPids: [] }; },
    runInPane: async () => { controlCalls.push("run"); alive = true; pane = { ...pane, foregroundPids: [222] }; },
    stopSession: async () => { controlCalls.push("stop"); },
    ensureSession: async () => { controlCalls.push("ensure"); },
    waitForPidExit: async () => {},
    waitForMappedPid: async () => { controlCalls.push("wait"); return 222; },
    attach: async () => { controlCalls.push("attach"); return 0; },
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: true, now: () => new Date("2026-08-23T12:00:00.000Z") });

  const bound = await workflow.bind("agent-alpha");
  expect(bound.sessionFile).toBe(sessionFile);
  expect((await workflow.status("agent-alpha")).state).toBe("open");

  await workflow.close("agent-alpha");
  expect(controlCalls).toEqual(["exit", "stop"]);
  expect((await workflow.status("agent-alpha")).state).toBe("closed");

  const opened = await workflow.open("agent-alpha", { noAttach: true });
  expect(opened.mapping?.sessionFile).toBe(sessionFile);
  expect(controlCalls).toEqual(["exit", "stop", "ensure", "run", "wait"]);
  await workflow.open("agent-alpha", { noAttach: false });
  expect(controlCalls.at(-1)).toBe("attach");
});

test("recognizes exact resume argv without treating it as an open FD", async () => {
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume\u0000${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });

  await expect(processFiles.findPrimarySessionFiles(99, "/sessions")).rejects.toThrow("no primary");
  expect(await processFiles.resumeSessionFile(99, "/sessions")).toBe(sessionFile);

  const inlineProcessFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume=${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  expect(await inlineProcessFiles.resumeSessionFile(99, "/sessions")).toBe(sessionFile);
});

test("prefers exact resume argv when subagent JSONLs are also open", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [sessionFile, "/sessions/-tmp/SurveyFunnel.jsonl", "/sessions/-tmp/RereviewSurveyFix.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume\u0000${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.status("agent-alpha")).resolves.toMatchObject({
    state: "open",
    currentOmpPid: 99,
    currentSessionFile: sessionFile,
  });
});

test("status uses the mapped JSONL when the parent has child JSONLs open", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [sessionFile, "/sessions/-tmp/ReviewRecoveryDrift.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? "bun\u0000/synthetic/bin/omp\u0000"
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.status("agent-alpha")).resolves.toMatchObject({
    state: "open",
    currentOmpPid: 99,
    currentSessionFile: sessionFile,
  });
});


test("waits for an exact resumed path when child JSONLs are open", async () => {
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => [sessionFile, "/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume=${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: { snapshot: { focused_pane_id: "w1:p1", panes: [{ pane_id: "w1:p1" }] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: { process_info: { shell_pid: 971679, foreground_processes: [{ pid: 99 }] } },
    }),
  });
  const control = createHerdrControl({ runner, processFiles, sessionRoot: "/sessions", pollIntervalMs: 1 });

  await expect(control.waitForMappedPid("agent-alpha", sessionFile, 100)).resolves.toBe(99);
});

test("rejects a mapped session file outside the configured session root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  mappingStore.write({ ...mapping(), sessionFile: "/tmp/outside.jsonl", sessionRoot: "/sessions" });
  let metadataReads = 0;
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => null,
    processCommand: async () => "",
    processCwd: async () => "/tmp",
    isAlive: () => false,
    fileMetadata: async () => {
      metadataReads += 1;
      return { size: 10, mtimeMs: 20 };
    },
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 1, foregroundPids: [] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 1, foregroundPids: [] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 1,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.open("agent-alpha", { noAttach: true })).rejects.toThrow("outside the configured OMP session root");
  expect(metadataReads).toBe(0);
});

test("reuses an exact OMP auto-restored while opening a Herdr session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile });

  let sessionReady = false;
  let pane = { paneId: "w1:p1", shellPid: 971679, foregroundPids: [] as number[] };
  const controlCalls: string[] = [];
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume ${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => {
      if (!sessionReady) throw new Error("server_not_running");
      return pane;
    },
    listPanes: async () => [pane],
    sendExitKey: async () => {},
    runInPane: async () => { controlCalls.push("run"); },
    stopSession: async () => {},
    ensureSession: async () => {
      controlCalls.push("ensure");
      sessionReady = true;
      pane = { ...pane, foregroundPids: [222] };
    },
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 222,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  const opened = await workflow.open("agent-alpha", { noAttach: true });

  expect(opened.state).toBe("open");
  expect(opened.currentOmpPid).toBe(222);
  expect(opened.currentSessionFile).toBe(sessionFile);
  expect(opened.mapping?.ompPid).toBe(222);
  expect(mappingStore.read("agent-alpha")?.ompPid).toBe(222);
  expect(controlCalls).toEqual(["ensure"]);
});

test("adopts an exact OMP that appears after the restore probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile });

  let sessionReady = false;
  let paneReads = 0;
  let pane = { paneId: "w1:p1", shellPid: 971679, foregroundPids: [] as number[] };
  const controlCalls: string[] = [];
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume=${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => {
      if (!sessionReady) throw new Error("server_not_running");
      paneReads += 1;
      pane = { ...pane, foregroundPids: paneReads >= 2 ? [222] : [] };
      return pane;
    },
    listPanes: async () => [pane],
    sendExitKey: async () => {},
    runInPane: async () => { controlCalls.push("run"); },
    stopSession: async () => {},
    ensureSession: async () => {
      controlCalls.push("ensure");
      sessionReady = true;
    },
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 222,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  const opened = await workflow.open("agent-alpha", { noAttach: true });

  expect(opened.state).toBe("open");
  expect(opened.currentOmpPid).toBe(222);
  expect(opened.mapping?.ompPid).toBe(222);
  expect(controlCalls).toEqual(["ensure"]);
});

test("refuses close when the mapped OMP PID or start time changed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({
    ...mapping(),
    sessionFile,
    ompPid: 111,
    processStartedAt: "2026-08-23T12:00:00.000Z",
  });
  let sentExit = false;
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:01.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume=${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [222] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [222] }],
    sendExitKey: async () => { sentExit = true; },
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 222,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.close("agent-alpha")).rejects.toThrow("mapped OMP identity changed");
  expect(sentExit).toBe(false);
});

test("close follows the mapped pane when Herdr focus moved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({
    ...mapping(),
    sessionFile,
    ompPid: 222,
    processStartedAt: "2026-08-23T12:00:00.000Z",
  });
  let alive = true;
  let sentExit = false;
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume=${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => alive,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async (_name, paneId) => paneId === "w1:p1"
      ? { paneId: "w1:p1", shellPid: 971679, foregroundPids: [222] }
      : { paneId: "w1:p2", shellPid: 971680, foregroundPids: [] },
    listPanes: async () => [
      { paneId: "w1:p1", shellPid: 971679, foregroundPids: [222] },
      { paneId: "w1:p2", shellPid: 971680, foregroundPids: [] },
    ],
    sendExitKey: async () => {
      sentExit = true;
      alive = false;
    },
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 222,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.close("agent-alpha")).resolves.toMatchObject({ state: "closed" });
  expect(sentExit).toBe(true);
});

test("bind discovers an OMP in a non-focused Herdr pane", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [] }),
    listPanes: async () => [
      { paneId: "w1:p1", shellPid: 971679, foregroundPids: [] },
      { paneId: "w1:p2", shellPid: 971680, foregroundPids: [222] },
    ],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 222,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.bind("agent-alpha")).resolves.toMatchObject({
    paneId: "w1:p2",
    ompPid: 222,
    sessionFile,
  });
});

test("open starts the mapped pane after focus changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, paneId: "w1:p1" });
  let sessionReady = false;
  let running = false;
  const observed = { runPane: null as string | null, waitPane: undefined as string | undefined };
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume=${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async (_name, paneId) => {
      if (!sessionReady) throw new Error("server_not_running");
      if (paneId === "w1:p1" && running) return { paneId: "w1:p1", shellPid: 971679, foregroundPids: [222] };
      return paneId === "w1:p1"
        ? { paneId: "w1:p1", shellPid: 971679, foregroundPids: [] }
        : { paneId: "w1:p2", shellPid: 971680, foregroundPids: [] };
    },
    listPanes: async () => [
      { paneId: "w1:p1", shellPid: 971679, foregroundPids: [] },
      { paneId: "w1:p2", shellPid: 971680, foregroundPids: [] },
    ],
    sendExitKey: async () => {},
    runInPane: async (_name, paneId) => {
      observed.runPane = paneId;
      running = true;
    },
    stopSession: async () => {},
    ensureSession: async () => { sessionReady = true; },
    waitForPidExit: async () => {},
    waitForMappedPid: async (_name, _sessionFile, _timeoutMs, paneId) => {
      observed.waitPane = paneId;
      return 222;
    },
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  const opened = await workflow.open("agent-alpha", { noAttach: true });

  expect(opened.state).toBe("open");
  expect(observed.runPane).toBe("w1:p1");
  expect(observed.waitPane).toBe("w1:p1");
});
test("open adopts the only replacement pane after Herdr restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, paneId: "w1:p1" });
  let sessionReady = false;
  let running = false;
  const observed = { runPane: null as string | null, waitPane: undefined as string | undefined };
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume=${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => {
      if (!sessionReady) throw new Error("server_not_running");
      return {};
    },
    currentPane: async (_name, paneId) => {
      if (!sessionReady) throw new Error("server_not_running");
      if (paneId === "w2:p1" && running) return { paneId: "w2:p1", shellPid: 971680, foregroundPids: [222] };
      if (paneId === "w2:p1") return { paneId: "w2:p1", shellPid: 971680, foregroundPids: [] };
      throw new Error("pane_not_found: w1:p1");
    },
    listPanes: async () => {
      if (!sessionReady) throw new Error("server_not_running");
      return [{ paneId: "w2:p1", shellPid: 971680, foregroundPids: running ? [222] : [] }];
    },
    sendExitKey: async () => {},
    runInPane: async (_name, paneId) => {
      observed.runPane = paneId;
      running = true;
    },
    stopSession: async () => {},
    ensureSession: async () => { sessionReady = true; },
    waitForPidExit: async () => {},
    waitForMappedPid: async (_name, _sessionFile, _timeoutMs, paneId) => {
      observed.waitPane = paneId;
      return 222;
    },
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  const opened = await workflow.open("agent-alpha", { noAttach: true });

  expect(opened.state).toBe("open");
  expect(observed.runPane).toBe("w2:p1");
  expect(observed.waitPane).toBe("w2:p1");
  expect(mappingStore.read("agent-alpha")).toMatchObject({ paneId: "w2:p1", ompPid: 222 });
});

test("status reports a live Herdr session when its mapped pane disappeared", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => null,
    processCommand: async () => "",
    processCwd: async () => "/tmp",
    isAlive: () => false,
    fileMetadata: async () => ({ size: 10, mtimeMs: 20 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => { throw new Error("pane_not_found: w1:p1"); },
    listPanes: async () => [{ paneId: "w2:p1", shellPid: 971680, foregroundPids: [] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.status("agent-alpha")).resolves.toMatchObject({
    state: "closed",
    sessionExists: true,
    error: "pane_not_found: w1:p1",
  });
});

test("open adopts an already-running OMP in the replacement pane", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions", paneId: "w1:p1" });
  let sessionReady = false;
  const observed = { runPane: null as string | null, waitPane: null as string | null };
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [sessionFile],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => "2026-08-23T12:00:00.000Z",
    processCommand: async () => `bun /synthetic/bin/omp --resume=${sessionFile}`,
    processCwd: async () => "/tmp",
    isAlive: () => true,
    fileMetadata: async () => ({ size: 100, mtimeMs: 200 }),
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => {
      if (!sessionReady) throw new Error("server_not_running");
      return {};
    },
    currentPane: async (_name, paneId) => {
      if (!sessionReady) throw new Error("server_not_running");
      if (paneId === "w2:p1") return { paneId, shellPid: 971680, foregroundPids: [222] };
      throw new Error("pane_not_found: w1:p1");
    },
    listPanes: async () => {
      if (!sessionReady) throw new Error("server_not_running");
      return [{ paneId: "w2:p1", shellPid: 971680, foregroundPids: [222] }];
    },
    sendExitKey: async () => {},
    runInPane: async (_name, paneId) => { observed.runPane = paneId; },
    stopSession: async () => {},
    ensureSession: async () => { sessionReady = true; },
    waitForPidExit: async () => {},
    waitForMappedPid: async (_name, _sessionFile, _timeoutMs, paneId) => {
      observed.waitPane = paneId || null;
      return 222;
    },
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  const opened = await workflow.open("agent-alpha", { noAttach: true });

  expect(opened.state).toBe("open");
  expect(observed.runPane).toBeNull();
  expect(observed.waitPane).toBeNull();
  expect(opened.mapping).toMatchObject({ paneId: "w2:p1", ompPid: 222, sessionFile });
});



test("prefers exact resume argv over a lone child JSONL FD", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => ["/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume=${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.status("agent-alpha")).resolves.toMatchObject({
    state: "open",
    currentSessionFile: sessionFile,
  });
});

test("waits for an exact resume argv when only a child JSONL FD is open", async () => {
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => ["/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume=${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: { snapshot: { focused_pane_id: "w1:p1", panes: [{ pane_id: "w1:p1" }] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: { process_info: { shell_pid: 971679, foreground_processes: [{ pid: 99 }] } },
    }),
  });
  const control = createHerdrControl({ runner, processFiles, sessionRoot: "/sessions", pollIntervalMs: 1 });

  await expect(control.waitForMappedPid("agent-alpha", sessionFile, 100)).resolves.toBe(99);
});

test("rejects a mapping whose Herdr name differs from its storage name", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  await Bun.write(mappingStore.path("agent-alpha"), JSON.stringify({ ...mapping(), herdrSession: "agent-beta" }));

  expect(() => mappingStore.read("agent-alpha")).toThrow("mapping Herdr session");
});

test("status reports a missing mapped transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/missing.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => null,
    processCommand: async () => "",
    processCwd: async () => "/tmp",
    isAlive: () => false,
    fileMetadata: async () => { throw new Error("ENOENT: missing transcript"); },
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.status("agent-alpha")).resolves.toMatchObject({
    state: "missing",
    sessionExists: true,
    error: "mapped session file is unavailable",
  });
});

test("status keeps Herdr existence true when only the mapped pane is gone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/missing.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles: ProcessFiles = {
    findPrimarySessionFiles: async () => [],
    resumeSessionFile: async () => null,
    readProcessStartTime: async () => null,
    processCommand: async () => "",
    processCwd: async () => "/tmp",
    isAlive: () => false,
    fileMetadata: async () => { throw new Error("ENOENT: missing transcript"); },
  };
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => { throw new Error("pane_not_found: w1:p1"); },
    listPanes: async () => { throw new Error("pane_not_found: w1:p1"); },
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.status("agent-alpha")).resolves.toMatchObject({
    state: "missing",
    sessionExists: true,
    error: "mapped session file is unavailable",
  });
});

test("bind prefers exact resume argv when the main JSONL FD is closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => ["/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume\u0000${sessionFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  await expect(workflow.bind("agent-alpha")).resolves.toMatchObject({
    sessionFile,
    ompPid: 99,
  });
});

test("rejects an out-of-root resume argv instead of using a child FD", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deathstar-recovery-"));
  tempDirectories.push(directory);
  const mappingStore = createMappingStore({ directory });
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  mappingStore.write({ ...mapping(), sessionFile, sessionRoot: "/sessions" });
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => ["/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? "bun\u0000/synthetic/bin/omp\u0000--resume=/tmp/outside.jsonl\u0000"
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const herdrControl: HerdrControl = {
    sessionSnapshot: async () => ({}),
    currentPane: async () => ({ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }),
    listPanes: async () => [{ paneId: "w1:p1", shellPid: 971679, foregroundPids: [99] }],
    sendExitKey: async () => {},
    runInPane: async () => {},
    stopSession: async () => {},
    ensureSession: async () => {},
    waitForPidExit: async () => {},
    waitForMappedPid: async () => 99,
    attach: async () => 0,
  };
  const workflow = createRecoveryWorkflow({ mappingStore, processFiles, herdrControl, sessionRoot: "/sessions", isTTY: false });

  const status = await workflow.status("agent-alpha");
  expect(status.state).toBe("closed");
  expect(status.error).toContain("invalid --resume JSONL path");
});

test("waitForMappedPid propagates an invalid resume argv", async () => {
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => ["/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? "bun\u0000/synthetic/bin/omp\u0000--resume=/tmp/outside.jsonl\u0000"
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: { snapshot: { focused_pane_id: "w1:p1", panes: [{ pane_id: "w1:p1" }] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: { process_info: { shell_pid: 971679, foreground_processes: [{ pid: 99 }] } },
    }),
  });
  const control = createHerdrControl({ runner, processFiles, sessionRoot: "/sessions", pollIntervalMs: 1 });

  await expect(control.waitForMappedPid("agent-alpha", sessionFile, 100)).rejects.toThrow("invalid --resume JSONL path");
});

test("waitForMappedPid rejects a different explicit resume path", async () => {
  const sessionFile = "/sessions/-tmp/exact.jsonl";
  const otherFile = "/sessions/-tmp/other.jsonl";
  const processFiles = createProcessFiles({
    sessionRoot: "/sessions",
    readFdLinks: async () => ["/sessions/-tmp/SurveyFunnel.jsonl"],
    readProcText: async (path) => path.endsWith("/cmdline")
      ? `bun\u0000/synthetic/bin/omp\u0000--resume=${otherFile}\u0000`
      : "",
    stat: async () => ({ size: 10, mtimeMs: 20 }),
    readlink: async () => "/tmp",
    isAlive: () => true,
  });
  const runner = new RecoveryCommandRunner({
    "herdr --session agent-alpha api snapshot": recoveryResult({
      result: { snapshot: { focused_pane_id: "w1:p1", panes: [{ pane_id: "w1:p1" }] } },
    }),
    "herdr --session agent-alpha pane process-info --pane w1:p1": recoveryResult({
      result: { process_info: { shell_pid: 971679, foreground_processes: [{ pid: 99 }] } },
    }),
  });
  const control = createHerdrControl({ runner, processFiles, sessionRoot: "/sessions", pollIntervalMs: 1 });

  await expect(control.waitForMappedPid("agent-alpha", sessionFile, 100)).rejects.toThrow("different --resume path");
});
