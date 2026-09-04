import { parseArgs as parseNodeArgs } from "node:util";
import { createCommandRunner } from "./command.ts";
import { runDoctor } from "./doctor.ts";
import { createMaintenanceProbe } from "./maintenance.ts";
import { loadConfig } from "./config.ts";
import type { RecoveryCommand } from "./recovery/types.ts";
import { validateSessionName } from "./recovery/mapping.ts";
import { createRecoveryWorkflow } from "./recovery/workflow.ts";

type DoctorCommand = { command: "doctor"; json: boolean };
export type CliCommand = RecoveryCommand | DoctorCommand;

const COMMANDS: Record<RecoveryCommand["command"], true> = {
  bind: true,
  status: true,
  close: true,
  open: true,
};

export function parseArguments(args: string[]): CliCommand {
  if (args[0] === "doctor") {
    const options = parseNodeArgs({ args: args.slice(1), options: { json: { type: "boolean" } }, strict: true });
    return { command: "doctor", json: options.values.json === true };
  }
  if (args[0] !== "session") throw new Error("usage: deathstar session <bind|status|close|open> <name> [--no-attach] [--json]");
  const command = args[1] as RecoveryCommand["command"];
  if (!Object.hasOwn(COMMANDS, command)) throw new Error("session command must be bind, status, close, or open");
  const name = args[2];
  if (!name || name.startsWith("-")) throw new Error("session name is required");
  validateSessionName(name);
  const options = parseNodeArgs({ args: args.slice(3), options: { "no-attach": { type: "boolean" }, json: { type: "boolean" } }, strict: true });
  if (command !== "open" && options.values["no-attach"]) throw new Error("--no-attach is only valid with session open");
  return {
    command,
    name,
    noAttach: options.values["no-attach"] === true,
    json: options.values.json === true,
  };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const command = parseArguments(args);
    if (command.command === "doctor") {
      const config = loadConfig();
      const runner = createCommandRunner();
      const probe = createMaintenanceProbe({
        runner,
        helperPath: config.memoryHelperPath,
        wrapperPath: config.memoryHelperPath,
        binaryPath: `${config.memoryHelperPath}.bin`,
        sudoersPath: "/etc/sudoers.d/deathstar-memory-clean",
        timeoutMs: config.commandTimeoutMs,
        autoCleanupMode: config.autoCleanupMode,
      });
      const result = await runDoctor({ probe, runner, timeoutMs: config.commandTimeoutMs, port: config.port });
      console.log(command.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    const workflow = createRecoveryWorkflow();
    const result = command.command === "bind"
      ? await workflow.bind(command.name)
      : command.command === "status"
        ? await workflow.status(command.name)
        : command.command === "close"
          ? await workflow.close(command.name)
          : await workflow.open(command.name, { noAttach: command.noAttach });
    console.log(command.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
