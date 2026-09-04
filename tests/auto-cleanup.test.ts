import { expect, test } from "bun:test";
import type { CleanupResult } from "../src/memory-helper.ts";
import {
  createAutomaticCleanupController,
  type AutomaticCleanupController,
} from "../src/auto-cleanup.ts";
import type { MaintenanceProbe, MaintenanceStatus } from "../src/maintenance.ts";
import type { HealthSnapshot, HostSnapshot } from "../src/types.ts";

const cleanupResult: CleanupResult = {
  version: 1,
  status: "ok",
  actions: { dropCaches: "done", swapCycle: "done" },
  before: { totalBytes: 100, availableBytes: 80, swapTotalBytes: 40, swapUsedBytes: 20, tmpUsedBytes: 50, tmpTotalBytes: 100 },
  after: { totalBytes: 100, availableBytes: 90, swapTotalBytes: 40, swapUsedBytes: 0, tmpUsedBytes: 50, tmpTotalBytes: 100 },
  reclaimed: { availableBytes: 10, swapBytes: 20, tmpBytes: 0 },
  durationMs: 10,
  completedAt: "2026-08-27T00:00:00.000Z",
};

function snapshot(state: HostSnapshot["state"], observedAt: string): HealthSnapshot {
  return {
    observedAt,
    host: { state } as unknown as HealthSnapshot["host"],
    sessions: [],
    ompCount: 0,
    herdrSessionCount: 0,
    collectorErrors: [],
  };
}

function readyStatus(ready: boolean): MaintenanceStatus {
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
    autoCleanupMode: "cache",
    remediation: ready ? null : "Run installer",
    lastCleanup: null,
  };
}

function controllerFixture(ready: boolean, mode: "off" | "cache" = "cache"): {
  controller: AutomaticCleanupController;
  calls: number;
} {
  let calls = 0;
  const probe: MaintenanceProbe = { read: async () => readyStatus(ready) };
  const controller = createAutomaticCleanupController({
    mode,
    criticalConfirmSamples: 2,
    cooldownMs: 600000,
    now: () => 1000,
    probe,
    cleaner: { run: async () => { calls += 1; return cleanupResult; } },
  });
  return { controller, get calls() { return calls; } };
}

test("keeps automatic cleanup disabled in off mode", async () => {
  const fixture = controllerFixture(true, "off");
  const events = await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:00.000Z"));

  expect(events).toEqual([]);
  expect(fixture.calls).toBe(0);
});

test("runs cache cleanup once after critical confirmation and cooldown", async () => {
  const fixture = controllerFixture(true);
  expect(await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:00.000Z"))).toEqual([]);
  expect((await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:05.000Z")))[0]).toMatchObject({
    kind: "cleanup-auto",
    severity: "info",
  });
  expect(await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:10.000Z"))).toEqual([]);
  expect(fixture.calls).toBe(1);
});

test("records unavailable capability once without invoking cleaner", async () => {
  const fixture = controllerFixture(false);
  const first = await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:00.000Z"));
  const second = await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:05.000Z"));

  expect(first).toEqual([]);
  expect(second).toContainEqual(expect.objectContaining({ kind: "cleanup-unavailable", severity: "warning" }));
  expect(await fixture.controller.observe(snapshot("critical", "2026-08-27T00:00:10.000Z"))).toEqual([]);
  expect(fixture.calls).toBe(0);
});

test("records failed automatic cleanup as critical", async () => {
  let calls = 0;
  const controller = createAutomaticCleanupController({
    mode: "cache",
    criticalConfirmSamples: 1,
    cooldownMs: 0,
    now: () => 1000,
    probe: { read: async () => readyStatus(true) },
    cleaner: {
      run: async () => {
        calls += 1;
        return { ...cleanupResult, status: "failed" };
      },
    },
  });

  const events = await controller.observe(snapshot("critical", "2026-08-27T00:00:00.000Z"));

  expect(events).toContainEqual(expect.objectContaining({ kind: "cleanup-auto", severity: "critical" }));
  expect(calls).toBe(1);
});
