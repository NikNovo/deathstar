import { expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/command.ts";
import { createMemoryCleanupController } from "../src/memory-cleanup.ts";
import type { CleanupResult } from "../src/memory-helper.ts";
import type { MaintenanceStatus } from "../src/maintenance.ts";

const result: CleanupResult = {
  version: 1,
  status: "ok",
  actions: { dropCaches: "done", swapCycle: "done" },
  before: { totalBytes: 100, availableBytes: 80, swapTotalBytes: 40, swapUsedBytes: 20, tmpUsedBytes: 50, tmpTotalBytes: 100 },
  after: { totalBytes: 100, availableBytes: 90, swapTotalBytes: 40, swapUsedBytes: 0, tmpUsedBytes: 50, tmpTotalBytes: 100 },
  reclaimed: { availableBytes: 10, swapBytes: 20, tmpBytes: 0 },
  durationMs: 10,
  completedAt: "2026-08-24T00:00:00.000Z",
};

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  response: CommandResult = { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };

  async run(args: string[], _timeoutMs: number): Promise<CommandResult> {
    this.calls.push(args);
    return this.response;
  }
}

test("invokes the fixed sudo helper without request arguments", async () => {
  const runner = new FakeRunner();
  const controller = createMemoryCleanupController({
    runner,
    helperPath: "/usr/local/libexec/deathstar-memory-clean",
    timeoutMs: 30000,
    cooldownMs: 60000,
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  });

  await expect(controller.run()).resolves.toEqual(result);
  expect(runner.calls).toEqual([["sudo", "-n", "/usr/local/libexec/deathstar-memory-clean"]]);
});

test("rejects concurrent and cooldown calls", async () => {
  const runner = new FakeRunner();
  let release: ((value: CommandResult) => void) | undefined;
  runner.run = async (args) => {
    runner.calls.push(args);
    return new Promise<CommandResult>((resolve) => { release = resolve; });
  };
  let current = new Date("2026-08-24T00:00:00.000Z");
  const controller = createMemoryCleanupController({ runner, helperPath: "/helper", timeoutMs: 30000, cooldownMs: 60000, now: () => current });

  const first = controller.run();
  await expect(controller.run()).rejects.toMatchObject({ statusCode: 409 });
  release!({ exitCode: 0, stdout: JSON.stringify(result), stderr: "" });
  await first;
  await expect(controller.run()).rejects.toMatchObject({ statusCode: 409 });
  current = new Date("2026-08-24T00:01:01.000Z");
  runner.run = FakeRunner.prototype.run.bind(runner);
  await expect(controller.run()).resolves.toEqual(result);
});

test("maps helper failures and malformed output to controlled errors", async () => {
  const runner = new FakeRunner();
  const controller = createMemoryCleanupController({ runner, helperPath: "/helper", timeoutMs: 30000, cooldownMs: 0, now: () => new Date() });

  runner.response = { exitCode: 1, stdout: "", stderr: "permission denied" };
  await expect(controller.run()).rejects.toMatchObject({ statusCode: 503 });

  runner.response = { exitCode: 0, stdout: "not-json", stderr: "" };
  await expect(controller.run()).rejects.toMatchObject({ statusCode: 500 });
});
test("exposes readiness and the last successful cleanup", async () => {
  const runner = new FakeRunner();
  const maintenance: MaintenanceStatus = {
    helperPath: "/helper",
    wrapperPresent: true,
    wrapperExecutable: true,
    wrapperRootOwned: true,
    binaryPresent: true,
    binaryExecutable: true,
    binaryRootOwned: true,
    sudoersPresent: true,
    authorization: "ready",
    ready: true,
    autoCleanupMode: "off",
    remediation: null,
    lastCleanup: null,
  };
  const controller = createMemoryCleanupController({
    runner,
    helperPath: "/helper",
    timeoutMs: 30000,
    cooldownMs: 0,
    maintenance: { read: async () => maintenance },
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  });

  await expect(controller.status()).resolves.toEqual(maintenance);
  await controller.run();
  await expect(controller.status()).resolves.toMatchObject({
    ready: true,
    lastCleanup: { status: "ok", completedAt: result.completedAt },
  });
});

test("maps non-interactive sudo failure to a stable unavailable code", async () => {
  const runner = new FakeRunner();
  runner.response = { exitCode: 1, stdout: "", stderr: "sudo: interactive authentication is required" };
  const controller = createMemoryCleanupController({
    runner,
    helperPath: "/helper",
    timeoutMs: 30000,
    cooldownMs: 0,
  });

  await expect(controller.run()).rejects.toMatchObject({
    statusCode: 503,
    code: "privileged_helper_unavailable",
  });
});
test("maps stale compiled helper argument failure to unavailable", async () => {
  const runner = new FakeRunner();
  runner.response = { exitCode: 64, stdout: "", stderr: "arguments are not accepted" };
  const controller = createMemoryCleanupController({
    runner,
    helperPath: "/helper",
    timeoutMs: 30000,
    cooldownMs: 0,
  });

  await expect(controller.run()).rejects.toMatchObject({
    statusCode: 503,
    code: "privileged_helper_unavailable",
    message: expect.stringContaining("install-memory-cleanup"),
  });
});
