import type { CommandRunner } from "../command.ts";
import type { ProcessFiles } from "./process-files.ts";

import { ompSessionRoot } from "../paths.ts";
export interface HerdrPane {
  paneId: string;
  shellPid: number;
  foregroundPids: number[];
}

export interface HerdrControlOptions {
  runner: CommandRunner;
  processFiles: ProcessFiles;
  herdrBinary?: string;
  sessionRoot?: string;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  startServer?: (name: string) => Promise<void>;
}

export interface HerdrControl {
  sessionSnapshot(name: string): Promise<unknown>;
  currentPane(name: string, paneId?: string): Promise<HerdrPane>;
  sendExitKey(name: string, paneId: string): Promise<void>;
  runInPane(name: string, paneId: string, command: string, args: string[]): Promise<void>;
  stopSession(name: string): Promise<void>;
  ensureSession(name: string): Promise<void>;
  waitForPidExit(pid: number, startTime: string | null, timeoutMs: number): Promise<void>;
  waitForMappedPid(name: string, sessionFile: string, timeoutMs: number, paneId?: string): Promise<number>;
  listPanes(name: string): Promise<HerdrPane[]>;
  attach(name: string): Promise<number>;
}

function commandError(label: string, result: { exitCode: number; stderr: string }): Error {
  return new Error(`${label} failed with exit ${result.exitCode}: ${result.stderr.trim()}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} has invalid JSON shape`);
  return value as Record<string, unknown>;
}

function asJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createHerdrControl(options: HerdrControlOptions): HerdrControl {
  const herdrBinary = options.herdrBinary || "herdr";
  const commandTimeoutMs = options.commandTimeoutMs || 3000;
  const pollIntervalMs = options.pollIntervalMs || 100;
  const sessionRoot = options.sessionRoot || process.env.DEATHSTAR_SESSION_ROOT || ompSessionRoot();
  const startServer = options.startServer || (async (name: string) => {
    Bun.spawn([herdrBinary, "--session", name, "server"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    await Bun.sleep(100);
  });

  async function run(args: string[], label: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await options.runner.run([herdrBinary, ...args], commandTimeoutMs);
    if (result.exitCode !== 0) throw commandError(label, result);
    return result;
  }

  async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await Bun.sleep(pollIntervalMs);
    }
    throw new Error(message);
  }

  return {
    async sessionSnapshot(name) {
      const result = await run(["--session", name, "api", "snapshot"], `Herdr snapshot ${name}`);
      return asJson(result.stdout, `Herdr snapshot ${name}`);
    },

    async currentPane(name, requestedPaneId) {
      let paneId: string | null = null;
      let processInfo: Record<string, unknown> | null = null;
      await waitUntil(async () => {
        try {
          const response = asRecord(await this.sessionSnapshot(name), `Herdr snapshot ${name}`);
          const snapshotResult = asRecord(response.result, `Herdr snapshot ${name}`);
          const snapshot = asRecord(snapshotResult.snapshot, `Herdr snapshot ${name}`);
          const panes = Array.isArray(snapshot.panes) ? snapshot.panes.filter((pane): pane is Record<string, unknown> => Boolean(pane) && typeof pane === "object") : [];
          const focusedPaneId = typeof snapshot.focused_pane_id === "string" ? snapshot.focused_pane_id : null;
          const candidatePaneId = requestedPaneId || focusedPaneId || (typeof panes[0]?.pane_id === "string" ? panes[0].pane_id : null);
          if (!candidatePaneId) return false;
          const processCommandResult = await run(["--session", name, "pane", "process-info", "--pane", candidatePaneId], `Herdr process info ${name}`);
          paneId = candidatePaneId;
          const processResponse = asRecord(asJson(processCommandResult.stdout, `Herdr process info ${name}`), `Herdr process info ${name}`);
          const processResult = asRecord(processResponse.result, `Herdr process info ${name}`);
          processInfo = asRecord(processResult.process_info, `Herdr process info ${name}`);
          return true;
        } catch (error) {
          if (error instanceof Error && error.message.includes("pane_not_found")) return false;
          throw error;
        }
      }, 5000, `Herdr session ${name} pane did not become ready`);
      const info = processInfo!;
      const foreground = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
      const foregroundPids = foreground
        .filter((process): process is Record<string, unknown> => Boolean(process) && typeof process === "object")
        .map((process) => process.pid)
        .filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid));
      const shellPid = info.shell_pid;
      if (typeof shellPid !== "number" || !Number.isInteger(shellPid)) throw new Error(`Herdr session ${name} has no shell PID`);
      return { paneId: paneId!, shellPid, foregroundPids };
    },

    async listPanes(name) {
      const response = asRecord(await this.sessionSnapshot(name), `Herdr snapshot ${name}`);
      const snapshotResult = asRecord(response.result, `Herdr snapshot ${name}`);
      const snapshot = asRecord(snapshotResult.snapshot, `Herdr snapshot ${name}`);
      const panes = Array.isArray(snapshot.panes) ? snapshot.panes.filter((pane): pane is Record<string, unknown> => Boolean(pane) && typeof pane === "object") : [];
      const focusedPaneId = typeof snapshot.focused_pane_id === "string" ? snapshot.focused_pane_id : null;
      const paneIds = [...new Set([
        ...panes.map((pane) => typeof pane.pane_id === "string" ? pane.pane_id : null),
        focusedPaneId,
      ].filter((paneId): paneId is string => paneId !== null))];
      if (paneIds.length === 0) throw new Error(`Herdr session ${name} has no panes`);
      return Promise.all(paneIds.map((paneId) => this.currentPane(name, paneId)));
    },

    async sendExitKey(name, paneId) {
      await run(["--session", name, "pane", "send-keys", paneId, "ctrl+d"], `send exit key ${name}`);
    },

    async runInPane(name, paneId, command, args) {
      await run(["--session", name, "pane", "run", paneId, command, ...args], `run command in ${name}`);
    },

    async stopSession(name) {
      await run(["session", "stop", name], `stop session ${name}`);
    },

    async ensureSession(name) {
      try {
        await this.sessionSnapshot(name);
      } catch {
        await startServer(name);
        await waitUntil(async () => {
          try {
            await this.sessionSnapshot(name);
            return true;
          } catch {
            return false;
          }
        }, 5000, `Herdr session ${name} did not start`);
      }
    },

    async waitForPidExit(pid, startTime, timeoutMs) {
      await waitUntil(async () => {
        if (!options.processFiles.isAlive(pid)) return true;
        if (startTime === null) return false;
        const currentStart = await options.processFiles.readProcessStartTime(pid);
        return currentStart !== null && currentStart !== startTime;
      }, timeoutMs, `OMP PID ${pid} did not exit within ${timeoutMs}ms`);
    },

    async waitForMappedPid(name, sessionFile, timeoutMs, paneId) {
      let foundPid: number | null = null;
      await waitUntil(async () => {
        const pane = await this.currentPane(name, paneId);
        for (const pid of pane.foregroundPids) {
          try {
            const resumed = await options.processFiles.resumeSessionFile(pid, sessionRoot);
            if (resumed) {
              if (resumed === sessionFile) {
                foundPid = pid;
                return true;
              }
              throw new Error(`mapped OMP has different --resume path: ${resumed}`);
            }
            const files = await options.processFiles.findPrimarySessionFiles(pid, sessionRoot, sessionFile);
            if (files.includes(sessionFile)) {
              foundPid = pid;
              return true;
            }
          } catch (error) {
            if (error instanceof Error && (error.message.startsWith("invalid --resume JSONL path") || error.message.startsWith("mapped OMP has different --resume path"))) throw error;
            if (error instanceof Error && (error.message.startsWith("no primary JSONL session file") || error.message.startsWith("ambiguous primary JSONL session files"))) {
              const resumed = await options.processFiles.resumeSessionFile(pid, sessionRoot);
              if (resumed === sessionFile) {
                foundPid = pid;
                return true;
              }
            }
          }
        }
        return false;
      }, timeoutMs, `mapped OMP ${sessionFile} did not appear in ${name}`);
      return foundPid!;
    },

    async attach(name) {
      const child = Bun.spawn([herdrBinary, "--session", name], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exited;
    },
  };
}
