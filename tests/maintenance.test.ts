import { expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/command.ts";
import {
  createMaintenanceProbe,
  type MaintenanceProbeOptions,
  type MaintenanceStatus,
} from "../src/maintenance.ts";

class StubRunner implements CommandRunner {
  calls: string[][] = [];

  constructor(private readonly response: CommandResult) {}

  async run(args: string[], _timeoutMs: number): Promise<CommandResult> {
    this.calls.push(args);
    return this.response;
  }
}

class StubStat {
  constructor(
    private readonly files: Set<string>,
    private readonly wrapperRootOwned = true,
  ) {}

  async stat(path: string): Promise<{ uid: number; mode: number }> {
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    const uid = path.endsWith(".bin") || (path === "/helper/deathstar-memory-clean" && this.wrapperRootOwned) ? 0 : 1000;
    return { uid, mode: 0o100755 };
  }
}

function probeOptions(runner: CommandRunner, files: Set<string>, wrapperRootOwned = true): MaintenanceProbeOptions {
  return {
    runner,
    helperPath: "/helper/deathstar-memory-clean",
    wrapperPath: "/helper/deathstar-memory-clean",
    binaryPath: "/helper/deathstar-memory-clean.bin",
    sudoersPath: "/sudoers/deathstar-memory-clean",
    timeoutMs: 100,
    autoCleanupMode: "off",
    statFile: (path) => new StubStat(files, wrapperRootOwned).stat(path),
  };
}

const allFiles = new Set([
  "/helper/deathstar-memory-clean",
  "/helper/deathstar-memory-clean.bin",
  "/sudoers/deathstar-memory-clean",
]);

function expectStatusShape(status: MaintenanceStatus): void {
  expect(status).toMatchObject({
    helperPath: "/helper/deathstar-memory-clean",
    wrapperPresent: true,
    wrapperExecutable: true,
    wrapperRootOwned: true,
    binaryPresent: true,
    binaryExecutable: true,
    binaryRootOwned: true,
    sudoersPresent: true,
    autoCleanupMode: "off",
  });
}

test("classifies non-interactive sudo authentication as unavailable", async () => {
  const runner = new StubRunner({ exitCode: 1, stdout: "", stderr: "sudo: interactive authentication is required" });
  const status = await createMaintenanceProbe(probeOptions(runner, allFiles)).read();

  expectStatusShape(status);
  expect(status.authorization).toBe("auth-required");
  expect(status.ready).toBe(false);
  expect(status.remediation).toContain("ops/install-memory-cleanup");
  expect(runner.calls).toEqual([["sudo", "-n", "-l", "/helper/deathstar-memory-clean"]]);
});

test("reports missing helper without attempting sudo authorization", async () => {
  const runner = new StubRunner({ exitCode: 0, stdout: "", stderr: "" });
  const status = await createMaintenanceProbe(probeOptions(runner, new Set())).read();

  expect(status.authorization).toBe("helper-missing");
  expect(status.ready).toBe(false);
  expect(runner.calls).toEqual([]);
});

test("reports a ready fixed helper authorization", async () => {
  const runner = new StubRunner({ exitCode: 0, stdout: "User dev may run the following commands...", stderr: "" });
  const status = await createMaintenanceProbe(probeOptions(runner, allFiles)).read();

  expectStatusShape(status);
  expect(status.authorization).toBe("ready");
  expect(status.ready).toBe(true);
  expect(status.remediation).toBeNull();
});

test("does not authorize a user-writable wrapper", async () => {
  const runner = new StubRunner({ exitCode: 0, stdout: "User dev may run the following commands...", stderr: "" });
  const status = await createMaintenanceProbe(probeOptions(runner, allFiles, false)).read();

  expect(status.wrapperRootOwned).toBe(false);
  expect(status.ready).toBe(false);
  expect(status.authorization).toBe("unknown");
  expect(runner.calls).toEqual([]);
});
test("uses exact sudo authorization when sudoers directory is unreadable", async () => {
  const runner = new StubRunner({ exitCode: 0, stdout: "/usr/local/libexec/deathstar-memory-clean", stderr: "" });
  const statFile = async (path: string) => {
    if (path === "/sudoers/deathstar-memory-clean") {
      throw Object.assign(new Error("EACCES: sudoers directory is not readable"), { code: "EACCES" });
    }
    return new StubStat(allFiles).stat(path);
  };
  const status = await createMaintenanceProbe({ ...probeOptions(runner, allFiles), statFile }).read();

  expect(status.sudoersPresent).toBeNull();
  expect(status.authorization).toBe("ready");
  expect(status.ready).toBe(true);
});

test("caches capability reads briefly", async () => {
  const runner = new StubRunner({ exitCode: 1, stdout: "", stderr: "sudo: interactive authentication is required" });
  const probe = createMaintenanceProbe({ ...probeOptions(runner, allFiles), now: () => 1000 });

  await probe.read();
  await probe.read();

  expect(runner.calls).toHaveLength(1);
});
