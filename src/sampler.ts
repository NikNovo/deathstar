import type { Clock } from "./clock.ts";
import type { AutomaticCleanupController } from "./auto-cleanup.ts";
import type { Collector } from "./collector.ts";
import type { Storage } from "./storage.ts";
import type { EventRecord } from "./types.ts";

export interface SamplerOptions {
  clock: Clock;
  intervalMs: number;
  retentionMs: number;
  storage: Storage;
  collector: Pick<Collector, "collect">;
  automaticCleanup?: Pick<AutomaticCleanupController, "observe">;
}

export interface Sampler {
  start(): void;
  stop(): Promise<void>;
  sampleOnce(): Promise<void>;
}

function sourceErrorEvent(clock: Clock, error: unknown): EventRecord {
  const message = error instanceof Error ? error.message : String(error);
  return {
    observedAt: clock.now().toISOString(),
    severity: "critical",
    kind: "source-error",
    session: null,
    message: "Health source collection failed",
    details: { error: message },
  };
}

export function createSampler(options: SamplerOptions): Sampler {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let lastPrunedAt = 0;

  const sampleOnce = async (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      try {
        const result = await options.collector.collect();
        options.storage.insertSnapshot(result.snapshot);
        options.storage.insertEvents(result.events);
        if (options.automaticCleanup) {
          const cleanupEvents = await options.automaticCleanup.observe(result.snapshot);
          options.storage.insertEvents(cleanupEvents);
        }
        const now = options.clock.now().getTime();
        if (now - lastPrunedAt >= 60_000) {
          options.storage.prune(new Date(now - options.retentionMs));
          lastPrunedAt = now;
        }
      } catch (error) {
        options.storage.insertEvents([sourceErrorEvent(options.clock, error)]);
      } finally {
        active = null;
      }
    })();
    return active;
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(async () => {
      await sampleOnce();
      schedule();
    }, options.intervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      void sampleOnce().finally(schedule);
    },

    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active) await active;
    },

    sampleOnce,
  };
}
