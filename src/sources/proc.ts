import { readdir, readlink } from "node:fs/promises";
import { statfsSync } from "node:fs";
import type { HealthState, HostSnapshot, MemoryPressure, PressureWindow, ProcessSnapshot } from "../types.ts";

export interface FileReader {
  read(path: string): Promise<string>;
}

export interface FilesystemStats {
  blockSize: number;
  blocks: number;
  availableBlocks: number;
}
export interface CgroupSnapshot {
  path: string;
  currentBytes: number;
  peakBytes: number | null;
  oomKillCount: number;
}

export interface ProcSourceOptions {
  reader?: FileReader;
  procRoot?: string;
  cgroupRoot?: string;
  cgroupFsRoot?: string;
  statfs?: (path: string) => Promise<FilesystemStats>;
  listPids?: () => Promise<number[]>;
  readlink?: (path: string) => Promise<string>;
  warningAvailableBytes?: number;
  criticalAvailableBytes?: number;
  warningSwapRatio?: number;
}

export interface ProcSource {
  readHost(): Promise<HostSnapshot>;
  readProcess(pid: number): Promise<ProcessSnapshot | null>;
  listOmpPids(): Promise<number[]>;
  readProcessCgroup(pid: number): Promise<CgroupSnapshot | null>;
  listPidsInCgroup(path: string): Promise<number[]>;
}

class DefaultFileReader implements FileReader {
  async read(path: string): Promise<string> {
    return Bun.file(path).text();
  }
}

function parseKilobytes(value: string, name: string): number {
  const match = value.match(/^\s*([0-9]+)(?:\s+kB)?\s*$/);
  if (!match) throw new Error(`${name} is malformed`);
  return Number(match[1]) * 1024;
}

function parseMeminfo(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`meminfo line is malformed: ${line}`);
    const name = line.slice(0, separator);
    values[name] = parseKilobytes(line.slice(separator + 1), name);
  }
  return values;
}

function requiredValue(values: Record<string, number>, name: string): number {
  const value = values[name];
  if (value === undefined) throw new Error(`${name} is missing`);
  return value;
}

function parseSwapUsage(text: string, meminfo: Record<string, number>): { total: number; used: number } {
  const lines = text.trim().split("\n").filter(Boolean);
  let used = 0;
  let total = 0;
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) throw new Error(`swaps line is malformed: ${line}`);
    total += Number(columns[2]) * 1024;
    used += Number(columns[3]) * 1024;
  }
  if (lines.length <= 1) {
    total = requiredValue(meminfo, "SwapTotal");
    used = total - requiredValue(meminfo, "SwapFree");
  }
  if (!Number.isFinite(total) || !Number.isFinite(used)) throw new Error("swap values are malformed");
  return { total, used };
}

function parseLoadavg(text: string): [number, number, number] {
  const values = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("loadavg is malformed");
  }
  return [values[0]!, values[1]!, values[2]!];
}

function parseCgroupEvents(text: string): number {
  for (const line of text.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === "oom_kill") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error("oom_kill is malformed");
      return parsed;
    }
  }
  throw new Error("oom_kill is missing");
}
function parsePressureWindow(text: string, name: string): PressureWindow {
  const values: Record<string, number> = {};
  for (const token of text.trim().split(/\s+/).slice(1)) {
    const [key, rawValue] = token.split("=");
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value)) throw new Error(`${name} pressure is malformed`);
    values[key] = value;
  }
  for (const key of ["avg10", "avg60", "avg300", "total"]) {
    if (values[key] === undefined) throw new Error(`${name} pressure is missing ${key}`);
  }
  return {
    avg10: values.avg10!,
    avg60: values.avg60!,
    avg300: values.avg300!,
    total: values.total!,
  };
}

function parseMemoryPressure(text: string): MemoryPressure {
  const lines = text.split("\n").filter(Boolean);
  const someLine = lines.find((line) => line.startsWith("some "));
  const fullLine = lines.find((line) => line.startsWith("full "));
  if (!someLine || !fullLine) throw new Error("memory pressure sections are missing");
  return {
    some: parsePressureWindow(someLine, "some"),
    full: parsePressureWindow(fullLine, "full"),
  };
}

function parseCgroupLimit(text: string): number | null {
  const value = text.trim();
  if (value === "max") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("memory.max is malformed");
  return parsed;
}

