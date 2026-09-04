import type { CleanupResult } from "./memory-helper.ts";
import type { MaintenanceProbe } from "./maintenance.ts";
import type { EventRecord, HealthSnapshot } from "./types.ts";

export interface AutomaticCleanupControllerOptions {
  mode: "off" | "cache";
  criticalConfirmSamples: number;
  cooldownMs: number;
  probe: MaintenanceProbe;
  cleaner: Pick<{ run(): Promise<CleanupResult> }, "run">;
  now?: () => number;
}

export interface AutomaticCleanupController {
  observe(snapshot: HealthSnapshot): Promise<EventRecord[]>;
}

function severityForCleanup(status: CleanupResult["status"]): EventRecord["severity"] {
  return status === "failed" ? "critical" : status === "partial" ? "warning" : "info";
}

function cleanupEvent(snapshot: HealthSnapshot, result: CleanupResult): EventRecord {
  return {
    observedAt: snapshot.observedAt,
    severity: severityForCleanup(result.status),
    kind: "cleanup-auto",
    session: null,
    message: "Automatic cache cleanup completed",
    details: {
      status: result.status,
      dropCaches: result.actions.dropCaches,
      swapCycle: result.actions.swapCycle,
      availableBeforeBytes: result.before.availableBytes,
      availableAfterBytes: result.after.availableBytes,
      swapBeforeBytes: result.before.swapUsedBytes,
      swapAfterBytes: result.after.swapUsedBytes,
    },
  };
}

export function createAutomaticCleanupController(options: AutomaticCleanupControllerOptions): AutomaticCleanupController {
  const now = options.now || (() => Date.now());
  let criticalSamples = 0;
  let lastAttemptAt = 0;

  return {
    async observe(snapshot) {
      if (options.mode !== "cache" || snapshot.host.state !== "critical") {
        criticalSamples = 0;
        return [];
      }
      criticalSamples += 1;
      if (criticalSamples < options.criticalConfirmSamples) return [];
      const currentTime = now();
      if (lastAttemptAt > 0 && currentTime - lastAttemptAt < options.cooldownMs) return [];
      lastAttemptAt = currentTime;

      const maintenance = await options.probe.read();
      if (!maintenance.ready) {
        return [{
          observedAt: snapshot.observedAt,
          severity: "warning",
          kind: "cleanup-unavailable",
          session: null,
          message: "Automatic cache cleanup is unavailable",
          details: {
            authorization: maintenance.authorization,
            remediation: maintenance.remediation,
          },
        }];
      }

      try {
        return [cleanupEvent(snapshot, await options.cleaner.run())];
      } catch (error) {
        return [{
          observedAt: snapshot.observedAt,
          severity: "critical",
          kind: "cleanup-auto",
          session: null,
          message: "Automatic cache cleanup failed",
          details: { error: error instanceof Error ? error.message : String(error) },
        }];
      }
    },
  };
}
