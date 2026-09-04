import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryMapping } from "./types.ts";
import { recoveryDirectory } from "../paths.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateSessionName(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid session name: ${name}`);
  return name;
}

function validateMapping(value: unknown): RecoveryMapping {
  if (!value || typeof value !== "object") throw new Error("mapping must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error("mapping version must be 1");
  const stringFields = ["herdrSession", "paneId", "sessionFile", "sessionRoot", "capturedAt"];
  for (const field of stringFields) {
    if (typeof candidate[field] !== "string" || candidate[field] === "") throw new Error(`mapping field ${field} is invalid`);
  }
  if (candidate.cwd !== null && typeof candidate.cwd !== "string") throw new Error("mapping field cwd is invalid");
  if (typeof candidate.ompPid !== "number" || !Number.isInteger(candidate.ompPid) || candidate.ompPid <= 0) throw new Error("mapping field ompPid is invalid");
  if (candidate.processStartedAt !== null && typeof candidate.processStartedAt !== "string") throw new Error("mapping field processStartedAt is invalid");
  for (const field of ["fileSize", "fileMtimeMs"]) {
    if (typeof candidate[field] !== "number" || !Number.isFinite(candidate[field]) || candidate[field] < 0) throw new Error(`mapping field ${field} is invalid`);
  }
  validateSessionName(candidate.herdrSession as string);
  return candidate as unknown as RecoveryMapping;
}

export interface MappingStore {
  path(name: string): string;
  read(name: string): RecoveryMapping | null;
  write(mapping: RecoveryMapping): void;
}

export function createMappingStore(options: { directory?: string } = {}): MappingStore {
  const directory = options.directory || process.env.DEATHSTAR_RECOVERY_DIR || recoveryDirectory();

  return {
    path(name) {
      return join(directory, `${validateSessionName(name)}.json`);
    },

    read(name) {
      const path = this.path(name);
      try {
        const mapping = validateMapping(JSON.parse(readFileSync(path, "utf8")));
        if (mapping.herdrSession !== name) throw new Error(`mapping Herdr session ${mapping.herdrSession} does not match requested name ${name}`);
        return mapping;
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    write(mapping) {
      const valid = validateMapping(mapping);
      validateSessionName(valid.herdrSession);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const destination = this.path(valid.herdrSession);
      const temporary = `${destination}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
      statSync(destination);
    },
  };
}