function parseStatus(text: string): { ppid: number | null; rssBytes: number; virtualBytes: number; state: string | null } {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  const ppid = values.PPid === undefined ? null : Number(values.PPid);
  const rssBytes = parseKilobytes(values.VmRSS || "", "VmRSS");
  const virtualBytes = parseKilobytes(values.VmSize || "", "VmSize");
  if (ppid !== null && !Number.isFinite(ppid)) throw new Error("PPid is malformed");
  return {
    ppid,
    rssBytes,
    virtualBytes,
    state: values.State || null,
  };
}
function parseBootTime(text: string): number {
  const line = text.split("\n").find((candidate) => candidate.startsWith("btime "));
  const value = Number(line?.split(/\s+/)[1]);
  if (!Number.isFinite(value)) throw new Error("btime is malformed");
  return value;
}

function parseProcessStartedAt(statText: string, bootText: string): string {
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) throw new Error("process stat is malformed");
  const fieldsAfterCommand = statText.slice(closeParen + 1).trim().split(/\s+/);
  const startTimeTicks = Number(fieldsAfterCommand[19]);
  if (!Number.isFinite(startTimeTicks)) throw new Error("process start time is malformed");
  return new Date((parseBootTime(bootText) + startTimeTicks / 100) * 1000).toISOString();
}

function determineState(
  availableBytes: number,
  swapTotalBytes: number,
  swapUsedBytes: number,
  warningAvailableBytes: number,
  criticalAvailableBytes: number,
  warningSwapRatio: number,
): HealthState {
  if (availableBytes <= criticalAvailableBytes) return "critical";
  const swapRatio = swapTotalBytes === 0 ? 0 : swapUsedBytes / swapTotalBytes;
  if (availableBytes <= warningAvailableBytes || swapRatio >= warningSwapRatio) return "warning";
  return "ok";
}

async function defaultStatfs(path: string): Promise<FilesystemStats> {
  const stats = statfsSync(path);
  return {
    blockSize: Number(stats.bsize),
    blocks: Number(stats.blocks),
    availableBlocks: Number(stats.bavail),
  };
}

async function defaultListPids(procRoot: string): Promise<number[]> {
  const entries = await readdir(procRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));
}

function filesystemUsage(stats: FilesystemStats): { totalBytes: number; usedBytes: number } {
  const totalBytes = stats.blockSize * stats.blocks;
  const availableBytes = stats.blockSize * stats.availableBlocks;
  return { totalBytes, usedBytes: totalBytes - availableBytes };
}

