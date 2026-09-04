import { statfsSync } from "node:fs";

const GIB = 1024 ** 3;
const SWAP_DEVICE_PATTERN = /^\/swapfile(?:\.part[0-9]+)?$/;

export interface MemoryMetrics {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  tmpUsedBytes: number;
  tmpTotalBytes: number;
}

export type CleanupAction = "done" | "skipped" | "failed";

export interface CleanupResult {
  version: 1;
  status: "ok" | "partial" | "failed";
  actions: {
    dropCaches: CleanupAction;
    swapCycle: CleanupAction;
  };
  skipReason?: string;
  error?: string;
  before: MemoryMetrics;
  after: MemoryMetrics;
  reclaimed: {
    availableBytes: number;
    swapBytes: number;
    tmpBytes: number;
  };
  durationMs: number;
  completedAt: string;
}

export interface MemoryHelperDependencies {
  readMeminfo: () => Promise<string>;
  readSwaps: () => Promise<string>;
  writeDropCaches: () => Promise<void>;
  runCommand: (args: string[]) => Promise<void>;
  readTmpUsage: () => Promise<{ usedBytes: number; totalBytes: number }>;
  now: () => Date;
}

export function computeSwapGuard(metrics: Pick<MemoryMetrics, "totalBytes" | "availableBytes" | "swapUsedBytes">): {
  allowed: boolean;
  requiredAvailableBytes: number;
} {
  const marginBytes = Math.ceil(Math.max(GIB, metrics.totalBytes * 0.1));
  const requiredAvailableBytes = metrics.swapUsedBytes + marginBytes;
  return {
    allowed: metrics.availableBytes >= requiredAvailableBytes,
    requiredAvailableBytes,
  };
}

function parseMeminfo(content: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of content.split("\n")) {
    const match = /^(\w+):\s+(\d+)(?:\s+(kB))?$/.exec(line.trim());
    if (!match) continue;
    values[match[1]!] = Number(match[2]) * (match[3] === "kB" ? 1024 : 1);
  }
  return values;
}

function requiredMeminfo(values: Record<string, number>, key: string): number {
  const value = values[key];
  if (!Number.isFinite(value)) throw new Error(`missing /proc/meminfo field ${key}`);
  return value;
}

interface SwapDevice {
  path: string;
  sizeBytes: number;
  usedBytes: number;
}

function parseSwapDevices(content: string): SwapDevice[] {
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.slice(1).map((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) throw new Error(`swaps line is malformed: ${line}`);
    const sizeBytes = Number(columns[2]) * 1024;
    const usedBytes = Number(columns[3]) * 1024;
    if (!Number.isFinite(sizeBytes) || !Number.isFinite(usedBytes) || sizeBytes < 0 || usedBytes < 0) {
      throw new Error(`swaps values are malformed: ${line}`);
    }
    return { path: columns[0]!, sizeBytes, usedBytes };
  });
}

async function collectMetrics(dependencies: MemoryHelperDependencies): Promise<MemoryMetrics> {
  const values = parseMeminfo(await dependencies.readMeminfo());
  const tmp = await dependencies.readTmpUsage();
  const swapTotalBytes = requiredMeminfo(values, "SwapTotal");
  const swapFreeBytes = requiredMeminfo(values, "SwapFree");
  return {
    totalBytes: requiredMeminfo(values, "MemTotal"),
    availableBytes: requiredMeminfo(values, "MemAvailable"),
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
    tmpUsedBytes: tmp.usedBytes,
    tmpTotalBytes: tmp.totalBytes,
  };
}

