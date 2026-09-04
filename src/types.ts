export type HealthState = "ok" | "warning" | "critical" | "unknown";
export type OmpState = "working" | "idle" | "missing" | "unknown";
export interface PressureWindow {
  avg10: number;
  avg60: number;
  avg300: number;
  total: number;
}

export interface MemoryPressure {
  some: PressureWindow;
  full: PressureWindow;
}

export interface AppConfig {
  host: string;
  port: number;
  sampleIntervalMs: number;
  usageIntervalMs: number;
  usageCommandTimeoutMs: number;
  retentionMs: number;
  databasePath: string;
  herdrBinary: string;
  commandTimeoutMs: number;
  warningAvailableBytes: number;
  criticalAvailableBytes: number;
  warningSwapRatio: number;
  dashboardOrigin: string;
  memoryHelperPath: string;
  memoryCleanupTimeoutMs: number;
  memoryCleanupCooldownMs: number;
  stateConfirmSamples: number;
  stateRecoveryConfirmSamples: number;
  memoryGrowthBytes: number;
  memoryGrowthWindowMs: number;
  autoCleanupMode: "off" | "cache";
  autoCleanupCooldownMs: number;
}

export interface HostSnapshot {
  observedAt: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  freeBytes: number;
  cacheBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  load1: number;
  load5: number;
  load15: number;
  rootUsedBytes: number;
  rootTotalBytes: number;
  tmpUsedBytes: number;
  tmpTotalBytes: number;
  cgroupCurrentBytes: number;
  cgroupLimitBytes: number | null;
  oomKillCount: number;
  memoryPressure: MemoryPressure;
  state: HealthState;
  errors: string[];
}

export interface ProcessSnapshot {
  pid: number;
  ppid: number | null;
  command: string;
  cwd: string | null;
  rssBytes: number;
  virtualBytes: number;
  state: string | null;
  startedAt: string | null;
}

export interface SessionSnapshot {
  name: string;
  status: "running" | "stopped" | "unknown";
  directory: string | null;
  paneId: string | null;
  agentStatus: string | null;
  ompPid: number | null;
  cgroupShared: boolean;
  ompState: OmpState;
  processes: ProcessSnapshot[];
  cgroupPath: string | null;
  cgroupCurrentBytes: number | null;
  cgroupPeakBytes: number | null;
  cgroupOomKillCount: number | null;
  observedAt: string;
  error: string | null;
}

export interface HealthSnapshot {
  observedAt: string;
  host: HostSnapshot;
  sessions: SessionSnapshot[];
  ompCount: number;
  herdrSessionCount: number;
  collectorErrors: string[];
}

export interface EventRecord {
  observedAt: string;
  severity: "info" | "warning" | "critical";
  kind: "omp-exited" | "omp-restarted" | "oom-increased" | "source-error" | "threshold" | "memory-growth" | "cleanup-unavailable" | "cleanup-auto";
  session: string | null;
  message: string;
  details: Record<string, string | number | boolean | null>;
}

export interface HistoryPoint {
  observedAt: string;
  availableBytes: number;
  availableMinBytes: number;
  availableMaxBytes: number;
  swapUsedBytes: number;
  swapUsedMinBytes: number;
  swapUsedMaxBytes: number;
  cgroupCurrentBytes: number;
  cgroupCurrentMinBytes: number;
  cgroupCurrentMaxBytes: number;
  oomKillCount: number;
  oomKillMin: number;
  oomKillMax: number;
  ompCount: number;
  ompCountMin: number;
  ompCountMax: number;
  tmpUsedBytes: number;
  tmpUsedMinBytes: number;
  tmpUsedMaxBytes: number;
  sampleCount: number;
}

export interface HistoryResponse {
  from: string;
  to: string;
  points: HistoryPoint[];
}

export interface CurrentResponse {
  snapshot: HealthSnapshot | null;
  events: EventRecord[];
}

export interface HealthResponse {
  status: "ok" | "degraded";
  observedAt: string | null;
  database: "ok" | "error";
  collector: "ok" | "stale" | "error";
  error: string | null;
}
export type UsageStatus = "ok" | "warning" | "critical" | "unknown" | "exhausted";

export interface UsageAmount {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: string | null;
}

export interface UsageWindow {
  id: string;
  label: string;
  resetsAt: string | null;
}

export interface UsageLimit {
  id: string;
  label: string;
  amount: UsageAmount;
  window: UsageWindow | null;
  status: UsageStatus;
}

export interface UsageResetCredit {
  grantedAt: string | null;
  expiresAt: string | null;
  status: string;
}

export interface UsageResetCredits {
  availableCount: number;
  credits: UsageResetCredit[];
}

export interface UsageReport {
  provider: string;
  accountLabel: string;
  plan: string | null;
  fetchedAt: string | null;
  limits: UsageLimit[];
  resetCredits: UsageResetCredits | null;
}

export interface UsageUnavailableAccount {
  provider: string;
  type: string;
}

export interface UsageDisabledCredential {
  provider: string;
  status: string;
}

export interface UsageSnapshot {
  generatedAt: string;
  reports: UsageReport[];
  accountsWithoutUsage: UsageUnavailableAccount[];
  disabledCredentials: UsageDisabledCredential[];
}

export type CliProviderUsageStatus = "reported" | "no-usage-data" | "not-configured" | "error";

export interface CliProviderUsage {
  provider: string;
  status: CliProviderUsageStatus;
  accounts: number;
  reports: number;
  error: string | null;
}

export interface UsageModelCost {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface UsageModelLimit {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  cost: UsageModelCost | null;
}

export type UsageModelCatalogStatus = "ok" | "stale" | "unknown";

export interface UsageModelCatalog {
  status: UsageModelCatalogStatus;
  fetchedAt: string | null;
  models: UsageModelLimit[];
  error: string | null;
}

export interface UsageResponse {
  status: "ok" | "stale" | "unknown";
  snapshot: UsageSnapshot | null;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
  cliProviders: CliProviderUsage[];
  models: UsageModelCatalog;
}
