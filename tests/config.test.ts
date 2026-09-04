import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const baseEnv: Record<string, string | undefined> = { HOME: "/synthetic/home" };

describe("loadConfig", () => {
  test("returns safe defaults", () => {
    const config = loadConfig(baseEnv);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3848);
    expect(config.sampleIntervalMs).toBe(5000);
    expect(config.usageIntervalMs).toBe(60 * 60 * 1000);
    expect(config.usageCommandTimeoutMs).toBe(60_000);
    expect(config.retentionMs).toBe(24 * 60 * 60 * 1000);
    expect(config.databasePath).toBe("/synthetic/home/.local/state/deathstar/monitor.sqlite3");
    expect(config.herdrBinary).toBe("herdr");
    expect(config.dashboardOrigin).toBe("http://127.0.0.1:3848");
    expect(config.memoryHelperPath).toBe("/usr/local/libexec/deathstar-memory-clean");
    expect(config.memoryCleanupTimeoutMs).toBe(30000);
    expect(config.memoryCleanupCooldownMs).toBe(60000);
    expect(config.stateConfirmSamples).toBe(2);
    expect(config.stateRecoveryConfirmSamples).toBe(3);
    expect(config.memoryGrowthBytes).toBe(512 * 1024 ** 2);
    expect(config.memoryGrowthWindowMs).toBe(5 * 60 * 1000);
    expect(config.autoCleanupMode).toBe("off");
    expect(config.autoCleanupCooldownMs).toBe(10 * 60 * 1000);
  });

  test("accepts environment overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      DEATHSTAR_HOST: "127.0.0.2",
      DEATHSTAR_PORT: "3999",
      DEATHSTAR_SAMPLE_MS: "1000",
      DEATHSTAR_USAGE_INTERVAL_MS: "7200000",
      DEATHSTAR_RETENTION_MS: "60000",
      DEATHSTAR_DB: "/var/lib/deathstar/monitor.sqlite3",
      DEATHSTAR_HERDR: "/usr/local/bin/herdr",
      DEATHSTAR_COMMAND_TIMEOUT_MS: "3000",
      DEATHSTAR_USAGE_TIMEOUT_MS: "90000",
      DEATHSTAR_DASHBOARD_ORIGIN: "https://dashboard.example",
      DEATHSTAR_MEMORY_HELPER: "/usr/local/bin/memory-clean",
      DEATHSTAR_MEMORY_TIMEOUT_MS: "45000",
      DEATHSTAR_MEMORY_COOLDOWN_MS: "90000",
      DEATHSTAR_STATE_CONFIRM_SAMPLES: "4",
      DEATHSTAR_STATE_RECOVERY_SAMPLES: "5",
      DEATHSTAR_MEMORY_GROWTH_BYTES: "1234",
      DEATHSTAR_MEMORY_GROWTH_WINDOW_MS: "600000",
      DEATHSTAR_AUTO_CLEANUP: "cache",
      DEATHSTAR_AUTO_CLEANUP_COOLDOWN_MS: "120000",
    });

    expect(config).toMatchObject({
      host: "127.0.0.2",
      port: 3999,
      sampleIntervalMs: 1000,
      usageIntervalMs: 7_200_000,
      usageCommandTimeoutMs: 90_000,
      retentionMs: 60000,
      databasePath: "/var/lib/deathstar/monitor.sqlite3",
      herdrBinary: "/usr/local/bin/herdr",
      commandTimeoutMs: 3000,
      dashboardOrigin: "https://dashboard.example",
      memoryHelperPath: "/usr/local/bin/memory-clean",
      memoryCleanupTimeoutMs: 45000,
      memoryCleanupCooldownMs: 90000,
      stateConfirmSamples: 4,
      stateRecoveryConfirmSamples: 5,
      memoryGrowthBytes: 1234,
      memoryGrowthWindowMs: 600000,
      autoCleanupMode: "cache",
      autoCleanupCooldownMs: 120000,
    });
  });

  test("rejects invalid port and relative database path", () => {
    expect(() => loadConfig({ DEATHSTAR_PORT: "0" })).toThrow("DEATHSTAR_PORT");
    expect(() => loadConfig({ DEATHSTAR_PORT: "65536" })).toThrow("DEATHSTAR_PORT");
    expect(() => loadConfig({ DEATHSTAR_DB: "monitor.sqlite3" })).toThrow("DEATHSTAR_DB");
  });

  test("rejects a relative XDG state path", () => {
    expect(() => loadConfig({ HOME: "/synthetic/home", XDG_STATE_HOME: "relative" })).toThrow("XDG_STATE_HOME");
  });

  test("rejects invalid dashboard origin and cleanup timings", () => {
    expect(() => loadConfig({ DEATHSTAR_DASHBOARD_ORIGIN: "dashboard.example" })).toThrow("DEATHSTAR_DASHBOARD_ORIGIN");
    expect(() => loadConfig({ DEATHSTAR_MEMORY_TIMEOUT_MS: "0" })).toThrow("DEATHSTAR_MEMORY_TIMEOUT_MS");
    expect(() => loadConfig({ DEATHSTAR_MEMORY_COOLDOWN_MS: "0" })).toThrow("DEATHSTAR_MEMORY_COOLDOWN_MS");
    expect(() => loadConfig({ DEATHSTAR_USAGE_INTERVAL_MS: "0" })).toThrow("DEATHSTAR_USAGE_INTERVAL_MS");
    expect(() => loadConfig({ DEATHSTAR_USAGE_TIMEOUT_MS: "0" })).toThrow("DEATHSTAR_USAGE_TIMEOUT_MS");
    expect(() => loadConfig({ DEATHSTAR_STATE_CONFIRM_SAMPLES: "0" })).toThrow("DEATHSTAR_STATE_CONFIRM_SAMPLES");
    expect(() => loadConfig({ DEATHSTAR_MEMORY_GROWTH_WINDOW_MS: "0" })).toThrow("DEATHSTAR_MEMORY_GROWTH_WINDOW_MS");
    expect(() => loadConfig({ DEATHSTAR_AUTO_CLEANUP: "processes" })).toThrow("DEATHSTAR_AUTO_CLEANUP");
    expect(() => loadConfig({ DEATHSTAR_AUTO_CLEANUP_COOLDOWN_MS: "0" })).toThrow("DEATHSTAR_AUTO_CLEANUP_COOLDOWN_MS");
  });

  test("rejects inverted memory thresholds", () => {
    expect(() => loadConfig({
      DEATHSTAR_WARNING_AVAILABLE_BYTES: "100",
      DEATHSTAR_CRITICAL_AVAILABLE_BYTES: "101",
    })).toThrow("DEATHSTAR_CRITICAL");
  });
});