function result(
  status: CleanupResult["status"],
  actions: CleanupResult["actions"],
  before: MemoryMetrics,
  after: MemoryMetrics,
  startedAt: number,
  now: Date,
  details: Pick<CleanupResult, "skipReason" | "error"> = {},
): CleanupResult {
  return {
    version: 1,
    status,
    actions,
    ...details,
    before,
    after,
    reclaimed: {
      availableBytes: after.availableBytes - before.availableBytes,
      swapBytes: before.swapUsedBytes - after.swapUsedBytes,
      tmpBytes: before.tmpUsedBytes - after.tmpUsedBytes,
    },
    durationMs: Math.max(0, now.getTime() - startedAt),
    completedAt: now.toISOString(),
  };
}

export async function runMemoryCleanup(dependencies: MemoryHelperDependencies): Promise<CleanupResult> {
  const startedAt = dependencies.now().getTime();
  const before = await collectMetrics(dependencies);
  let dropCaches: CleanupAction = "done";

  try {
    await dependencies.runCommand(["/usr/bin/sync"]);
    await dependencies.writeDropCaches();
  } catch (error) {
    const after = await collectMetrics(dependencies);
    return result("failed", { dropCaches: "failed", swapCycle: "skipped" }, before, after, startedAt, dependencies.now(), {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let swapCycle: CleanupAction = "skipped";
  let skipReason: string | undefined;
  if (before.swapUsedBytes === 0) {
    skipReason = "no-swap-used";
  } else {
    const swaps = await dependencies.readSwaps();
    const swapDevices = swaps.trim()
      ? parseSwapDevices(swaps).filter((device) => SWAP_DEVICE_PATTERN.test(device.path))
      : [];
    if (swapDevices.length === 0) {
      skipReason = "swapfile-not-active";
    } else {
      let cycledChunk = false;
      let skippedChunk = false;
      for (const device of swapDevices) {
        if (device.usedBytes === 0) continue;
        const current = await collectMetrics(dependencies);
        const guard = computeSwapGuard({ ...current, swapUsedBytes: device.usedBytes });
        if (!guard.allowed) {
          skippedChunk = true;
          continue;
        }
        try {
          await dependencies.runCommand(["/usr/sbin/swapoff", device.path]);
          await dependencies.runCommand(["/usr/sbin/swapon", device.path]);
          cycledChunk = true;
        } catch (error) {
          const after = await collectMetrics(dependencies);
          return result("failed", { dropCaches, swapCycle: "failed" }, before, after, startedAt, dependencies.now(), {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      swapCycle = cycledChunk ? "done" : "skipped";
      if (skippedChunk) skipReason = "insufficient-memory";
      else if (!cycledChunk) skipReason = "no-managed-swap-used";
    }
  }

  const after = await collectMetrics(dependencies);
  return result(skipReason ? "partial" : "ok", { dropCaches, swapCycle }, before, after, startedAt, dependencies.now(), { skipReason });
}

async function runFixedCommand(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${args[0]} exited ${exitCode}: ${stderr.trim()}`);
}

function realDependencies(): MemoryHelperDependencies {
  return {
    readMeminfo: () => Bun.file("/proc/meminfo").text(),
    readSwaps: () => Bun.file("/proc/swaps").text(),
    writeDropCaches: () => Bun.write("/proc/sys/vm/drop_caches", "3\n").then(() => undefined),
    runCommand: runFixedCommand,
    readTmpUsage: async () => {
      const stats = statfsSync("/tmp");
      const totalBytes = stats.blocks * stats.bsize;
      return { totalBytes, usedBytes: totalBytes - stats.bfree * stats.bsize };
    },
    now: () => new Date(),
  };
}
export function hasNoUserArguments(argv: string[] = Bun.argv): boolean {
  const userArgumentStart = argv[0] === "bun" || argv[0]?.endsWith("/bun") ? 2 : 1;
  return argv.slice(userArgumentStart).length === 0;
}

if (import.meta.main) {
  if (!hasNoUserArguments()) {
    console.error("arguments are not accepted");
    process.exit(64);
  }
  try {
    const cleanup = await runMemoryCleanup(realDependencies());
    console.log(JSON.stringify(cleanup));
    process.exit(cleanup.status === "failed" ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
