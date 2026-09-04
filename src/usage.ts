import type { CommandRunner } from "./command.ts";
import type {
  CliProviderUsage,
  UsageAmount,
  UsageDisabledCredential,
  UsageLimit,
  UsageModelCatalog,
  UsageModelCost,
  UsageModelLimit,
  UsageReport,
  UsageResetCredit,
  UsageResetCredits,
  UsageResponse,
  UsageSnapshot,
  UsageStatus,
  UsageUnavailableAccount,
  UsageWindow,
} from "./types.ts";

const COMMAND = ["omp", "usage", "--json", "--redact"];
const MODEL_COMMAND = ["omp", "models", "--json"];
const CLI_PROVIDERS = ["perplexity", "tavily", "meta"] as const;

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoFromMillis(value: unknown): string | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  try {
    return new Date(number).toISOString();
  } catch {
    return null;
  }
}

function usageStatus(value: unknown): UsageStatus {
  return value === "ok" || value === "warning" || value === "critical" || value === "unknown" || value === "exhausted"
    ? value
    : "unknown";
}

function stringOrUnknown(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeWindow(value: unknown): UsageWindow | null {
  const window = objectValue(value);
  if (!window) return null;
  return {
    id: stringOrUnknown(window.id),
    label: stringOrUnknown(window.label),
    resetsAt: isoFromMillis(window.resetsAt),
  };
}

function normalizeAmount(value: unknown): UsageAmount {
  const amount = objectValue(value);
  return {
    used: finiteNumber(amount?.used),
    limit: finiteNumber(amount?.limit),
    remaining: finiteNumber(amount?.remaining),
    unit: stringOrNull(amount?.unit),
  };
}

function normalizeLimit(value: unknown): UsageLimit {
  const limit = objectValue(value);
  return {
    id: stringOrUnknown(limit?.id),
    label: stringOrUnknown(limit?.label),
    amount: normalizeAmount(limit?.amount),
    window: normalizeWindow(limit?.window),
    status: usageStatus(limit?.status),
  };
}

function normalizeResetCredit(value: unknown): UsageResetCredit {
  const credit = objectValue(value);
  return {
    grantedAt: stringOrNull(credit?.grantedAt),
    expiresAt: stringOrNull(credit?.expiresAt),
    status: stringOrUnknown(credit?.status),
  };
}

function normalizeResetCredits(value: unknown): UsageResetCredits | null {
  const resetCredits = objectValue(value);
  if (!resetCredits) return null;
  return {
    availableCount: finiteNumber(resetCredits.availableCount) ?? 0,
    credits: Array.isArray(resetCredits.credits)
      ? resetCredits.credits.map(normalizeResetCredit)
      : [],
  };
}

function normalizeUnavailableAccount(value: unknown): UsageUnavailableAccount {
  const account = objectValue(value);
  return {
    provider: stringOrUnknown(account?.provider),
    type: stringOrUnknown(account?.type),
  };
}

function normalizeDisabledCredential(value: unknown): UsageDisabledCredential {
  const credential = objectValue(value);
  return {
    provider: stringOrUnknown(credential?.provider),
    status: typeof credential?.status === "string" ? credential.status : "disabled",
  };
}

function normalizeReport(value: unknown, accountOrdinals: Map<string, number>): UsageReport {
  const report = objectValue(value);
  const provider = stringOrUnknown(report?.provider);
  const accountNumber = (accountOrdinals.get(provider) ?? 0) + 1;
  accountOrdinals.set(provider, accountNumber);

  const metadata = objectValue(report?.metadata);
  const plan = typeof metadata?.planType === "string"
    ? metadata.planType
    : typeof metadata?.plan === "string"
      ? metadata.plan
      : null;

  return {
    provider,
    accountLabel: `Account ${accountNumber}`,
    plan,
    fetchedAt: isoFromMillis(report?.fetchedAt),
    limits: Array.isArray(report?.limits) ? report.limits.map(normalizeLimit) : [],
    resetCredits: normalizeResetCredits(report?.resetCredits),
  };
}

export function normalizeUsageSnapshot(input: unknown): UsageSnapshot {
  const root = objectValue(input);
  if (!root) throw new Error("usage snapshot must be an object");

  const generatedAt = finiteNumber(root.generatedAt);
  if (generatedAt === null) throw new Error("generatedAt must be a finite number");
  const generatedAtIso = isoFromMillis(generatedAt);
  if (generatedAtIso === null) throw new Error("generatedAt must be a valid timestamp");
  if (!Array.isArray(root.reports)) throw new Error("reports must be an array");

  const accountOrdinals = new Map<string, number>();
  return {
    generatedAt: generatedAtIso,
    reports: root.reports.map((report) => normalizeReport(report, accountOrdinals)),
    accountsWithoutUsage: Array.isArray(root.accountsWithoutUsage)
      ? root.accountsWithoutUsage.map(normalizeUnavailableAccount)
      : [],
    disabledCredentials: Array.isArray(root.disabledCredentials)
      ? root.disabledCredentials.map(normalizeDisabledCredential)
      : [],
  };
}
function normalizeModelCost(value: unknown): UsageModelCost | null {
  const cost = objectValue(value);
  if (!cost) return null;
  return {
    input: finiteNumber(cost.input),
    output: finiteNumber(cost.output),
    cacheRead: finiteNumber(cost.cacheRead),
    cacheWrite: finiteNumber(cost.cacheWrite),
  };
}

function normalizeModel(value: unknown): UsageModelLimit {
  const model = objectValue(value);
  return {
    provider: stringOrUnknown(model?.provider),
    id: stringOrUnknown(model?.id),
    name: stringOrUnknown(model?.name),
    contextWindow: finiteNumber(model?.contextWindow),
    maxTokens: finiteNumber(model?.maxTokens),
    cost: normalizeModelCost(model?.cost),
  };
}

export function normalizeModelCatalog(input: unknown): UsageModelLimit[] {
  const root = objectValue(input);
  if (!root || !Array.isArray(root.models)) throw new Error("models must be an array");
  return root.models.map(normalizeModel);
}

function normalizeCliProvider(input: unknown, provider: string): CliProviderUsage {
  const root = objectValue(input);
  if (!root) throw new Error("provider usage output must be an object");
  const reports = Array.isArray(root.reports) ? root.reports.length : 0;
  const accounts = Array.isArray(root.accountsWithoutUsage)
    ? root.accountsWithoutUsage.filter((account) => objectValue(account)?.provider === provider).length
    : 0;
  return {
    provider,
    status: reports > 0 ? "reported" : accounts > 0 ? "no-usage-data" : "not-configured",
    accounts: reports + accounts,
    reports,
    error: null,
  };
}


export interface UsageMonitorOptions {
  runner: Pick<CommandRunner, "run">;
  intervalMs: number;
  timeoutMs: number;
  now?: () => Date;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface UsageMonitor {
  current(): UsageResponse;
  refreshOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

class SafeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeUsageError";
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}

function commandExitCode(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /^(?:usage|model catalog) command exited with code (-?\d+)$/.exec(error.message);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : null;
}

function safeCommandError(error: unknown, label: string, timeoutMs: number): SafeUsageError {
  if (error instanceof SafeUsageError) return error;
  const exitCode = commandExitCode(error);
  if (exitCode !== null) return new SafeUsageError(`${label} command exited with code ${exitCode}`);
  if (isTimeoutError(error)) return new SafeUsageError(`${label} command timed out after ${timeoutMs}ms`);
  return new SafeUsageError(`${label} command failed`);
}

function noUsageData(provider: string): CliProviderUsage {
  return { provider, status: "no-usage-data", accounts: 0, reports: 0, error: null };
}

function providerError(provider: string, error: string): CliProviderUsage {
  return { provider, status: "error", accounts: 0, reports: 0, error };
}

function isNoUsageOutput(value: string): boolean {
  return /no usage data|without a usage endpoint/i.test(value);
}

async function runJsonCommand(
  runner: Pick<CommandRunner, "run">,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  let result;
  try {
    result = await runner.run(args, timeoutMs);
  } catch (error) {
    throw safeCommandError(error, label, timeoutMs);
  }
  if (result.exitCode !== 0) throw new SafeUsageError(`${label} command exited with code ${result.exitCode}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new SafeUsageError(`${label} output is not valid JSON`);
  }
}

async function readCliProvider(
  runner: Pick<CommandRunner, "run">,
  provider: string,
  timeoutMs: number,
): Promise<CliProviderUsage> {
  const args = ["omp", "usage", "--provider", provider, "--json", "--redact"];
  let result;
  try {
    result = await runner.run(args, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return isNoUsageOutput(message)
      ? noUsageData(provider)
      : providerError(provider, safeCommandError(error, "provider usage", timeoutMs).message);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0) {
    return isNoUsageOutput(output)
      ? noUsageData(provider)
      : providerError(provider, `provider usage command exited with code ${result.exitCode}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return providerError(provider, "provider usage output is not valid JSON");
  }
  try {
    return normalizeCliProvider(parsed, provider);
  } catch {
    return providerError(provider, "provider usage output has invalid shape");
  }
}

export function createUsageMonitor(options: UsageMonitorOptions): UsageMonitor {
  const now = options.now ?? (() => new Date());
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let response: UsageResponse = {
    status: "unknown",
    snapshot: null,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    nextRefreshAt: null,
    error: null,
    cliProviders: [],
    models: { status: "unknown", fetchedAt: null, models: [], error: null },
  };
  let active: Promise<void> | null = null;
  let timer: unknown = null;
  let running = false;

  const scheduleNext = (): void => {
    if (!running || timer !== null) return;
    response = {
      ...response,
      nextRefreshAt: new Date(now().getTime() + options.intervalMs).toISOString(),
    };
    timer = schedule(() => {
      timer = null;
      void refreshOnce();
    }, options.intervalMs);
  };

  const refreshOnce = (): Promise<void> => {
    if (active) return active;

    const attemptAt = now().toISOString();
    response = { ...response, lastAttemptAt: attemptAt };
    const attempt = (async () => {
      const usagePromise = runJsonCommand(options.runner, COMMAND.slice(), options.timeoutMs, "usage");
      const modelPromise = runJsonCommand(options.runner, MODEL_COMMAND.slice(), options.timeoutMs, "model catalog");
      const providersPromise = Promise.all(
        CLI_PROVIDERS.map((provider) => readCliProvider(options.runner, provider, options.timeoutMs)),
      );
      const [usageResult, modelResult, providersResult] = await Promise.allSettled([
        usagePromise,
        modelPromise,
        providersPromise,
      ]);

      let models: UsageModelCatalog;
      if (modelResult.status === "fulfilled") {
        try {
          models = {
            status: "ok",
            fetchedAt: attemptAt,
            models: normalizeModelCatalog(modelResult.value),
            error: null,
          };
        } catch {
          models = {
            status: response.models.models.length ? "stale" : "unknown",
            fetchedAt: response.models.fetchedAt,
            models: response.models.models,
            error: "model catalog output has invalid shape",
          };
        }
      } else {
        models = {
          status: response.models.models.length ? "stale" : "unknown",
          fetchedAt: response.models.fetchedAt,
          models: response.models.models,
          error: safeCommandError(modelResult.reason, "model catalog", options.timeoutMs).message,
        };
      }

      const cliProviders = providersResult.status === "fulfilled"
        ? providersResult.value
        : CLI_PROVIDERS.map((provider) => providerError(provider, "provider usage command failed"));

      let snapshot: UsageSnapshot | null = null;
      let usageError: SafeUsageError | null = null;
      if (usageResult.status === "fulfilled") {
        try {
          snapshot = normalizeUsageSnapshot(usageResult.value);
        } catch {
          usageError = new SafeUsageError("usage output has invalid shape");
        }
      } else {
        usageError = safeCommandError(usageResult.reason, "usage", options.timeoutMs);
      }

      const nextRefreshAt = response.nextRefreshAt;
      if (snapshot) {
        response = {
          status: "ok",
          snapshot,
          lastAttemptAt: attemptAt,
          lastSuccessfulAt: now().toISOString(),
          nextRefreshAt,
          error: null,
          cliProviders,
          models,
        };
      } else {
        response = {
          status: response.snapshot ? "stale" : "unknown",
          snapshot: response.snapshot,
          lastAttemptAt: attemptAt,
          lastSuccessfulAt: response.lastSuccessfulAt,
          nextRefreshAt,
          error: usageError?.message || "usage command failed",
          cliProviders,
          models,
        };
      }
    })().finally(() => {
      active = null;
      scheduleNext();
    });
    active = attempt;
    return attempt;
  };

  return {
    current() {
      return response;
    },

    refreshOnce,

    start() {
      if (running) return;
      running = true;
      void refreshOnce();
    },

    async stop() {
      running = false;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (active) await active;
    },
  };
}
