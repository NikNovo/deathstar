import { expect, test } from "bun:test";
import {
  computeSwapGuard,
  runMemoryCleanup,
  type MemoryHelperDependencies,
} from "../src/memory-helper.ts";

const baseMetrics = {
  totalBytes: 16 * 1024 ** 3,
  availableBytes: 8 * 1024 ** 3,
  swapTotalBytes: 4 * 1024 ** 3,
  swapUsedBytes: 3 * 1024 ** 3,
};

function dependencies(overrides: Partial<MemoryHelperDependencies> = {}): MemoryHelperDependencies {
  return {
    readMeminfo: async () => "MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\nSwapTotal:       4194304 kB\nSwapFree:        1048576 kB\n",
    readSwaps: async () => "Filename\tType\tSize\tUsed\tPriority\n/swapfile\tfile\t4194300\t3145728\t-1\n",
    writeDropCaches: async () => {},
    runCommand: async () => {},
    readTmpUsage: async () => ({ usedBytes: 100, totalBytes: 1000 }),
    now: () => new Date("2026-08-24T00:00:00.000Z"),
    ...overrides,
  };
}

test("computes an integer swap guard threshold", () => {
  expect(computeSwapGuard(baseMetrics)).toEqual({
    allowed: true,
    requiredAvailableBytes: 3 * 1024 ** 3 + Math.ceil(16 * 1024 ** 3 * 0.1),
  });

  expect(computeSwapGuard({ ...baseMetrics, availableBytes: 3 * 1024 ** 3 }).allowed).toBe(false);
});

test("runs fixed cache and swap commands when the guard passes", async () => {
  const commands: string[][] = [];
  const result = await runMemoryCleanup(dependencies({
    runCommand: async (args) => { commands.push(args); },
  }));

  expect(commands).toEqual([
    ["/usr/bin/sync"],
    ["/usr/sbin/swapoff", "/swapfile"],
    ["/usr/sbin/swapon", "/swapfile"],
  ]);
  expect(result.status).toBe("ok");
  expect(result.actions).toEqual({ dropCaches: "done", swapCycle: "done" });
  expect(result.before.availableBytes).toBe(8 * 1024 ** 3);
  expect(result.reclaimed).toEqual({ availableBytes: 0, swapBytes: 0, tmpBytes: 0 });
});

test("skips swap commands when the guard fails", async () => {
  const commands: string[][] = [];
  const result = await runMemoryCleanup(dependencies({
    readMeminfo: async () => "MemTotal:       16777216 kB\nMemAvailable:    3145728 kB\nSwapTotal:       4194304 kB\nSwapFree:        1048576 kB\n",
    runCommand: async (args) => { commands.push(args); },
  }));

  expect(commands).toEqual([["/usr/bin/sync"]]);
  expect(result.status).toBe("partial");
  expect(result.actions).toEqual({ dropCaches: "done", swapCycle: "skipped" });
  expect(result.skipReason).toBe("insufficient-memory");
});
test("cycles managed swap chunks independently", async () => {
  const commands: string[][] = [];
  const result = await runMemoryCleanup(dependencies({
    readSwaps: async () => "Filename\tType\tSize\tUsed\tPriority\n/swapfile.part1 file 1048576 524288 -2\n/swapfile.part2 file 1048576 524288 -2\n",
    runCommand: async (args) => { commands.push(args); },
  }));

  expect(commands).toEqual([
    ["/usr/bin/sync"],
    ["/usr/sbin/swapoff", "/swapfile.part1"],
    ["/usr/sbin/swapon", "/swapfile.part1"],
    ["/usr/sbin/swapoff", "/swapfile.part2"],
    ["/usr/sbin/swapon", "/swapfile.part2"],
  ]);
  expect(result.status).toBe("ok");
  expect(result.actions.swapCycle).toBe("done");
});

test("skips only the swap chunk that fails its individual guard", async () => {
  const commands: string[][] = [];
  const result = await runMemoryCleanup(dependencies({
    readMeminfo: async () => "MemTotal:       16777216 kB\nMemAvailable:    3145728 kB\nSwapTotal:       4194304 kB\nSwapFree:        1048576 kB\n",
    readSwaps: async () => "Filename\tType\tSize\tUsed\tPriority\n/swapfile.part1 file 1048576 524288 -2\n/swapfile.part2 file 4194304 2097152 -2\n",
    runCommand: async (args) => { commands.push(args); },
  }));

  expect(commands).toEqual([
    ["/usr/bin/sync"],
    ["/usr/sbin/swapoff", "/swapfile.part1"],
    ["/usr/sbin/swapon", "/swapfile.part1"],
  ]);
  expect(result.status).toBe("partial");
  expect(result.actions.swapCycle).toBe("done");
  expect(result.skipReason).toBe("insufficient-memory");
});
