import type { AppConfig } from "./types.ts";
import { join } from "node:path";
import { stateDirectory } from "./paths.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_MEMORY_HELPER = "/usr/local/libexec/deathstar-memory-clean";

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function absolutePath(name: string, value: string | undefined, fallback: string): string {
  const result = value || fallback;
  if (!result.startsWith("/")) {
    throw new Error(`${name} must be an absolute path`);
  }
  return result;
}

function absoluteOrigin(name: string, value: string | undefined, fallback: string): string {
  const result = value || fallback;
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${name} must be an absolute http(s) origin`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== result) {
    throw new Error(`${name} must be an absolute http(s) origin`);
  }
  return result;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const port = positiveInteger("DEATHSTAR_PORT", env.DEATHSTAR_PORT, 3848);
  if (port > 65535) throw new Error("DEATHSTAR_PORT must be <= 65535");
  const sampleIntervalMs = positiveInteger("DEATHSTAR_SAMPLE_MS", env.DEATHSTAR_SAMPLE_MS, 5000);
  const usageIntervalMs = positiveInteger("DEATHSTAR_USAGE_INTERVAL_MS", env.DEATHSTAR_USAGE_INTERVAL_MS, 60 * 60 * 1000);
  const usageCommandTimeoutMs = positiveInteger("DEATHSTAR_USAGE_TIMEOUT_MS", env.DEATHSTAR_USAGE_TIMEOUT_MS, 60_000);
  const retentionMs = positiveInteger("DEATHSTAR_RETENTION_MS", env.DEATHSTAR_RETENTION_MS, DAY_MS);
  const commandTimeoutMs = positiveInteger("DEATHSTAR_COMMAND_TIMEOUT_MS", env.DEATHSTAR_COMMAND_TIMEOUT_MS, 2000);
  const memoryCleanupTimeoutMs = positiveInteger("DEATHSTAR_MEMORY_TIMEOUT_MS", env.DEATHSTAR_MEMORY_TIMEOUT_MS, 30_000);
  const memoryCleanupCooldownMs = positiveInteger("DEATHSTAR_MEMORY_COOLDOWN_MS", env.DEATHSTAR_MEMORY_COOLDOWN_MS, 60_000);
  const stateConfirmSamples = positiveInteger("DEATHSTAR_STATE_CONFIRM_SAMPLES", env.DEATHSTAR_STATE_CONFIRM_SAMPLES, 2);
  const stateRecoveryConfirmSamples = positiveInteger("DEATHSTAR_STATE_RECOVERY_SAMPLES", env.DEATHSTAR_STATE_RECOVERY_SAMPLES, 3);
  const memoryGrowthBytes = positiveInteger("DEATHSTAR_MEMORY_GROWTH_BYTES", env.DEATHSTAR_MEMORY_GROWTH_BYTES, 512 * 1024 ** 2);
  const memoryGrowthWindowMs = positiveInteger("DEATHSTAR_MEMORY_GROWTH_WINDOW_MS", env.DEATHSTAR_MEMORY_GROWTH_WINDOW_MS, 5 * 60 * 1000);
  const autoCleanupCooldownMs = positiveInteger("DEATHSTAR_AUTO_CLEANUP_COOLDOWN_MS", env.DEATHSTAR_AUTO_CLEANUP_COOLDOWN_MS, 10 * 60 * 1000);
  const warningAvailableBytes = positiveInteger("DEATHSTAR_WARNING_AVAILABLE_BYTES", env.DEATHSTAR_WARNING_AVAILABLE_BYTES, 4 * 1024 ** 3);
  const criticalAvailableBytes = positiveInteger("DEATHSTAR_CRITICAL_AVAILABLE_BYTES", env.DEATHSTAR_CRITICAL_AVAILABLE_BYTES, 2 * 1024 ** 3);
  if (criticalAvailableBytes > warningAvailableBytes) {
    throw new Error("DEATHSTAR_CRITICAL_AVAILABLE_BYTES must be <= warning threshold");
  }
  const warningSwapRatio = nonNegativeNumber("DEATHSTAR_WARNING_SWAP_RATIO", env.DEATHSTAR_WARNING_SWAP_RATIO, 0.5);
  if (warningSwapRatio > 1) throw new Error("DEATHSTAR_WARNING_SWAP_RATIO must be <= 1");
  const autoCleanupMode = env.DEATHSTAR_AUTO_CLEANUP || "off";
  if (autoCleanupMode !== "off" && autoCleanupMode !== "cache") throw new Error("DEATHSTAR_AUTO_CLEANUP must be off or cache");

  return {
    host: env.DEATHSTAR_HOST || "127.0.0.1",
    port,
    usageIntervalMs,
    usageCommandTimeoutMs,
    sampleIntervalMs,
    retentionMs,
    databasePath: absolutePath("DEATHSTAR_DB", env.DEATHSTAR_DB, join(stateDirectory(env), "monitor.sqlite3")),
    herdrBinary: env.DEATHSTAR_HERDR || "herdr",
    commandTimeoutMs,
    warningAvailableBytes,
    criticalAvailableBytes,
    warningSwapRatio,
    dashboardOrigin: absoluteOrigin("DEATHSTAR_DASHBOARD_ORIGIN", env.DEATHSTAR_DASHBOARD_ORIGIN, `http://127.0.0.1:${port}`),
    memoryHelperPath: absolutePath("DEATHSTAR_MEMORY_HELPER", env.DEATHSTAR_MEMORY_HELPER, DEFAULT_MEMORY_HELPER),
    memoryCleanupTimeoutMs,
    memoryCleanupCooldownMs,
    stateConfirmSamples,
    stateRecoveryConfirmSamples,
    memoryGrowthBytes,
    memoryGrowthWindowMs,
    autoCleanupMode,
    autoCleanupCooldownMs,
  };
}
