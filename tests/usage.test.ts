import { expect, test } from "bun:test";
import { normalizeModelCatalog, normalizeUsageSnapshot, createUsageMonitor } from "../src/usage.ts";
import type { UsageResponse } from "../src/types.ts";

const rawSnapshot = {
  generatedAt: 1_800_000_000_000,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1_800_000_001_000,
      metadata: { email: "secret@example.test", accountId: "secret-id", endpoint: "private" },
      limits: [
        {
          id: "anthropic:5h",
          label: "Claude 5 Hour",
          amount: { used: 13, limit: 100, remaining: 87, unit: "percent" },
          window: { id: "5h", label: "5 Hour", resetsAt: 1_800_018_000_000 },
          status: "ok",
        },
        {
          id: "anthropic:extra",
          label: "Claude Extra Usage",
          amount: { used: 58.69, limit: 60, remaining: 1.31, unit: "usd" },
          window: null,
          status: "warning",
        },
      ],
    },
    {
      provider: "zai",
      fetchedAt: 1_800_000_002_000,
      metadata: { modelUsage: { "GLM-5": 123 } },
      limits: [
        {
          id: "zai:credits:5h",
          label: "ZAI 5 Hours Credit Quota",
          amount: { used: 0, limit: 2000, remaining: 2000, unit: "credits" },
          window: { id: "5h", label: "5 Hour" },
        },
      ],
    },
    {
      provider: "github-copilot",
      fetchedAt: 1_800_000_003_000,
      metadata: { plan: "individual" },
      limits: [
        {
          id: "copilot:chat",
          label: "Chat Requests",
          amount: { used: 0, limit: 200, remaining: 200, unit: "requests" },
          window: { id: "monthly", label: "Monthly", resetsAt: null },
        },
      ],
    },
  ],
  accountsWithoutUsage: [{ provider: "kimi-code", type: "oauth", authorizedAt: 1_700_000_000_000 }],
  disabledCredentials: [],
};
const rawModelCatalog = {
  models: [
    {
      provider: "anthropic",
      id: "claude-sonnet",
      name: "Claude Sonnet",
      selector: "anthropic/claude-sonnet",
      contextWindow: 200_000,
      maxTokens: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      secret: "must be discarded",
    },
    {
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      contextWindow: null,
      maxTokens: 32_000,
      cost: null,
    },
  ],
};


test("normalizes safe provider meters and removes raw metadata", () => {
  const snapshot = normalizeUsageSnapshot(rawSnapshot);
  expect(snapshot).toEqual({
    generatedAt: "2027-01-15T08:00:00.000Z",
    reports: [
      {
        provider: "anthropic",
        accountLabel: "Account 1",
        plan: null,
        fetchedAt: "2027-01-15T08:00:01.000Z",
        limits: [
          {
            id: "anthropic:5h",
            label: "Claude 5 Hour",
            amount: { used: 13, limit: 100, remaining: 87, unit: "percent" },
            window: { id: "5h", label: "5 Hour", resetsAt: "2027-01-15T13:00:00.000Z" },
            status: "ok",
          },
          {
            id: "anthropic:extra",
            label: "Claude Extra Usage",
            amount: { used: 58.69, limit: 60, remaining: 1.31, unit: "usd" },
            window: null,
            status: "warning",
          },
        ],
        resetCredits: null,
      },
      {
        provider: "zai",
        accountLabel: "Account 1",
        plan: null,
        fetchedAt: "2027-01-15T08:00:02.000Z",
        limits: [
          {
            id: "zai:credits:5h",
            label: "ZAI 5 Hours Credit Quota",
            amount: { used: 0, limit: 2000, remaining: 2000, unit: "credits" },
            window: { id: "5h", label: "5 Hour", resetsAt: null },
            status: "unknown",
          },
        ],
        resetCredits: null,
      },
      {
        provider: "github-copilot",
        accountLabel: "Account 1",
        plan: "individual",
        fetchedAt: "2027-01-15T08:00:03.000Z",
        limits: [
          {
            id: "copilot:chat",
            label: "Chat Requests",
            amount: { used: 0, limit: 200, remaining: 200, unit: "requests" },
            window: { id: "monthly", label: "Monthly", resetsAt: null },
            status: "unknown",
          },
        ],
        resetCredits: null,
      },
    ],
    accountsWithoutUsage: [{ provider: "kimi-code", type: "oauth" }],
    disabledCredentials: [],
  });
  expect(JSON.stringify(snapshot)).not.toContain("secret@example.test");
  expect(JSON.stringify(snapshot)).not.toContain("GLM-5");
});
test("normalizes model limits without exposing catalog metadata", () => {
  expect(normalizeModelCatalog(rawModelCatalog)).toEqual([
    {
      provider: "anthropic",
      id: "claude-sonnet",
      name: "Claude Sonnet",
      contextWindow: 200_000,
      maxTokens: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      contextWindow: null,
      maxTokens: 32_000,
      cost: null,
    },
  ]);
  expect(JSON.stringify(normalizeModelCatalog(rawModelCatalog))).not.toContain("must be discarded");
  expect(() => normalizeModelCatalog({ models: "invalid" })).toThrow("models");
});