export function createProcSource(options: ProcSourceOptions = {}): ProcSource {
  const reader = options.reader || new DefaultFileReader();
  const procRoot = options.procRoot || "/proc";
  const cgroupRoot = options.cgroupRoot || "/sys/fs/cgroup/user.slice/user-1000.slice";
  const statfs = options.statfs || defaultStatfs;
  const listPids = options.listPids || (() => defaultListPids(procRoot));
  const readlinkFn = options.readlink || ((path: string) => Promise.resolve(readlink(path, "utf8")));
  const warningAvailableBytes = options.warningAvailableBytes ?? 4 * 1024 ** 3;
  const criticalAvailableBytes = options.criticalAvailableBytes ?? 2 * 1024 ** 3;
  const warningSwapRatio = options.warningSwapRatio ?? 0.5;
  const cgroupFsRoot = options.cgroupFsRoot || "/sys/fs/cgroup";
  const readCgroup = async (path: string): Promise<CgroupSnapshot> => {
    const absolutePath = `${cgroupFsRoot}${path}`;
    const [currentText, peakText, eventsText] = await Promise.all([
      reader.read(`${absolutePath}/memory.current`),
      reader.read(`${absolutePath}/memory.peak`).catch(() => null),
      reader.read(`${absolutePath}/memory.events`),
    ]);
    const currentBytes = Number(currentText.trim());
    const peakBytes = peakText === null ? null : Number(peakText.trim());
    if (!Number.isFinite(currentBytes) || currentBytes < 0) throw new Error(`cgroup current is malformed: ${path}`);
    if (peakBytes !== null && (!Number.isFinite(peakBytes) || peakBytes < 0)) throw new Error(`cgroup peak is malformed: ${path}`);
    return {
      path,
      currentBytes,
      peakBytes,
      oomKillCount: parseCgroupEvents(eventsText),
    };
  };

  return {
    async readHost() {
      const [meminfoText, swapsText, loadavgText, pressureText, cgroupCurrentText, cgroupLimitText, cgroupEventsText, rootFs, tmpFs] = await Promise.all([
        reader.read(`${procRoot}/meminfo`),
        reader.read(`${procRoot}/swaps`),
        reader.read(`${procRoot}/loadavg`),
        reader.read(`${procRoot}/pressure/memory`),
        reader.read(`${cgroupRoot}/memory.current`),
        reader.read(`${cgroupRoot}/memory.max`),
        reader.read(`${cgroupRoot}/memory.events`),
        statfs("/"),
        statfs("/tmp"),
      ]);
      const meminfo = parseMeminfo(meminfoText);
      const swap = parseSwapUsage(swapsText, meminfo);
      const [load1, load5, load15] = parseLoadavg(loadavgText);
      const memoryPressure = parseMemoryPressure(pressureText);
      const totalBytes = requiredValue(meminfo, "MemTotal");
      const availableBytes = requiredValue(meminfo, "MemAvailable");
      const freeBytes = requiredValue(meminfo, "MemFree");
      const cacheBytes = requiredValue(meminfo, "Cached");
      const cgroupCurrentBytes = Number(cgroupCurrentText.trim());
      if (!Number.isFinite(cgroupCurrentBytes) || cgroupCurrentBytes < 0) throw new Error("memory.current is malformed");
      const observedAt = new Date().toISOString();
      return {
        observedAt,
        totalBytes,
        usedBytes: totalBytes - availableBytes,
        availableBytes,
        freeBytes,
        cacheBytes,
        swapTotalBytes: swap.total,
        swapUsedBytes: swap.used,
        load1,
        load5,
        load15,
        rootUsedBytes: filesystemUsage(rootFs).usedBytes,
        rootTotalBytes: filesystemUsage(rootFs).totalBytes,
        tmpUsedBytes: filesystemUsage(tmpFs).usedBytes,
        tmpTotalBytes: filesystemUsage(tmpFs).totalBytes,
        cgroupCurrentBytes,
        cgroupLimitBytes: parseCgroupLimit(cgroupLimitText),
        oomKillCount: parseCgroupEvents(cgroupEventsText),
        memoryPressure,
        state: determineState(availableBytes, swap.total, swap.used, warningAvailableBytes, criticalAvailableBytes, warningSwapRatio),
        errors: [],
      };
    },

    async readProcess(pid) {
      try {
        const [statusText, cmdline, statText, bootText, cwd] = await Promise.all([
          reader.read(`${procRoot}/${pid}/status`),
          reader.read(`${procRoot}/${pid}/cmdline`),
          reader.read(`${procRoot}/${pid}/stat`),
          reader.read(`${procRoot}/stat`),
          readlinkFn(`${procRoot}/${pid}/cwd`).catch(() => null),
        ]);
        const status = parseStatus(statusText);
        return {
          pid,
          ppid: status.ppid,
          command: cmdline.replaceAll("\0", " ").trim(),
          cwd,
          rssBytes: status.rssBytes,
          virtualBytes: status.virtualBytes,
          state: status.state,
          startedAt: parseProcessStartedAt(statText, bootText),
        };
      } catch (error) {
        if (error instanceof Error && /ENOENT|missing fixture/.test(error.message)) return null;
        throw error;
      }
    },
    async readProcessCgroup(pid) {
      try {
        const text = await reader.read(`${procRoot}/${pid}/cgroup`);
        const line = text.split("\n").find((candidate) => candidate.includes("::"));
        if (!line) return null;
        const separator = line.indexOf("::");
        const path = line.slice(separator + 2).trim();
        if (!path) return null;
        return await readCgroup(path);
      } catch (error) {
        if (error instanceof Error && /ENOENT|missing fixture/.test(error.message)) return null;
        throw error;
      }
    },

    async listPidsInCgroup(path) {
      const text = await reader.read(`${cgroupFsRoot}${path}/cgroup.procs`);
      return text.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
    },

    async listOmpPids() {
      const pids = await listPids();
      const matches: number[] = [];
      for (const pid of pids) {
        try {
          const command = (await reader.read(`${procRoot}/${pid}/cmdline`)).replaceAll("\0", " ").trim();
          if (command.split(/\s+/).some((part) => part === "omp" || part.endsWith("/omp"))) matches.push(pid);
        } catch (error) {
          if (!(error instanceof Error && /ENOENT|missing fixture/.test(error.message))) throw error;
        }
      }
      return matches.sort((left, right) => left - right);
    },
  };
}
