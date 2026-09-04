import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  EventRecord,
  HealthSnapshot,
  HistoryPoint,
  HistoryResponse,
} from "./types.ts";
import { publicEvent, publicSnapshot } from "./privacy.ts";

interface SampleRow {
  observed_at: number;
  available_bytes: number;
  swap_used_bytes: number;
  cgroup_current_bytes: number;
  oom_kill_count: number;
  omp_count: number;
  tmp_used_bytes: number;
}

interface CurrentSampleRow {
  payload_json: string;
}

const HISTORY_SAMPLE_QUERY =
  "SELECT observed_at, available_bytes, swap_used_bytes, cgroup_current_bytes, oom_kill_count, omp_count, tmp_used_bytes FROM samples WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at ASC";

interface EventRow {
  observed_at: number;
  severity: EventRecord["severity"];
  kind: EventRecord["kind"];
  session_name: string | null;
  message: string;
  details_json: string;
}

export interface Storage {
  insertSnapshot(snapshot: HealthSnapshot): void;
  insertEvents(events: EventRecord[]): void;
  current(): HealthSnapshot | null;
  history(from: Date, to: Date): HistoryResponse;
  events(from: Date, to: Date): EventRecord[];
  prune(before: Date): void;
  close(): void;
}

function timestamp(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function ensureDatabaseDirectory(databasePath: string): void {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function migrate(database: Database): void {
  database.exec(`
    PRAGMA busy_timeout = 2000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS samples (
      observed_at INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      available_bytes INTEGER NOT NULL,
      swap_used_bytes INTEGER NOT NULL,
      cgroup_current_bytes INTEGER NOT NULL,
      oom_kill_count INTEGER NOT NULL,
      omp_count INTEGER NOT NULL,
      tmp_used_bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_samples (
      observed_at INTEGER NOT NULL,
      session_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      omp_state TEXT NOT NULL,
      aggregate_rss_bytes INTEGER NOT NULL,
      oom_kill_count INTEGER,
      PRIMARY KEY (observed_at, session_name)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at INTEGER NOT NULL,
      severity TEXT NOT NULL,
      kind TEXT NOT NULL,
      session_name TEXT,
      message TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS samples_observed_at_idx ON samples(observed_at);
    CREATE INDEX IF NOT EXISTS session_samples_observed_at_idx ON session_samples(observed_at);
    CREATE INDEX IF NOT EXISTS events_observed_at_idx ON events(observed_at);
  `);
}

function numericStats(values: number[]): { last: number; min: number; max: number } {
  const last = values[values.length - 1]!;
  return {
    last,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function buildHistoryPoint(observedAt: string, rows: SampleRow[]): HistoryPoint {
  const available = numericStats(rows.map((row) => row.available_bytes));
  const swapUsed = numericStats(rows.map((row) => row.swap_used_bytes));
  const cgroupCurrent = numericStats(rows.map((row) => row.cgroup_current_bytes));
  const oomKill = numericStats(rows.map((row) => row.oom_kill_count));
  const ompCount = numericStats(rows.map((row) => row.omp_count));
  const tmpUsed = numericStats(rows.map((row) => row.tmp_used_bytes));

  return {
    observedAt,
    availableBytes: available.last,
    availableMinBytes: available.min,
    availableMaxBytes: available.max,
    swapUsedBytes: swapUsed.last,
    swapUsedMinBytes: swapUsed.min,
    swapUsedMaxBytes: swapUsed.max,
    cgroupCurrentBytes: cgroupCurrent.last,
    cgroupCurrentMinBytes: cgroupCurrent.min,
    cgroupCurrentMaxBytes: cgroupCurrent.max,
    oomKillCount: oomKill.last,
    oomKillMin: oomKill.min,
    oomKillMax: oomKill.max,
    ompCount: ompCount.last,
    ompCountMin: ompCount.min,
    ompCountMax: ompCount.max,
    tmpUsedBytes: tmpUsed.last,
    tmpUsedMinBytes: tmpUsed.min,
    tmpUsedMaxBytes: tmpUsed.max,
    sampleCount: rows.length,
  };
}

function aggregateRows(rows: SampleRow[]): HistoryPoint[] {
  const bucketMs = 5 * 60 * 1000;
  const buckets = new Map<number, SampleRow[]>();
  for (const row of rows) {
    const bucket = Math.floor(row.observed_at / bucketMs) * bucketMs;
    const group = buckets.get(bucket) || [];
    group.push(row);
    buckets.set(bucket, group);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, group]) => buildHistoryPoint(iso(bucket), group));
}

export function createStorage(databasePath: string): Storage {
  ensureDatabaseDirectory(databasePath);
  const database = new Database(databasePath, { create: true, strict: true });
  migrate(database);

  const insertSample = database.prepare(`
    INSERT OR REPLACE INTO samples (
      observed_at, payload_json, available_bytes, swap_used_bytes,
      cgroup_current_bytes, oom_kill_count, omp_count, tmp_used_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT OR REPLACE INTO session_samples (
      observed_at, session_name, payload_json, omp_state,
      aggregate_rss_bytes, oom_kill_count
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO events (
      observed_at, severity, kind, session_name, message, details_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  return {
    insertSnapshot(snapshot) {
      const safeSnapshot = publicSnapshot(snapshot);
      const observedAt = timestamp(safeSnapshot.observedAt);
      const transaction = database.transaction(() => {
        insertSample.run(
          observedAt,
          JSON.stringify(safeSnapshot),
          safeSnapshot.host.availableBytes,
          safeSnapshot.host.swapUsedBytes,
          safeSnapshot.host.cgroupCurrentBytes,
          safeSnapshot.host.oomKillCount,
          safeSnapshot.ompCount,
          safeSnapshot.host.tmpUsedBytes,
        );
        for (const session of safeSnapshot.sessions) {
          const aggregateRssBytes = session.processes.reduce((sum, process) => sum + process.rssBytes, 0);
          insertSession.run(
            observedAt,
            session.name,
            JSON.stringify(session),
            session.ompState,
            aggregateRssBytes,
            session.cgroupOomKillCount,
          );
        }
      });
      transaction();
    },

    insertEvents(events) {
      const safeEvents = events.map(publicEvent);
      const transaction = database.transaction(() => {
        for (const event of safeEvents) {
          insertEvent.run(
            timestamp(event.observedAt),
            event.severity,
            event.kind,
            event.session,
            event.message,
            JSON.stringify(event.details),
          );
        }
      });
      transaction();
    },

    current() {
      const row = database.query<CurrentSampleRow, []>(
        "SELECT payload_json FROM samples ORDER BY observed_at DESC LIMIT 1",
      ).get();
      return row ? JSON.parse(row.payload_json) as HealthSnapshot : null;
    },

    history(from, to) {
      const fromMs = timestamp(from);
      const toMs = timestamp(to);
      const rows = database.query<SampleRow, [number, number]>(
        HISTORY_SAMPLE_QUERY,
      ).all(fromMs, toMs);
      const oneHourMs = 60 * 60 * 1000;
      const points = toMs - fromMs > oneHourMs
        ? [
            ...aggregateRows(rows.filter((row) => row.observed_at < toMs - oneHourMs)),
            ...rows
              .filter((row) => row.observed_at >= toMs - oneHourMs)
              .map((row) => buildHistoryPoint(iso(row.observed_at), [row])),
          ]
        : rows.map((row) => buildHistoryPoint(iso(row.observed_at), [row]));
      return { from: from.toISOString(), to: to.toISOString(), points };
    },

    events(from, to) {
      const rows = database.query<EventRow, [number, number]>(
        "SELECT observed_at, severity, kind, session_name, message, details_json FROM events WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC",
      ).all(timestamp(from), timestamp(to));
      return rows.map((row) => ({
        observedAt: iso(row.observed_at),
        severity: row.severity,
        kind: row.kind,
        session: row.session_name,
        message: row.message,
        details: JSON.parse(row.details_json) as EventRecord["details"],
      }));
    },

    prune(before) {
      const cutoff = timestamp(before);
      const transaction = database.transaction(() => {
        database.run("DELETE FROM samples WHERE observed_at < ?", [cutoff]);
        database.run("DELETE FROM session_samples WHERE observed_at < ?", [cutoff]);
        database.run("DELETE FROM events WHERE observed_at < ?", [cutoff]);
      });
      transaction();
    },

    close() {
      database.close();
    },
  };
}
