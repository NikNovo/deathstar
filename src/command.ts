export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(args: string[], timeoutMs: number): Promise<CommandResult>;
}

export function createCommandRunner(): CommandRunner {
  return {
    async run(args, timeoutMs) {
      if (args.length === 0) throw new Error("command arguments cannot be empty");
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms: ${args[0]}`);
        return { exitCode, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
