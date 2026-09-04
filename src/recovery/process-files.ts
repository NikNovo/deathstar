import { readdir, readlink, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface ProcessFileOptions {
  sessionRoot?: string;
  readFdLinks?: (pid: number) => Promise<string[]>;
  readProcText?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
  readlink?: (path: string) => Promise<string>;
  isAlive?: (pid: number) => boolean;
}

export interface ProcessFiles {
  findPrimarySessionFiles(pid: number, sessionRoot: string, expectedSessionFile?: string): Promise<string[]>;
  resumeSessionFile(pid: number, sessionRoot: string): Promise<string | null>;
  readProcessStartTime(pid: number): Promise<string | null>;
  processCommand(pid: number): Promise<string>;
  processCwd(pid: number): Promise<string | null>;
  isAlive(pid: number): boolean;
  fileMetadata(path: string): Promise<{ size: number; mtimeMs: number }>;
}

async function defaultReadFdLinks(pid: number): Promise<string[]> {
  const entries = await readdir(`/proc/${pid}/fd`);
  return Promise.all(entries.map((entry) => readlink(`/proc/${pid}/fd/${entry}`)));
}

async function defaultReadProcText(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function defaultStat(path: string): Promise<{ size: number; mtimeMs: number }> {
  const value = await stat(path);
  return { size: value.size, mtimeMs: value.mtimeMs };
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseStartTime(statText: string, bootText: string): string {
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) throw new Error("process stat is malformed");
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  const btimeLine = bootText.split("\n").find((line) => line.startsWith("btime "));
  const btime = Number(btimeLine?.split(/\s+/)[1]);
  if (!Number.isFinite(ticks) || !Number.isFinite(btime)) throw new Error("process start time is malformed");
  return new Date((btime + ticks / 100) * 1000).toISOString();
}

function isSessionFilePath(path: string, sessionRoot: string): boolean {
  if (!isAbsolute(path) || !path.endsWith(".jsonl") || basename(path) === "__advisor.jsonl") return false;
  const relativePath = relative(resolve(sessionRoot), resolve(path));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function createProcessFiles(options: ProcessFileOptions = {}): ProcessFiles {
  const readFdLinks = options.readFdLinks || defaultReadFdLinks;
  const readProcText = options.readProcText || defaultReadProcText;
  const statFile = options.stat || defaultStat;
  const readlinkFile = options.readlink || ((path: string) => readlink(path));
  const alive = options.isAlive || defaultIsAlive;

  return {
    async findPrimarySessionFiles(pid, sessionRoot, expectedSessionFile) {
      const links = await readFdLinks(pid);
      const candidates = [...new Set(links.filter((path) => isSessionFilePath(path, sessionRoot)))];
      if (candidates.length === 0) throw new Error(`no primary JSONL session file open by PID ${pid}`);
      if (expectedSessionFile && candidates.includes(expectedSessionFile)) return [expectedSessionFile];
      if (candidates.length > 1) throw new Error(`ambiguous primary JSONL session files for PID ${pid}: ${candidates.join(", ")}`);
      return candidates;
    },
    async resumeSessionFile(pid, sessionRoot) {
      const args = (await readProcText(`/proc/${pid}/cmdline`)).split("\0").filter(Boolean);
      const inline = args.find((arg) => arg.startsWith("--resume="));
      const separateIndex = args.indexOf("--resume");
      const hasResumeArg = Boolean(inline) || separateIndex >= 0;
      if (!hasResumeArg) return null;
      const candidate = inline ? inline.slice("--resume=".length) : args[separateIndex + 1];
      if (!candidate || !isSessionFilePath(candidate, sessionRoot)) {
        throw new Error(`invalid --resume JSONL path for PID ${pid}: ${candidate || "<missing>"}`);
      }
      return candidate;
    },

    async readProcessStartTime(pid) {
      try {
        const [statText, bootText] = await Promise.all([
          readProcText(`/proc/${pid}/stat`),
          readProcText("/proc/stat"),
        ]);
        return parseStartTime(statText, bootText);
      } catch {
        return null;
      }
    },

    async processCommand(pid) {
      return (await readProcText(`/proc/${pid}/cmdline`)).replaceAll("\0", " ").trim();
    },

    async processCwd(pid) {
      try {
        return await readlinkFile(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    },

    isAlive(pid) {
      return alive(pid);
    },

    fileMetadata(path) {
      return statFile(path);
    },
  };
}
