import type { CommandRunner } from "./command.ts";
import type { MaintenanceProbe, MaintenanceStatus } from "./maintenance.ts";

export interface DoctorOptions {
  probe: MaintenanceProbe;
  runner: CommandRunner;
  timeoutMs: number;
  port?: number;
  checkHealth?: () => Promise<boolean>;
}

export interface DoctorResult {
  ok: boolean;
  maintenance: MaintenanceStatus;
  serviceActive: boolean;
  endpointReachable: boolean;
  errors: string[];
}

async function defaultHealthCheck(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const maintenance = await options.probe.read();
  let serviceActive = false;
  try {
    const service = await options.runner.run(["systemctl", "--user", "is-active", "deathstar.service"], options.timeoutMs);
    serviceActive = service.exitCode === 0 && service.stdout.trim() === "active";
  } catch {
    serviceActive = false;
  }
  const endpointReachable = await (options.checkHealth || (() => defaultHealthCheck(options.port || 3848, options.timeoutMs)))();
  const errors: string[] = [];
  if (!maintenance.ready) errors.push(maintenance.remediation || `cleanup authorization is ${maintenance.authorization}`);
  if (!serviceActive) errors.push("deathstar.service is not active");
  if (!endpointReachable) errors.push("Deathstar health endpoint is unreachable");
  return { ok: errors.length === 0, maintenance, serviceActive, endpointReachable, errors };
}