test("normalizes disabled credential tombstones to safe status", () => {
  const snapshot = normalizeUsageSnapshot({
    generatedAt: 1_800_000_000_000,
    reports: [],
    accountsWithoutUsage: [],
    disabledCredentials: [
      {
        provider: "anthropic",
        type: "oauth",
        cause: "expired-token",
        disabledAtMs: 1_800_000_001_000,
        accountId: "secret-account-id",
      },
      {
        provider: "zai",
        status: "disabled",
        type: "api-key",
        cause: "revoked",
        disabledAtMs: 1_800_000_002_000,
      },
    ],
  });

  expect(snapshot.disabledCredentials).toEqual([
    { provider: "anthropic", status: "disabled" },
    { provider: "zai", status: "disabled" },
  ]);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toContain("expired-token");
  expect(serialized).not.toContain("revoked");
  expect(serialized).not.toContain("secret-account-id");
  expect(serialized).not.toContain("disabledAtMs");
});


test("normalizes reset credits and retains separate account ordinals", () => {
  const input = {
    ...rawSnapshot,
    reports: [
      {
        provider: "openai-codex",
        fetchedAt: 1_800_000_001_000,
        metadata: { planType: "prolite" },
        resetCredits: {
          availableCount: 1,
          credits: [{ grantedAt: "2026-08-22T00:13:59.680682Z", expiresAt: "2026-09-21T00:13:59.680682Z", status: "available" }],
        },
        limits: [],
      },
      {
        provider: "openai-codex",
        fetchedAt: 1_800_000_002_000,
        metadata: { planType: "prolite" },
        limits: [],
      },
    ],
  };
  const reports = normalizeUsageSnapshot(input).reports;
  expect(reports[0]?.accountLabel).toBe("Account 1");
  expect(reports[1]?.accountLabel).toBe("Account 2");
  expect(reports[0]?.plan).toBe("prolite");
  expect(reports[0]?.resetCredits?.credits[0]?.expiresAt).toBe("2026-09-21T00:13:59.680682Z");
});

test("rejects a missing reports array", () => {
  expect(() => normalizeUsageSnapshot({ generatedAt: 1_800_000_000_000 })).toThrow("reports");
});

test("collects CLI provider statuses and model limits", async () => {
  const calls: string[][] = [];
  const runner = {
    run: async (args: string[], timeoutMs: number) => {
      calls.push([...args, String(timeoutMs)]);
      if (args[1] === "models") return { exitCode: 0, stdout: JSON.stringify(rawModelCatalog), stderr: "" };
      if (args.includes("--provider")) {
        const provider = args[args.indexOf("--provider") + 1];
        if (provider === "perplexity") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ reports: [], accountsWithoutUsage: [{ provider, type: "oauth" }] }),
            stderr: "",
          };
        }
        if (provider === "tavily") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ reports: [], accountsWithoutUsage: [{ provider, type: "api_key" }] }),
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: `No usage data for provider "${provider}".` };
      }
      return { exitCode: 0, stdout: JSON.stringify(rawSnapshot), stderr: "" };
    },
  };
  const monitor = createUsageMonitor({
    runner,
    intervalMs: 3_600_000,
    timeoutMs: 60_000,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
    schedule: () => 1,
    cancel: () => {},
  });

  await monitor.refreshOnce();
  const current = monitor.current();
  expect(calls.map((args) => args.slice(0, -1).join(" ")).sort()).toEqual([
    "omp models --json",
    "omp usage --json --redact",
    "omp usage --provider meta --json --redact",
    "omp usage --provider perplexity --json --redact",
    "omp usage --provider tavily --json --redact",
  ]);
  expect(current.cliProviders).toEqual([
    { provider: "perplexity", status: "no-usage-data", accounts: 1, reports: 0, error: null },
    { provider: "tavily", status: "no-usage-data", accounts: 1, reports: 0, error: null },
    { provider: "meta", status: "no-usage-data", accounts: 0, reports: 0, error: null },
  ]);
  expect(current.models.status).toBe("ok");
  expect(current.models.models).toEqual([
    {
      provider: "anthropic",
      id: "claude-sonnet",
      name: "Claude Sonnet",
      contextWindow: 200_000,
      maxTokens: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      contextWindow: null,
      maxTokens: 32_000,
      cost: null,
    },
  ]);
});

