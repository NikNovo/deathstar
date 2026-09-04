export function formatDateValue(value) {
  if (!value) return "unknown";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "unknown";
}

export function formatAgeValue(value, nowMs = Date.now()) {
  if (!value) return "unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs)) return "unknown";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

export function resourceStatus(used, total, warningThreshold) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0) return "unknown";
  const ratio = used / total;
  if (!Number.isFinite(ratio)) return "unknown";
  if (ratio >= 1) return "critical";
  if (ratio >= warningThreshold) return "warning";
  return "ok";
}

export function parseCleanupResult(body, responseOk, responseStatus) {
  if (body && typeof body === "object" && typeof body.status === "string") {
    return {
      ok: responseOk && body.status !== "failed",
      result: body,
    };
  }
  const message = body && typeof body.error === "string" && body.error
    ? body.error
    : `/api/memory/cleanup: HTTP ${responseStatus}`;
  return { ok: false, error: message };
}

export function chartValue(value, divisor = 1) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  if (!Number.isFinite(divisor) || divisor <= 0) return null;
  const normalized = value / divisor;
  return Number.isFinite(normalized) ? normalized : null;
}

export function catalogState(catalog) {
  const status = catalog?.status;
  if (status === "error") return "critical";
  if (status === "stale" || status === "warning") return "warning";
  if (status === "ok" || status === "current") return "ok";
  return "unknown";
}
