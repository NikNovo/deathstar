import { createCommandRunner } from "./command.ts";
import { createUsageMonitor } from "./usage.ts";
import { createMemoryCleanupController } from "./memory-cleanup.ts";
import { createAutomaticCleanupController } from "./auto-cleanup.ts";
import { createCollector } from "./collector.ts";
import { systemClock } from "./clock.ts";
import { createHttpServer } from "./http.ts";
import { createMaintenanceProbe } from "./maintenance.ts";
import { loadConfig } from "./config.ts";
import { createSampler } from "./sampler.ts";
import { createHerdrSource } from "./sources/herdr.ts";
import { createProcSource } from "./sources/proc.ts";
import { createStorage } from "./storage.ts";

const config = loadConfig();
const procSource = createProcSource({
  warningAvailableBytes: config.warningAvailableBytes,
  criticalAvailableBytes: config.criticalAvailableBytes,
  warningSwapRatio: config.warningSwapRatio,
});
const commandRunner = createCommandRunner();
const usage = createUsageMonitor({
  runner: commandRunner,
  intervalMs: config.usageIntervalMs,
  timeoutMs: config.usageCommandTimeoutMs,
});
const maintenance = createMaintenanceProbe({
  runner: commandRunner,
  helperPath: config.memoryHelperPath,
  wrapperPath: config.memoryHelperPath,
  binaryPath: `${config.memoryHelperPath}.bin`,
  sudoersPath: "/etc/sudoers.d/deathstar-memory-clean",
  timeoutMs: config.commandTimeoutMs,
  autoCleanupMode: config.autoCleanupMode,
});
const herdrSource = createHerdrSource({
  runner: commandRunner,
  procSource,
  herdrBinary: config.herdrBinary,
  commandTimeoutMs: config.commandTimeoutMs,
});
const memoryCleanup = createMemoryCleanupController({
  runner: commandRunner,
  helperPath: config.memoryHelperPath,
  timeoutMs: config.memoryCleanupTimeoutMs,
  cooldownMs: config.memoryCleanupCooldownMs,
  maintenance,
});
const automaticCleanup = createAutomaticCleanupController({
  mode: config.autoCleanupMode,
  criticalConfirmSamples: config.stateConfirmSamples,
  cooldownMs: config.autoCleanupCooldownMs,
  probe: maintenance,
  cleaner: memoryCleanup,
});
const collector = createCollector({
  clock: systemClock,
  hostSource: procSource,
  herdrSource,
  stateConfirmSamples: config.stateConfirmSamples,
  stateRecoveryConfirmSamples: config.stateRecoveryConfirmSamples,
  memoryGrowthBytes: config.memoryGrowthBytes,
  memoryGrowthWindowMs: config.memoryGrowthWindowMs,
});
const storage = createStorage(config.databasePath);
const sampler = createSampler({
  clock: systemClock,
  intervalMs: config.sampleIntervalMs,
  retentionMs: config.retentionMs,
  storage,
  collector,
  automaticCleanup,
});
const server = createHttpServer({
  storage,
  usage,
  host: config.host,
  port: config.port,
  dashboardOrigin: config.dashboardOrigin,
  memoryCleanup,
});

sampler.start();
usage.start();
console.log(`deathstar listening on http://${config.host}:${config.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`deathstar shutting down after ${signal}`);
  await Promise.all([sampler.stop(), usage.stop()]);
  server.stop();
  storage.close();
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