test("runs usage and model commands, schedules one hour later, and preserves stale data", async () => {
  const calls: string[][] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  let result = { exitCode: 0, stdout: JSON.stringify(rawSnapshot), stderr: "" };
  const runner = {
    run: async (args: string[], timeoutMs: number) => {
      calls.push([...args, String(timeoutMs)]);
      if (args[1] === "models") return { exitCode: 0, stdout: JSON.stringify(rawModelCatalog), stderr: "" };
      if (args.includes("--provider")) return { exitCode: 0, stdout: JSON.stringify({ reports: [], accountsWithoutUsage: [] }), stderr: "" };
      if (result.exitCode !== 0) throw new Error(`usage command exited with code ${result.exitCode}`);
      return result;
    },
  };
  const monitor = createUsageMonitor({
    runner,
    intervalMs: 3_600_000,
    timeoutMs: 60_000,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
    schedule: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return scheduled.length; },
    cancel: () => {},
  });

  monitor.start();
  await monitor.refreshOnce();
  expect(calls).toContainEqual(["omp", "usage", "--json", "--redact", "60000"]);
  expect(calls).toContainEqual(["omp", "models", "--json", "60000"]);
  expect(scheduled[0]?.delayMs).toBe(3_600_000);
  expect(monitor.current().status).toBe("ok");
  expect(monitor.current().models.status).toBe("ok");

  result = { exitCode: 1, stdout: "", stderr: "provider details must not be returned" };
  await monitor.refreshOnce();
  const stale: UsageResponse = monitor.current();
  expect(stale.status).toBe("stale");
  expect(stale.snapshot?.reports[0]?.provider).toBe("anthropic");
  expect(stale.error).toBe("usage command exited with code 1");
});

test("does not run two refresh batches concurrently", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const monitor = createUsageMonitor({
    runner: {
      run: async (args: string[]) => {
        calls += 1;
        await pending;
        return { exitCode: 0, stdout: JSON.stringify(args[1] === "models" ? rawModelCatalog : rawSnapshot), stderr: "" };
      },
    },
    intervalMs: 3_600_000,
    timeoutMs: 60_000,
  });
  const first = monitor.refreshOnce();
  const second = monitor.refreshOnce();
  expect(first).toBe(second);
  expect(calls).toBe(5);
  release();
  await first;
});
test("stop cancels the scheduled refresh and awaits an in-flight command", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const canceled: unknown[] = [];
  let calls = 0;
  const monitor = createUsageMonitor({
    runner: {
      run: async (args: string[]) => {
        calls += 1;
        if (calls <= 5) {
          if (args[1] === "models") return { exitCode: 0, stdout: JSON.stringify(rawModelCatalog), stderr: "" };
          if (args.includes("--provider")) return { exitCode: 0, stdout: JSON.stringify({ reports: [], accountsWithoutUsage: [] }), stderr: "" };
          return { exitCode: 0, stdout: JSON.stringify(rawSnapshot), stderr: "" };
        }
        await pending;
        return { exitCode: 0, stdout: JSON.stringify(rawSnapshot), stderr: "" };
      },
    },
    intervalMs: 3_600_000,
    timeoutMs: 60_000,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => canceled.push(handle),
  });

  monitor.start();
  await monitor.refreshOnce();
  expect(scheduled).toHaveLength(1);

  const inFlight = monitor.refreshOnce();
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  expect(canceled).toEqual([scheduled[0]]);
  expect(stopped).toBe(false);

  release();
  await inFlight;
  await stopping;
  expect(stopped).toBe(true);
});
