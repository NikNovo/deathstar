import { expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/command.ts";
import { parseArguments } from "../src/cli.ts";
import { runDoctor } from "../src/doctor.ts";
import type { MaintenanceProbe, MaintenanceStatus } from "../src/maintenance.ts";

class StubRunner implements CommandRunner {
  calls: string[][] = [];

  constructor(private readonly response: CommandResult) {}

  async run(args: string[], _timeoutMs: number): Promise<CommandResult> {
    this.calls.push(args);
    return this.response;
  }
}

function status(ready: boolean): MaintenanceStatus {
  return {
    helperPath: "/helper",
    wrapperPresent: ready,
    wrapperExecutable: ready,
    wrapperRootOwned: ready,
    binaryPresent: ready,
    binaryExecutable: ready,
    binaryRootOwned: ready,
    sudoersPresent: ready,
    authorization: ready ? "ready" : "auth-required",
    ready,
    autoCleanupMode: "off",
    remediation: ready ? null : "Run ops/install-memory-cleanup from an interactive terminal.",
    lastCleanup: null,
  };
}

function probe(value: MaintenanceStatus): MaintenanceProbe {
  return { read: async () => value };
}

test("parses the doctor command and strict json option", () => {
  expect(parseArguments(["doctor"])).toEqual({ command: "doctor", json: false });
  expect(parseArguments(["doctor", "--json"])).toEqual({ command: "doctor", json: true });
  expect(() => parseArguments(["doctor", "--nope"])).toThrow();
});

test("doctor reports a healthy service and endpoint", async () => {
  const runner = new StubRunner({ exitCode: 0, stdout: "active\n", stderr: "" });
  const result = await runDoctor({
    probe: probe(status(true)),
    runner,
    timeoutMs: 100,
    checkHealth: async () => true,
  });

  expect(result).toMatchObject({ ok: true, serviceActive: true, endpointReachable: true });
  expect(runner.calls).toEqual([["systemctl", "--user", "is-active", "deathstar.service"]]);
});

test("doctor reports unavailable cleanup without invoking the helper", async () => {
  const runner = new StubRunner({ exitCode: 0, stdout: "active\n", stderr: "" });
  const result = await runDoctor({
    probe: probe(status(false)),
    runner,
    timeoutMs: 100,
    checkHealth: async () => true,
  });

  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("install-memory-cleanup");
  expect(runner.calls).toEqual([["systemctl", "--user", "is-active", "deathstar.service"]]);
});
