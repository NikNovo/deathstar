import { join } from "node:path";
import { createHttpServer } from "../src/http.ts";
import { publicEvent, publicSnapshot } from "../src/privacy.ts";
import type { Storage } from "../src/storage.ts";
import type { EventRecord, HealthSnapshot, HistoryResponse, UsageResponse } from "../src/types.ts";
import type { CleanupResult } from "../src/memory-helper.ts";
import {
  DEMO_OBSERVED_AT,
  createDemoEvents,
  createDemoMaintenance,
  createDemoSnapshot,
  createDemoUsage,
  type DemoState,
} from "./demo-data.ts";

class DemoStorage implements Storage {
  constructor(
    private readonly snapshot: HealthSnapshot,
    private readonly eventList: EventRecord[],
  ) {}

  insertSnapshot(): void {}
  insertEvents(): void {}
  current(): HealthSnapshot { return this.snapshot; }
  history(from: Date, to: Date): HistoryResponse {
    return { from: from.toISOString(), to: to.toISOString(), points: [] };
  }
  events(): EventRecord[] { return this.eventList; }
  prune(): void {}
  close(): void {}
}

function demoCleanupResult(): CleanupResult {
  const before = {
    totalBytes: 16 * 1024 ** 3,
    availableBytes: 1.5 * 1024 ** 3,
    swapTotalBytes: 4 * 1024 ** 3,
    swapUsedBytes: 3 * 1024 ** 3,
    tmpUsedBytes: 7 * 1024 ** 3,
    tmpTotalBytes: 16 * 1024 ** 3,
  };
  const after = {
    ...before,
    availableBytes: 3 * 1024 ** 3,
    swapUsedBytes: 2 * 1024 ** 3,
    tmpUsedBytes: 5 * 1024 ** 3,
  };
  return {
    version: 1,
    status: "ok",
    actions: { dropCaches: "done", swapCycle: "done" },
    before,
    after,
    reclaimed: { availableBytes: 1.5 * 1024 ** 3, swapBytes: 1 * 1024 ** 3, tmpBytes: 2 * 1024 ** 3 },
    durationMs: 120,
    completedAt: "2026-01-15T12:00:00.000Z",
  };
}

function demoState(value: string | undefined): DemoState {
  if (value === "pressure" || value === "unavailable") return value;
  return "healthy";
}

const state = demoState(process.env.DEATHSTAR_DEMO_STATE);
const host = process.env.DEATHSTAR_DEMO_HOST || "127.0.0.1";
const port = Number(process.env.DEATHSTAR_DEMO_PORT || 3850);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("DEATHSTAR_DEMO_PORT must be a valid TCP port");

const storage = new DemoStorage(
  publicSnapshot(createDemoSnapshot(state)),
  createDemoEvents(state).map(publicEvent),
);
const usage: Pick<{ current(): UsageResponse }, "current"> = { current: () => createDemoUsage(state) };
const maintenance = {
  status: async () => createDemoMaintenance(state),
  run: async () => demoCleanupResult(),
};
const server = createHttpServer({
  storage,
  usage,
  memoryCleanup: maintenance,
  host,
  port,
  dashboardOrigin: `http://${host}:${port}`,
  now: () => new Date(DEMO_OBSERVED_AT),
  webRoot: join(import.meta.dir, "../web"),
});

console.log(`deathstar demo (${state}) listening on http://${host}:${port}`);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`deathstar demo shutting down after ${signal}`);
  server.stop();
  storage.close();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
