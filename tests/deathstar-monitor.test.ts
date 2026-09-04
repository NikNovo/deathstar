import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const statusPath = new URL("../ops/deathstar-monitor-status", import.meta.url);
const logsPath = new URL("../ops/deathstar-monitor-logs", import.meta.url);
const bootstrapPath = new URL("../ops/deathstar-monitor-bootstrap", import.meta.url);

test("status monitor emits one read-only report", async () => {
  const child = Bun.spawn(["bash", statusPath.pathname], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DEATHSTAR_MONITOR_ONCE: "1" },
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("deathstar.service");
  expect(output).toContain("omp-stats.service");
  expect(output).toContain("3847");
  expect(output).toContain("3848");
  expect(output).toContain("-- Memory --");
  expect(output).toContain("-- Swap --");
  expect(statSync(statusPath).mode & 0o111).toBeGreaterThan(0);
});

test("status monitor probes the OMP Stats API", () => {
  const script = readFileSync(statusPath, "utf8");
  expect(script).toContain("http://127.0.0.1:3847/api/stats/overview");
  expect(script).not.toContain("http://127.0.0.1:3847/ >/dev/null");
});

test("logs monitor follows both dashboard user units", () => {
  const script = readFileSync(logsPath, "utf8");
  expect(script).toContain("journalctl");
  expect(script).toContain("deathstar.service");
  expect(script).toContain("omp-stats.service");
  expect(script).toContain("--follow");
});

test("bootstrap rejects a pane without explicit named-session identity", async () => {
  const child = Bun.spawn(["bash", bootstrapPath.pathname], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HERDR_ENV: "1",
      HERDR_SESSION: "",
      HERDR_SOCKET_PATH: "",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout).toBe("");
  expect(exitCode).toBe(2);
  expect(stderr).toContain("missing explicit deathstar-monitor session identity");
});

test("bootstrap accepts the named-session identity before pane validation", async () => {
  const home = mkdtempSync(join(tmpdir(), "deathstar-monitor-home-"));
  const bin = join(home, "bin");
  const herdrPath = join(bin, "herdr");
  const jqPath = join(bin, "jq");
  const invocationMarker = join(home, "herdr-invoked");
  mkdirSync(bin);
  writeFileSync(herdrPath, '#!/usr/bin/env bash\n: > "$HERDR_INVOCATION_MARKER"\nexit 19\n');
  writeFileSync(jqPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(herdrPath, 0o755);
  chmodSync(jqPath, 0o755);
  try {
    const child = Bun.spawn(["bash", bootstrapPath.pathname], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HERDR_ENV: "1",
        HERDR_SESSION: "",
        HERDR_SOCKET_PATH: join(home, ".config", "herdr", "sessions", "deathstar-monitor", "herdr.sock"),
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
        HERDR_PANE_ID: "w1:p1",
        HERDR_INVOCATION_MARKER: invocationMarker,
        XDG_STATE_HOME: join(home, ".local", "state"),
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stdout).toBe("");
    expect(exitCode).toBe(1);
    expect(existsSync(invocationMarker)).toBe(true);
    expect(stderr).not.toContain("missing explicit deathstar-monitor session identity");
    expect(stderr).toContain("current Herdr pane is not part of the named deathstar-monitor workspace and tab");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap is named-session safe and idempotent by inspection", () => {
  const script = readFileSync(bootstrapPath, "utf8");
  expect(script).toContain('[[ "${HERDR_ENV:-}" == "1" ]]');
  expect(script).toContain("HERDR_SESSION");
  expect(script).toContain("HERDR_SOCKET_PATH");
  expect(script).toContain("pane list");
  expect(script).toContain("pane process-info");
  expect(script).toContain("pane split");
  expect(script).toContain("pane rename");
  expect(script).toContain("status");
  expect(script).toContain("logs");
  expect(script).toContain("maintenance");
  expect(script).toContain("--no-focus");
  expect(script).toContain("deathstar-monitor-status");
  expect(script).toContain("deathstar-monitor-logs");
  expect(script).toContain("BASH_SOURCE[0]");
  expect(script).not.toContain(["/home", "dev"].join("/"));
  expect(script).not.toContain("deathstar.service restart");
  expect(script).not.toContain("omp stats");
});

test("monitor service owns only the Herdr control plane", () => {
  const unit = readFileSync(new URL("../ops/deathstar-monitor.service", import.meta.url), "utf8");
  expect(unit).toContain("ExecStart=/usr/bin/env herdr --session deathstar-monitor server");
  expect(unit).toContain("Restart=always");
  expect(unit).not.toContain("src/server.ts");
  expect(unit).not.toContain("omp stats");
  expect(unit).not.toContain("3847");
  expect(unit).not.toContain("3848");
});
