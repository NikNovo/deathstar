import { homedir } from "node:os";
import { join } from "node:path";

export type Environment = Record<string, string | undefined>;

function absolute(name: string, value: string): string {
  if (!value.startsWith("/")) throw new Error(`${name} must be an absolute path`);
  return value;
}

export function homeDirectory(env: Environment = process.env): string {
  return absolute("HOME", env.HOME || homedir());
}

export function stateDirectory(env: Environment = process.env): string {
  const root = env.XDG_STATE_HOME
    ? absolute("XDG_STATE_HOME", env.XDG_STATE_HOME)
    : join(homeDirectory(env), ".local", "state");
  return join(root, "deathstar");
}

export function recoveryDirectory(env: Environment = process.env): string {
  return join(stateDirectory(env), "recovery");
}

export function ompSessionRoot(env: Environment = process.env): string {
  return join(homeDirectory(env), ".omp", "agent", "sessions");
}
