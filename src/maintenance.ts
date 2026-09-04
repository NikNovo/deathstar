import { stat } from "node:fs/promises";
import type { CommandRunner } from "./command.ts";

export type MaintenanceAuthorization = "ready" | "auth-required" | "rule-missing" | "helper-missing" | "unknown";
export type AutoCleanupMode = "off" | "cache";

export interface MaintenanceStatus {
  helperPath: string;
  wrapperPresent: boolean;
  wrapperExecutable: boolean;
  binaryPresent: boolean;
  binaryExecutable: boolean;
  binaryRootOwned: boolean | null;
  wrapperRootOwned: boolean | null;
  sudoersPresent: boolean | null;
  authorization: MaintenanceAuthorization;
  ready: boolean;
  autoCleanupMode: AutoCleanupMode;
  remediation: string | null;
  lastCleanup: { status: "ok" | "partial" | "failed"; completedAt: string } | null;
}

export interface FileMetadata {
  uid: number;
  mode: number;
}

export interface MaintenanceProbeOptions {
  runner: CommandRunner;
  helperPath: string;
  wrapperPath: string;
  binaryPath: string;
  sudoersPath: string;
  timeoutMs: number;
  autoCleanupMode: AutoCleanupMode;
  statFile?: (path: string) => Promise<FileMetadata>;
  now?: () => number;
}

export interface MaintenanceProbe {
  read(): Promise<MaintenanceStatus>;
}

const CACHE_TTL_MS = 5000;
const REMEDIATION = "Run ops/install-memory-cleanup from an interactive terminal.";

function executable(metadata: FileMetadata | null): boolean {
  return metadata !== null && (metadata.mode & 0o111) !== 0;
}

function authRequired(stderr: string): boolean {
  return /interactive authentication is required|password is required|a password is required/i.test(stderr);
}
type FileInspection = { metadata: FileMetadata | null; present: boolean | null };

function isMissing(error: unknown): boolean {
  let code = "";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") code = error.code;
  return code === "ENOENT" || String(error).includes("ENOENT");
}

export function createMaintenanceProbe(options: MaintenanceProbeOptions): MaintenanceProbe {
  const readStat = options.statFile || (async (path: string): Promise<FileMetadata> => {
    const metadata = await stat(path);
    return { uid: metadata.uid, mode: metadata.mode };
  });
  const now = options.now || (() => Date.now());
  const inspect = async (path: string): Promise<FileInspection> => {
    try {
      return { metadata: await readStat(path), present: true };
    } catch (error) {
      return { metadata: null, present: isMissing(error) ? false : null };
    }
  };
  let cached: { at: number; value: MaintenanceStatus } | null = null;

  return {
    async read() {
      const currentTime = now();
      if (cached && currentTime - cached.at < CACHE_TTL_MS) return cached.value;

      const [wrapperInspection, binaryInspection, sudoersInspection] = await Promise.all([
        inspect(options.wrapperPath),
        inspect(options.binaryPath),
        inspect(options.sudoersPath),
      ]);
      const wrapper = wrapperInspection.metadata;
      const binary = binaryInspection.metadata;
      const wrapperPresent = wrapper !== null;
      const binaryPresent = binary !== null;
      const sudoersPresent = sudoersInspection.present;
      const safeFiles = executable(wrapper) && executable(binary) && wrapper?.uid === 0 && binary?.uid === 0;
      let authorization: MaintenanceAuthorization;
      if (!wrapperPresent || !binaryPresent) {
        authorization = "helper-missing";
      } else if (!safeFiles) {
        authorization = "unknown";
      } else {
        const response = await options.runner.run(["sudo", "-n", "-l", options.helperPath], options.timeoutMs);
        authorization = response.exitCode === 0 ? "ready" : sudoersPresent === false ? "rule-missing" : authRequired(response.stderr) ? "auth-required" : "unknown";
      }
      const ready = authorization === "ready"
        && executable(wrapper)
        && executable(binary)
        && wrapper?.uid === 0
        && binary?.uid === 0;
      const value: MaintenanceStatus = {
        helperPath: options.helperPath,
        wrapperPresent,
        wrapperExecutable: executable(wrapper),
        binaryPresent,
        binaryExecutable: executable(binary),
        wrapperRootOwned: wrapper === null ? null : wrapper.uid === 0,
        binaryRootOwned: binary === null ? null : binary.uid === 0,
        sudoersPresent,
        authorization,
        ready,
        autoCleanupMode: options.autoCleanupMode,
        remediation: ready ? null : REMEDIATION,
        lastCleanup: null,
      };
      cached = { at: currentTime, value };
      return value;
    },
  };
}
