import { join } from "node:path";
import type { MemoryCleanupController } from "./memory-cleanup.ts";
import { MemoryCleanupError } from "./memory-cleanup.ts";
import type { CleanupResult } from "./memory-helper.ts";
import type { Storage } from "./storage.ts";
import type { UsageMonitor } from "./usage.ts";
import type { CurrentResponse, EventRecord, HealthResponse, HistoryResponse, UsageResponse } from "./types.ts";

export interface HttpOptions {
  storage: Storage;
  now?: () => Date;
  host?: string;
  port?: number;
  webRoot?: string;
  assets?: Record<string, string>;
  dashboardOrigin?: string;
  memoryCleanup?: MemoryCleanupController;
  usage?: Pick<UsageMonitor, "current">;
}

const ASSET_TYPES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/logic.js": "text/javascript; charset=utf-8",
};
const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};
const EMPTY_USAGE_RESPONSE: UsageResponse = {
  status: "unknown",
  snapshot: null,
  lastAttemptAt: null,
  lastSuccessfulAt: null,
  nextRefreshAt: null,
  error: "usage monitor unavailable",
  cliProviders: [],
  models: { status: "unknown", fetchedAt: null, models: [], error: null },
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function textResponse(value: string, contentType: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

function cleanupResultResponse(result: CleanupResult): Response {
  return jsonResponse(result, result.status === "failed" ? 500 : 200);
}

function cleanupErrorResponse(error: unknown): Response {
  const status = error instanceof MemoryCleanupError ? error.statusCode : 500;
  const code = error instanceof MemoryCleanupError ? error.code : "cleanup_failed";
  return jsonResponse({ status: "error", code, error: error instanceof Error ? error.message : String(error) }, status);
}

function rangeFromRequest(request: Request, now: Date): { from: Date; to: Date } {
  const url = new URL(request.url);
  const range = RANGE_MS[url.searchParams.get("range") || "24h"] || RANGE_MS["24h"]!;
  return { from: new Date(now.getTime() - range), to: now };
}

function currentHealth(storage: Storage, now: Date): HealthResponse {
  try {
    const snapshot = storage.current();
    if (!snapshot) {
      return { status: "degraded", observedAt: null, database: "ok", collector: "error", error: "no snapshot available" };
    }
    const ageMs = now.getTime() - Date.parse(snapshot.observedAt);
    const collector = ageMs <= 15_000 ? "ok" : "stale";
    return {
      status: collector === "ok" ? "ok" : "degraded",
      observedAt: snapshot.observedAt,
      database: "ok",
      collector,
      error: collector === "ok" ? null : `last snapshot is ${Math.round(ageMs / 1000)}s old`,
    };
  } catch (error) {
    return {
      status: "degraded",
      observedAt: null,
      database: "error",
      collector: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function staticAsset(path: string, options: HttpOptions): Promise<Response> {
  const contentType = ASSET_TYPES[path];
  if (!contentType) return textResponse("Not found", "text/plain; charset=utf-8", 404);
  if (options.assets && path in options.assets) return textResponse(options.assets[path]!, contentType);
  const webRoot = options.webRoot || join(import.meta.dir, "../web");
  const filePath = path === "/" ? join(webRoot, "index.html") : join(webRoot, path.slice(1));
  const file = Bun.file(filePath);
  if (!(await file.exists())) return textResponse("Not found", "text/plain; charset=utf-8", 404);
  return new Response(file, { headers: { "content-type": contentType, "cache-control": "no-store" } });
}

export function createRequestHandler(options: HttpOptions): (request: Request) => Promise<Response> {
  const now = options.now || (() => new Date());

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/maintenance") {
      if (request.method !== "GET") return textResponse("Method Not Allowed", "text/plain; charset=utf-8", 405);
      if (!options.memoryCleanup) return jsonResponse({ status: "error", code: "privileged_helper_unavailable", error: "memory cleanup is unavailable" }, 503);
      try {
        return jsonResponse(await options.memoryCleanup.status());
      } catch (error) {
        return cleanupErrorResponse(error);
      }
    }
    if (url.pathname === "/api/memory/cleanup") {
      if (request.method !== "POST") return textResponse("Method Not Allowed", "text/plain; charset=utf-8", 405);
      if (request.headers.get("origin") !== options.dashboardOrigin) return textResponse("Forbidden", "text/plain; charset=utf-8", 403);
      if (request.body !== null) return textResponse("Request body is not allowed", "text/plain; charset=utf-8", 400);
      if (!options.memoryCleanup) return jsonResponse({ status: "error", error: "memory cleanup is unavailable" }, 503);
      try {
        return cleanupResultResponse(await options.memoryCleanup.run());
      } catch (error) {
        return cleanupErrorResponse(error);
      }
    }
    if (request.method !== "GET") return textResponse("Method Not Allowed", "text/plain; charset=utf-8", 405);
    if (url.pathname === "/api/usage") {
      const response: UsageResponse = options.usage?.current() || EMPTY_USAGE_RESPONSE;
      return jsonResponse(response);
    }

    const currentNow = now();
    if (url.pathname === "/healthz") return jsonResponse(currentHealth(options.storage, currentNow));

    if (url.pathname === "/api/current") {
      const response: CurrentResponse = {
        snapshot: options.storage.current(),
        events: options.storage.events(new Date(currentNow.getTime() - 60 * 60 * 1000), currentNow),
      };
      return jsonResponse(response);
    }

    if (url.pathname === "/api/history") {
      const { from, to } = rangeFromRequest(request, currentNow);
      const response: HistoryResponse = options.storage.history(from, to);
      return jsonResponse(response);
    }

    if (url.pathname === "/api/events") {
      const { from, to } = rangeFromRequest(request, currentNow);
      const events: EventRecord[] = options.storage.events(from, to);
      return jsonResponse(events);
    }

    return staticAsset(url.pathname, options);
  };
}

export function createHttpServer(options: HttpOptions): ReturnType<typeof Bun.serve> {
  const handler = createRequestHandler(options);
  return Bun.serve({
    hostname: options.host || "127.0.0.1",
    port: options.port ?? 3848,
    fetch: handler,
  });
}
