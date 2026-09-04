import type { CommandRunner } from "./command.ts";
import { createMaintenanceProbe, type MaintenanceProbe, type MaintenanceStatus } from "./maintenance.ts";
import type { CleanupResult, CleanupAction } from "./memory-helper.ts";

export type MemoryCleanupErrorCode = "privileged_helper_unavailable" | "cleanup_busy" | "cleanup_failed" | "cleanup_invalid_result";

export class MemoryCleanupError extends Error {
  constructor(
    public readonly statusCode: 409 | 500 | 503,
    message: string,
    public readonly code: MemoryCleanupErrorCode = statusCode === 409 ? "cleanup_busy" : statusCode === 500 ? "cleanup_invalid_result" : "cleanup_failed",
  ) {
    super(message);
    this.name = "MemoryCleanupError";
  }
}

export interface MemoryCleanupController {
  run(): Promise<CleanupResult>;
  status(): Promise<MaintenanceStatus>;
}

export interface MemoryCleanupControllerOptions {
  runner: CommandRunner;
  helperPath: string;
  timeoutMs: number;
  cooldownMs: number;
  maintenance?: MaintenanceProbe;
  now?: () => Date;
}
const INSTALL_REMEDIATION = "Run ops/install-memory-cleanup from an interactive terminal.";

function isAction(value: unknown): value is CleanupAction {
  return value === "done" || value === "skipped" || value === "failed";
}

function parseResult(stdout: string): CleanupResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new MemoryCleanupError(500, `cleanup helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "cleanup_invalid_result");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryCleanupError(500, "cleanup helper returned an invalid result", "cleanup_invalid_result");
  }
  const result = value as Record<string, unknown>;
  const actions = result.actions;
  if (result.version !== 1 || !["ok", "partial", "failed"].includes(String(result.status)) || !actions || typeof actions !== "object" || Array.isArray(actions)) {
    throw new MemoryCleanupError(500, "cleanup helper returned an invalid result", "cleanup_invalid_result");
  }
  const actionRecord = actions as Record<string, unknown>;
  if (!isAction(actionRecord.dropCaches) || !isAction(actionRecord.swapCycle)) {
    throw new MemoryCleanupError(500, "cleanup helper returned invalid action states", "cleanup_invalid_result");
  }
  return result as unknown as CleanupResult;
}

export function createMemoryCleanupController(options: MemoryCleanupControllerOptions): MemoryCleanupController {
  const now = options.now || (() => new Date());
  const maintenance = options.maintenance || createMaintenanceProbe({
    runner: options.runner,
    helperPath: options.helperPath,
    wrapperPath: options.helperPath,
    binaryPath: `${options.helperPath}.bin`,
    sudoersPath: "/etc/sudoers.d/deathstar-memory-clean",
    timeoutMs: options.timeoutMs,
    autoCleanupMode: "off",
  });
  let active = false;
  let lastCompletedAt = 0;
  let lastCleanup: MaintenanceStatus["lastCleanup"] = null;

  return {
    async run() {
      if (active) throw new MemoryCleanupError(409, "memory cleanup is already running", "cleanup_busy");
      const currentTime = now().getTime();
      if (lastCompletedAt > 0 && currentTime - lastCompletedAt < options.cooldownMs) {
        throw new MemoryCleanupError(409, "memory cleanup cooldown is active", "cleanup_busy");
      }
      active = true;
      try {
        const response = await options.runner.run(["sudo", "-n", options.helperPath], options.timeoutMs);
        if (response.exitCode !== 0) {
          const message = response.stderr.trim() || `cleanup helper exited ${response.exitCode}`;
          const unavailable = /interactive authentication is required|password is required|not found|no such file|permission denied|arguments are not accepted/i.test(message);
          throw new MemoryCleanupError(503, unavailable ? `${message}; ${INSTALL_REMEDIATION}` : message, unavailable ? "privileged_helper_unavailable" : "cleanup_failed");
        }
        const parsed = parseResult(response.stdout);
        lastCompletedAt = now().getTime();
        lastCleanup = { status: parsed.status, completedAt: parsed.completedAt };
        return parsed;
      } finally {
        active = false;
      }
    },
    async status() {
      const status = await maintenance.read();
      return { ...status, lastCleanup: lastCleanup || status.lastCleanup };
    },
  };
}
