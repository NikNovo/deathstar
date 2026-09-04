import {
  catalogState,
  chartValue,
  formatAgeValue,
  formatDateValue,
  parseCleanupResult,
  resourceStatus,
} from "./logic.js";

const state = {
  snapshot: null,
  maintenance: null,
  cleanupResult: null,
  cleanupMessage: null,
  cleanupBusy: false,
  events: [],
  history: { points: [] },
  sourceErrors: {
    current: null,
    history: null,
    usage: null,
    health: null,
    maintenance: null,
  },
  loading: {
    current: false,
    history: false,
    usage: false,
  },
  usage: {
    status: "unknown",
    snapshot: null,
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    nextRefreshAt: null,
    error: null,
    cliProviders: [],
    models: { status: "unknown", fetchedAt: null, models: [], error: null },
  },
  modelDialog: { provider: "", models: [] },
  modelDialogTrigger: null,
  lastCardStatus: null,
  lastErrorSignature: null,
};

const CLI_PROVIDER_IDS = new Set(["perplexity", "tavily", "meta"]);
const USAGE_REFRESH_MS = 60 * 60 * 1000; // 3600000 ms
const CHART_MEMORY_DIVISOR = 1024 ** 3;
const requestState = new Map();

const root = document;
const byId = (id) => root.getElementById(id);
function usageStatusClass(status) {
  if (status === "critical" || status === "exhausted") return "critical";
  if (status === "warning" || status === "stale") return "warning";
  if (status === "unknown") return "unknown";
  if (status === "ok") return "ok";
  return "unknown";
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unknown";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let number = value;
  let unit = -1;
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024;
    unit += 1;
  }
  return `${number.toFixed(number >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value) {
  return formatDateValue(value);
}

function formatAge(value) {
  return formatAgeValue(value);
}

function statusClass(status) {
  if (status === "critical" || status === "missing") return "critical";
  if (status === "warning" || status === "stale") return "warning";
  if (status === "unknown") return "unknown";
  if (status === "working" || status === "idle") return "ok";
  if (status === "ok") return "ok";
  return "unknown";
}

function statusLabel(status) {
  if (status === "critical") return "Critical";
  if (status === "warning") return "Warning";
  if (status === "stale") return "Stale";
  if (status === "unknown") return "Unknown";
  return "OK";
}

function formatFixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "unknown";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function createText(tag, text, className = "") {
  const element = root.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function beginRequest(key) {
  requestState.get(key)?.controller.abort();
  const request = { controller: new AbortController() };
  requestState.set(key, request);
  return request;
}

function isCurrentRequest(key, request) {
  return requestState.get(key) === request;
}
function renderPreservingFocus(render) {
  const focusedId = root.activeElement?.id;
  render();
  if (focusedId) byId(focusedId)?.focus();
}


function createRetryButton(label) {
  const button = root.createElement("button");
  button.type = "button";
  button.className = "inline-retry";
  button.textContent = label;
  button.addEventListener("click", refresh);
  return button;
}

function appendStateMessage(container, message, { error = false, retry = false } = {}) {
  container.append(createText("p", message, error ? "empty state-error" : "empty"));
  if (retry) container.append(createRetryButton("Retry"));
}
function appendTableStateMessage(body, message, { error = false, retry = false } = {}) {
  const row = root.createElement("tr");
  const cell = root.createElement("td");
  cell.colSpan = 7;
  cell.append(createText("span", message, error ? "empty state-error" : "empty"));
  if (retry) cell.append(createRetryButton("Retry"));
  row.append(cell);
  body.append(row);
}

function createRelativeTime(value) {
  const time = root.createElement("time");
  const timestamp = Date.parse(value || "");
  if (Number.isFinite(timestamp)) time.dateTime = value;
  time.textContent = formatAge(value);
  return time;
}

function createAbsoluteTime(value) {
  const time = root.createElement("time");
  const timestamp = Date.parse(value || "");
  if (Number.isFinite(timestamp)) time.dateTime = value;
  time.textContent = formatDate(value);
  return time;
}
function formatRemaining(amount) {
  if (!amount || amount.remaining === null || !Number.isFinite(amount.remaining)) return "unknown";
  if (amount.unit === "usd") return `$${amount.remaining.toFixed(2)}`;
  if (amount.unit === "percent") return `${amount.remaining.toFixed(0)}%`;
  return `${amount.remaining} ${amount.unit || "units"}`;
}

function formatCountdown(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) return "resets —";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "resets —";
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "resets now";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function usageReportStatus(report) {
  const limits = Array.isArray(report?.limits) ? report.limits : [];
  if (!limits.length) return "unknown";
  const statuses = limits.map((limit) => limit.status);
  if (statuses.some((status) => status === "critical" || status === "exhausted")) return "critical";
  if (statuses.some((status) => status !== "ok")) return "warning";
  return "ok";
}
function cleanupStatusClass(status) {
  if (status === "failed") return "critical";
  if (status === "partial") return "warning";
  if (status === "ok") return "ok";
  return "unknown";
}

function latestCleanup(maintenance) {
  const maintenanceCleanup = maintenance?.lastCleanup;
  const localCleanup = state.cleanupResult;
  if (!localCleanup?.completedAt) return maintenanceCleanup || null;
  if (!maintenanceCleanup?.completedAt) return localCleanup;
  const localTime = Date.parse(localCleanup.completedAt);
  const maintenanceTime = Date.parse(maintenanceCleanup.completedAt);
  if (!Number.isFinite(maintenanceTime) || (Number.isFinite(localTime) && localTime >= maintenanceTime)) return localCleanup;
  return maintenanceCleanup;
}

function cleanupAction(result, key) {
  const action = result?.actions?.[key];
  return typeof action === "string" && action ? action : "unknown";
}

function renderCleanupSummary(result) {
  const summary = byId("cleanup-summary");
  if (!summary) return;
  summary.replaceChildren();
  if (state.cleanupBusy) {
    summary.className = "cleanup-summary warning";
    summary.append(
      createText("strong", "Cleanup in progress"),
      createText("span", "Running guarded memory cleanup…"),
    );
    return;
  }
  if (!result || typeof result !== "object") {
    if (state.cleanupMessage) {
      summary.className = "cleanup-summary critical";
      summary.append(createText("strong", "Cleanup failed"), createText("span", state.cleanupMessage));
    } else {
      summary.className = "cleanup-summary";
      summary.append(createText("span", "Last cleaned: never"));
    }
    return;
  }
  const status = cleanupStatusClass(result.status);
  summary.className = `cleanup-summary ${status}`;
  const title = result.status === "partial"
    ? "Cleanup completed with swap skipped"
    : result.status === "failed"
      ? "Cleanup failed"
      : result.status === "ok"
        ? "Cleanup completed"
        : "Cleanup result unknown";
  const details = [
    `page cache: ${cleanupAction(result, "dropCaches")}`,
    `swap: ${cleanupAction(result, "swapCycle")}${result.skipReason ? ` (${result.skipReason})` : ""}`,
  ];
  if (Number.isFinite(result.before?.availableBytes) && Number.isFinite(result.after?.availableBytes)) {
    details.push(`available RAM: ${formatBytes(result.before.availableBytes)} → ${formatBytes(result.after.availableBytes)}`);
  }
  if (Number.isFinite(result.before?.swapUsedBytes) && Number.isFinite(result.after?.swapUsedBytes)) {
    details.push(`swap used: ${formatBytes(result.before.swapUsedBytes)} → ${formatBytes(result.after.swapUsedBytes)}`);
  }
  if (Number.isFinite(result.reclaimed?.availableBytes)) {
    details.push(`reclaimed RAM: ${formatBytes(result.reclaimed.availableBytes)}`);
  }
  if (Number.isFinite(result.reclaimed?.swapBytes)) {
    details.push(`reclaimed swap: ${formatBytes(result.reclaimed.swapBytes)}`);
  }
  if (Number.isFinite(result.durationMs)) details.push(`duration: ${result.durationMs} ms`);
  if (result.error) details.push(`error: ${String(result.error)}`);
  if (result.completedAt) details.push(`completed: ${formatDate(result.completedAt)}`);
  summary.append(createText("strong", title), createText("span", details.join(" · ")));
}





function createCleanupButton() {
  const button = root.createElement("button");
  button.id = "cleanup-memory";
  button.type = "button";
  button.className = "cleanup-action";
  const unavailable = state.maintenance?.ready !== true;
  const label = state.cleanupBusy
    ? "Cleaning memory and swap…"
    : unavailable
      ? "Cleanup unavailable: memory helper is not ready"
      : "Reclaim memory";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = state.cleanupBusy || state.maintenance?.ready !== true;
  const icon = root.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = root.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M20 11a8 8 0 0 0-14.9-4H3l3.5 3.5L10 7H7.4A6 6 0 1 1 6 14H4a8 8 0 1 0 16-3Z");
  icon.append(path);
  const actionLabel = createText("span", "Reclaim memory", "cleanup-action-label");
  actionLabel.id = "cleanup-action-label";
  button.append(icon, actionLabel);
  button.addEventListener("click", runMemoryCleanup);
  return button;
}


function createCleanupCard(maintenance) {
  const readiness = maintenance?.ready === true ? "ok" : "warning";
  const card = root.createElement("article");
  card.id = "cleanup-card";
  card.className = `card cleanup-card ${readiness}`;
  card.setAttribute("aria-labelledby", "cleanup-card-title");

  const heading = root.createElement("div");
  heading.className = "card-heading";
  const title = createText("p", "Reclaim memory", "card-label cleanup-card-title");
  const statusNode = createText("span", statusLabel(readiness), `pill card-status maintenance-status ${readiness}`);
  statusNode.id = "maintenance-status";
  statusNode.setAttribute("role", "status");
  statusNode.setAttribute("aria-live", "polite");
  heading.append(title, statusNode);

  const summary = root.createElement("div");
  summary.id = "cleanup-summary";
  summary.className = "cleanup-summary";
  summary.setAttribute("aria-live", "polite");
  summary.append(createText("span", "Last cleaned: never"));
  const cleanupStatus = createText("p", "", "cleanup-status");
  cleanupStatus.id = "cleanup-status";

  card.append(heading, summary, cleanupStatus, createCleanupButton());
  return card;
}

function renderCards(snapshot, maintenance = state.maintenance) {
  const container = byId("status-cards");
  container.replaceChildren();
  if (!snapshot) {
    if (state.loading.current) {
      appendStateMessage(container, "Loading live host metrics…");
    } else if (state.sourceErrors.current) {
      appendStateMessage(container, "Live host metrics unavailable.", { error: true, retry: true });
    } else {
      appendStateMessage(container, "No successful collector sample yet.");
    }
    return;
  }
  const host = snapshot.host;
  const swapStatus = resourceStatus(host.swapUsedBytes, host.swapTotalBytes, 0.5);
  const tmpStatus = resourceStatus(host.tmpUsedBytes, host.tmpTotalBytes, 0.8);
  const cards = [
    ["Available RAM", formatBytes(host.availableBytes), `${formatBytes(host.totalBytes)} total`, host.state || "unknown"],
    ["Reclaim memory", "", "", maintenance?.ready === true ? "ok" : "warning", "cleanup"],
    ["Swap", `${formatBytes(host.swapUsedBytes)} used`, `${formatBytes(host.swapTotalBytes)} total`, swapStatus],
    ["OOM kills", Number.isFinite(host.oomKillCount) ? String(host.oomKillCount) : "unknown", "aggregate cgroup counter", Number.isFinite(host.oomKillCount) ? (host.oomKillCount > 0 ? "warning" : "ok") : "unknown"],
    ["OMP", Number.isFinite(snapshot.ompCount) ? String(snapshot.ompCount) : "unknown", `${Number.isFinite(snapshot.herdrSessionCount) ? snapshot.herdrSessionCount : "unknown"} Herdr sessions`, Number.isFinite(snapshot.ompCount) ? "ok" : "unknown"],
    ["Tmpfs /tmp", formatPercent(chartValue(host.tmpUsedBytes, host.tmpTotalBytes)), `${formatBytes(host.tmpUsedBytes)} used`, tmpStatus],
    ["Load", formatFixed(host.load1), `${formatFixed(host.load5)} 5m · ${formatFixed(host.load15)} 15m`, [host.load1, host.load5, host.load15].every(Number.isFinite) ? "ok" : "unknown"],
  ].map(([label, value, detail, status, kind]) => [
    label,
    value,
    detail,
    kind === "cleanup" ? status : (state.sourceErrors.current || state.sourceErrors.health) && status === "ok" ? "stale" : status,
    kind,
  ]);
  const statusSignature = cards.map(([, , , status]) => status).join("|");
  const announcer = byId("dashboard-announcer");
  if (announcer && state.lastCardStatus && state.lastCardStatus !== statusSignature) {
    announcer.textContent = `Host health changed: ${cards.map(([label, , , status]) => `${label} ${statusLabel(status)}`).join(", ")}.`;
  }
  state.lastCardStatus = statusSignature;
  for (const [label, value, detail, status, kind] of cards) {
    if (kind === "cleanup") {
      container.append(createCleanupCard(maintenance));
      continue;
    }
    const card = root.createElement("article");
    card.className = `card ${statusClass(status)}`;
    const heading = root.createElement("div");
    heading.className = "card-heading";
    heading.append(
      createText("p", label, "card-label"),
      createText("span", statusLabel(status), `pill card-status ${statusClass(status)}`),
    );
    card.append(heading);
    card.append(createText("strong", value, "card-value"));
    const cardDetails = root.createElement("div");
    cardDetails.className = "card-details";
    cardDetails.append(createText("span", detail, "card-detail"));
    card.append(cardDetails);
    container.append(card);
  }
  const sampleLabel = state.sourceErrors.current || state.sourceErrors.health ? "Last successful sample" : "Last sample";
  byId("last-updated").textContent = `${sampleLabel}: ${formatDate(snapshot.observedAt)} (${formatAge(snapshot.observedAt)})`;
}
function ompProcess(session) {
  if (session.ompPid === null || session.ompPid === undefined) return null;
  return session.processes.find((process) => process.pid === session.ompPid) || null;
}

function renderSessions(snapshot) {
  const body = byId("session-table");
  body.replaceChildren();
  if (!snapshot) {
    if (state.loading.current) {
      appendTableStateMessage(body, "Loading live sessions…");
    } else if (state.sourceErrors.current) {
      appendTableStateMessage(body, "Live sessions unavailable.", { error: true, retry: true });
    } else {
      appendTableStateMessage(body, "No live process sample yet.");
    }
    return;
  }
  const live = snapshot.sessions.filter((session) => session.ompState !== "missing").length;
  byId("session-summary").textContent = `${live}/${snapshot.sessions.length} with OMP`;
  const sessions = [...snapshot.sessions].sort((left, right) => (ompProcess(right)?.rssBytes || 0) - (ompProcess(left)?.rssBytes || 0));
  const labels = ["Session", "State", "PID", "RSS", "Cgroup", "OOM", "Last seen"];
  for (const session of sessions) {
    const process = ompProcess(session);
    const row = root.createElement("tr");
    const statePill = createText("span", session.ompState, `pill ${statusClass(session.ompState)}`);
    const cgroup = session.cgroupCurrentBytes === null
      ? "—"
      : `${formatBytes(session.cgroupCurrentBytes)}${session.cgroupShared ? " shared" : ""}`;
    const cells = [
      session.name,
      statePill,
      process ? String(process.pid) : "—",
      process ? formatBytes(process.rssBytes) : "—",
      cgroup,
      session.cgroupOomKillCount === null ? "—" : String(session.cgroupOomKillCount),
      createRelativeTime(session.observedAt),
    ];
    for (const [index, value] of cells.entries()) {
      const cell = root.createElement("td");
      cell.dataset.label = labels[index];
      if (index === 1 || index === 6) cell.append(value);
      else cell.textContent = value;
      row.append(cell);
    }
    if (session.error) {
      row.title = session.error;
      row.setAttribute("aria-label", `${session.name}: ${session.error}`);
    }
    body.append(row);
  }
}
function renderMaintenance(maintenance) {
  const card = byId("cleanup-card");
  const statusNode = byId("maintenance-status");
  const button = byId("cleanup-memory");
  const actionLabel = byId("cleanup-action-label");
  const unavailable = maintenance?.ready !== true;
  const readiness = unavailable ? "warning" : "ok";
  if (card) card.className = `card cleanup-card ${readiness}`;
  if (statusNode) {
    statusNode.className = `pill card-status maintenance-status ${readiness}`;
    statusNode.textContent = maintenance ? statusLabel(readiness) : "Unknown";
  }
  renderCleanupSummary(latestCleanup(maintenance));
  if (!button) return;
  const label = state.cleanupBusy
    ? "Cleaning memory and swap…"
    : unavailable
      ? "Cleanup unavailable: memory helper is not ready"
      : "Reclaim memory";
  button.disabled = state.cleanupBusy || unavailable;
  button.title = label;
  button.setAttribute("aria-label", label);
  if (actionLabel) actionLabel.textContent = state.cleanupBusy ? "Cleaning…" : unavailable ? "Unavailable" : "Reclaim memory";
}

function renderTopConsumers(snapshot) {
  const container = byId("top-consumers");
  container.replaceChildren();
  if (!snapshot) {
    const message = state.loading.current
      ? "Loading foreground consumers…"
      : state.sourceErrors.current
        ? "Foreground consumers unavailable."
        : "No foreground consumer sample yet.";
    const item = createText("li", message, "empty");
    container.append(item);
    if (state.sourceErrors.current) {
      const retryItem = root.createElement("li");
      retryItem.append(createRetryButton("Retry"));
      container.append(retryItem);
    }
    return;
  }
  const consumers = snapshot.sessions
    .map((session) => ({ session, process: ompProcess(session) }))
    .filter((entry) => entry.process)
    .sort((left, right) => right.process.rssBytes - left.process.rssBytes);
  if (!consumers.length) {
    container.append(createText("li", "No foreground OMP processes.", "empty"));
    return;
  }
  for (const { session, process } of consumers) {
    const item = root.createElement("li");
    item.className = "consumer";
    item.append(
      createText("strong", session.name),
      createText("span", `PID ${process.pid} · RSS ${formatBytes(process.rssBytes)}`),
      createText("span", session.cgroupShared ? "cgroup accounting is shared" : "private process tree"),
    );
    container.append(item);
  }
}

function chartDisplayValue(value, unit) {
  if (!Number.isFinite(value)) return "—";
  if (unit === "bytes") return formatBytes(value);
  if (unit === "GiB") return `${value.toFixed(value >= 10 ? 1 : 2)} GiB`;
  if (unit === "processes") return `${value} processes`;
  return `${value} ${unit || "units"}`;
}

function createChartSvgText(text, x, y, className, anchor = "start") {
  const label = root.createElementNS("http://www.w3.org/2000/svg", "text");
  label.textContent = text;
  label.setAttribute("x", String(x));
  label.setAttribute("y", String(y));
  label.setAttribute("class", className);
  label.setAttribute("text-anchor", anchor);
  return label;
}

function renderChart(id, points, series) {
  const container = byId(id);
  container.replaceChildren();
  if (!points.length) {
    const message = state.loading.history
      ? "Loading 24-hour history…"
      : state.sourceErrors.history
        ? "History unavailable."
        : "No history yet.";
    appendStateMessage(container, message, { error: Boolean(state.sourceErrors.history), retry: Boolean(state.sourceErrors.history) });
    return;
  }
  const width = 720;
  const height = 220;
  const padding = 32;
  const valuesBySeries = series.map((item) => points.map((point) => item.read(point)));
  const values = valuesBySeries.flat().filter(Number.isFinite);
  if (!values.length) {
    appendStateMessage(container, "History has no valid measurements.");
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const svg = root.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${series.map((item) => `${item.label} in ${item.unit}`).join(" and ")} history chart`);
  svg.append(
    createChartSvgText(chartDisplayValue(max, series[0].unit), padding, 16, "chart-axis-label"),
    createChartSvgText(chartDisplayValue(min, series[0].unit), padding, height - 8, "chart-axis-label"),
  );
  for (const y of [height / 3, (height / 3) * 2]) {
    const grid = root.createElementNS("http://www.w3.org/2000/svg", "line");
    grid.setAttribute("x1", String(padding));
    grid.setAttribute("x2", String(width - padding));
    grid.setAttribute("y1", String(y));
    grid.setAttribute("y2", String(y));
    grid.setAttribute("class", "chart-gridline");
    svg.append(grid);
  }
  for (const [seriesIndex, item] of series.entries()) {
    const segments = [];
    let segment = [];
    for (const [index, value] of valuesBySeries[seriesIndex].entries()) {
      if (!Number.isFinite(value)) {
        if (segment.length) segments.push(segment);
        segment = [];
        continue;
      }
      const x = padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / span) * (height - padding * 2);
      segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    if (segment.length) segments.push(segment);
    for (const segmentPoints of segments) {
      if (segmentPoints.length < 2) continue;
      const line = root.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", segmentPoints.join(" "));
      line.setAttribute("class", `chart-line ${item.className}`);
      svg.append(line);
    }
  }
  const legend = root.createElement("div");
  legend.className = "legend";
  for (const item of series) {
    const entry = root.createElement("span");
    entry.className = "legend-entry";
    const marker = root.createElement("i");
    marker.className = `legend-marker ${item.className}`;
    entry.append(marker, createText("span", `${item.label} · ${item.unit}`));
    legend.append(entry);
  }
  const validPoints = points.filter((point) => series.some((item) => Number.isFinite(item.read(point))));
  const summary = root.createElement("p");
  summary.className = "chart-summary";
  const firstTime = validPoints[0]?.observedAt;
  const lastTime = validPoints.at(-1)?.observedAt;
  summary.textContent = `${series.map((item) => {
    const values = validPoints.map((point) => item.read(point)).filter(Number.isFinite);
    return `${item.label}: min ${chartDisplayValue(Math.min(...values), item.unit)}, max ${chartDisplayValue(Math.max(...values), item.unit)}, latest ${chartDisplayValue(values.at(-1), item.unit)}`;
  }).join(" · ")} · ${formatDate(firstTime)} — ${formatDate(lastTime)}`;
  const dataDetails = root.createElement("details");
  dataDetails.className = "chart-data";
  dataDetails.append(createText("summary", "View endpoint values"));
  const dataList = root.createElement("ul");
  for (const item of series) {
    const values = validPoints.map((point) => item.read(point)).filter(Number.isFinite);
    dataList.append(createText("li", `${item.label}: first ${chartDisplayValue(values[0], item.unit)} · latest ${chartDisplayValue(values.at(-1), item.unit)}`));
  }
  dataDetails.append(dataList);
  container.append(svg, legend, summary, dataDetails);
  if (state.sourceErrors.history) {
    container.append(createText("p", "Showing last successful history; latest refresh failed.", "empty state-error"));
  }
}

function renderHistory(history) {
  const points = Array.isArray(history?.points) ? history.points : [];
  renderChart("ram-chart", points, [
    { label: "Available RAM", unit: "bytes", className: "available", read: (point) => chartValue(point.availableBytes) },
  ]);
  renderChart("process-count-chart", points, [
    { label: "OMP count", unit: "processes", className: "omp-count", read: (point) => chartValue(point.ompCount) },
  ]);
  renderChart("process-memory-chart", points, [
    { label: "cgroup memory", unit: "GiB", className: "cgroup", read: (point) => chartValue(point.cgroupCurrentBytes, CHART_MEMORY_DIVISOR) },
  ]);
}

function renderEvents(events) {
  const container = byId("events");
  container.replaceChildren();
  byId("event-summary").textContent = `${events.length} in selected window`;
  if (!events.length) {
    container.append(createText("li", "No events recorded.", "empty"));
    return;
  }
  for (const event of events) {
    const item = root.createElement("li");
    item.className = `event ${event.severity}`;
    const header = root.createElement("div");
    header.className = "event-header";
    header.append(createText("strong", event.kind), createAbsoluteTime(event.observedAt));
    item.append(header, createText("p", event.session ? `${event.session}: ${event.message}` : event.message));
    container.append(item);
  }
}
function renderErrors() {
  const container = byId("source-errors");
  const errors = Object.entries(state.sourceErrors)
    .filter(([, error]) => error)
    .map(([source, error]) => `${source}: ${error}`);
  const errorSignature = errors.join("\n");
  if (state.lastErrorSignature === errorSignature) return;
  state.lastErrorSignature = errorSignature;
  container.replaceChildren();
  if (!errors.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.className = "source-errors warning";
  container.append(createText("strong", "Source errors"));
  for (const error of errors) container.append(createText("p", error));
}
function modelsForProvider(catalog, provider) {
  const providerKey = typeof provider === "string" ? provider.toLowerCase() : "";
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return models.filter((model) => typeof model?.provider === "string" && model.provider.toLowerCase() === providerKey);
}

function formatModelTokens(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function formatModelCostPair(first, second) {
  if (!Number.isFinite(first) && !Number.isFinite(second)) return "—";
  const amount = (value) => Number.isFinite(value) ? `$${value}` : "—";
  return `${amount(first)} / ${amount(second)}`;
}

function formatModelCost(cost) {
  return formatModelCostPair(cost?.input, cost?.output);
}

function formatModelCacheCost(cost) {
  return formatModelCostPair(cost?.cacheRead, cost?.cacheWrite);
}

function modelDisplayName(model) {
  if (typeof model?.name === "string" && model.name && model.name !== "unknown") return model.name;
  if (typeof model?.id === "string" && model.id) return model.id;
  return "Unknown model";
}
function providerDisplayName(provider) {
  const names = {
    "openai-codex": "OpenAI Codex",
    "google-antigravity": "Google Antigravity",
    "github-copilot": "GitHub Copilot",
    "xai-oauth": "xAI",
    "kimi-code": "Kimi Code",
    zai: "Z.ai",
  };
  return names[provider] || provider;
}

function appendModelDialogItem(container, model) {
  const item = root.createElement("article");
  item.className = "model-dialog-item";
  const heading = root.createElement("div");
  heading.className = "model-dialog-item-heading";
  const title = root.createElement("div");
  title.className = "model-dialog-title";
  const name = modelDisplayName(model);
  title.append(createText("strong", name));
  if (typeof model?.id === "string" && model.id && model.id !== name) {
    title.append(createText("span", model.id, "model-dialog-id"));
  }
  heading.append(title);
  const specs = root.createElement("dl");
  specs.className = "model-dialog-specs";
  for (const [label, value] of [
    ["Context", formatModelTokens(model?.contextWindow)],
    ["Max output", formatModelTokens(model?.maxTokens)],
    ["Cost in / out", formatModelCost(model?.cost)],
    ["Cache read / write", formatModelCacheCost(model?.cost)],
  ]) {
    const spec = root.createElement("div");
    spec.className = "model-dialog-spec";
    spec.append(createText("dt", label), createText("dd", value));
    specs.append(spec);
  }
  item.append(heading, specs);
  container.append(item);
}

function renderModelDialog() {
  const details = byId("model-dialog-details");
  const count = byId("model-dialog-count");
  const filter = byId("model-dialog-filter");
  if (!details) return;
  const query = filter?.value.trim().toLowerCase() || "";
  const models = state.modelDialog.models.filter((model) => {
    if (!query) return true;
    const name = modelDisplayName(model).toLowerCase();
    const id = typeof model?.id === "string" ? model.id.toLowerCase() : "";
    return name.includes(query) || id.includes(query);
  });
  details.replaceChildren();
  if (count) count.textContent = `${models.length} of ${state.modelDialog.models.length} models`;
  if (!models.length) {
    details.append(createText("p", query ? "No models match this filter." : "No model details available.", "usage-card-empty"));
  } else {
    for (const model of models) appendModelDialogItem(details, model);
  }
}

function openModelDialog(provider, models, trigger = null) {
  const dialog = byId("model-dialog");
  const title = byId("model-dialog-title");
  const filter = byId("model-dialog-filter");
  if (!dialog || !title) return;
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  state.modelDialog = { provider, models };
  state.modelDialogTrigger = trigger;
  title.textContent = `${providerDisplayName(provider)} models`;
  if (filter) filter.value = "";
  renderModelDialog();
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function restoreModelDialogFocus() {
  const modelDialogTrigger = state.modelDialogTrigger;
  state.modelDialogTrigger = null;
  if (!modelDialogTrigger) return;
  if (root.contains(modelDialogTrigger)) modelDialogTrigger?.focus();
  else byId("refresh")?.focus();
}

function closeModelDialog() {
  const dialog = byId("model-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    restoreModelDialogFocus();
  }
}


function catalogMessage(catalog) {
  const status = catalogState(catalog);
  const fetched = catalog?.fetchedAt ? ` · fetched ${formatDate(catalog.fetchedAt)}` : "";
  if (status === "critical") return `Model catalog unavailable${fetched}`;
  if (status === "warning") return `Model catalog may be stale${fetched}`;
  if (status === "ok") return `Model catalog current${fetched}`;
  return `Model catalog status unknown${fetched}`;
}

function createModelAction(provider, models, catalog) {
  const button = root.createElement("button");
  button.type = "button";
  button.className = "usage-card-models";
  button.title = `Show ${models.length} models for ${providerDisplayName(provider)}`;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "model-dialog");
  button.append(createText("span", `View ${models.length} model${models.length === 1 ? "" : "s"}`));
  button.addEventListener("click", () => openModelDialog(provider, models, button));
  if (catalogState(catalog) !== "ok") {
    button.append(createText("span", catalogMessage(catalog), "model-catalog-note"));
  }
  return button;
}

function appendModelAction(card, provider, catalog) {
  const models = modelsForProvider(catalog, provider);
  if (models.length) card.append(createModelAction(provider, models, catalog));
}

function buildUsageCard(report, catalog) {
  const provider = typeof report.provider === "string" && report.provider ? report.provider : "Unknown provider";
  const accountLabel = typeof report.accountLabel === "string" && report.accountLabel ? report.accountLabel : "Unknown account";
  const status = usageReportStatus(report);

  const card = root.createElement("article");
  card.className = `usage-card ${usageStatusClass(status)}`;

  const header = root.createElement("div");
  header.className = "usage-card-header";
  header.append(
    createText("strong", `${providerDisplayName(provider)} · ${accountLabel}`),
    createText("span", statusLabel(status), `pill ${usageStatusClass(status)}`),
  );
  card.append(header);

  const limits = Array.isArray(report.limits) ? report.limits : [];
  if (!limits.length) {
    card.append(createText("p", "No limit data", "usage-card-empty"));
    appendModelAction(card, provider, catalog);
    return card;
  }

  const rows = root.createElement("div");
  rows.className = "usage-card-rows";
  for (const limit of limits) {
    const meter = typeof limit.label === "string" && limit.label ? limit.label : "Unknown meter";
    const row = root.createElement("div");
    row.className = "usage-card-row";
    const countdown = createText("span", formatCountdown(limit.window?.resetsAt), "usage-card-countdown");
    if (limit.window?.resetsAt) countdown.dataset.resetsAt = limit.window.resetsAt;
    row.append(
      createText("span", meter, "usage-card-meter"),
      createText("strong", formatRemaining(limit.amount), "usage-card-remaining"),
      countdown,
    );
    rows.append(row);
  }
  card.append(rows);
  appendModelAction(card, provider, catalog);
  return card;
}

function buildModelCatalogCard(provider, models, catalog) {
  const status = catalogState(catalog) === "critical" ? "critical" : "unknown";
  const card = root.createElement("article");
  card.className = `usage-card ${usageStatusClass(status)}`;
  const header = root.createElement("div");
  header.className = "usage-card-header";
  header.append(
    createText("strong", providerDisplayName(provider)),
    createText("span", `${models.length} models · ${statusLabel(status)}`, `pill ${usageStatusClass(status)}`),
  );
  card.append(
    header,
    createText("p", `No usage data · ${catalogMessage(catalog)}`, "usage-card-empty"),
    createModelAction(provider, models, catalog),
  );
  return card;
}



function renderUsage(response) {
  const status = byId("usage-status");
  const updated = byId("usage-updated");
  const details = byId("usage-details");
  const usage = response || {};
  const responseStatus = usage.status || "unknown";

  details.replaceChildren();
  status.className = `usage-status ${usageStatusClass(responseStatus)}`;
  let statusText = responseStatus === "stale"
    ? `Usage snapshot stale · last success ${formatAge(usage.lastSuccessfulAt)}`
    : responseStatus === "ok"
      ? "Usage snapshot current"
      : "Usage snapshot unavailable";
  if (usage.error) statusText += ` · ${String(usage.error)}`;
  status.textContent = statusText;
  updated.textContent = usage.snapshot?.generatedAt
    ? `Snapshot: ${formatDate(usage.snapshot.generatedAt)} (${formatAge(usage.snapshot.generatedAt)})`
    : usage.lastSuccessfulAt
      ? `Last successful snapshot: ${formatDate(usage.lastSuccessfulAt)} (${formatAge(usage.lastSuccessfulAt)})`
      : "Waiting for usage snapshot…";

  const snapshot = usage.snapshot;
  if (!snapshot) {
    if (state.loading.usage) {
      appendStateMessage(details, "Loading provider capacity…");
    } else if (state.sourceErrors.usage) {
      appendStateMessage(details, "Provider capacity unavailable.", { error: true, retry: true });
    } else {
      const noData = root.createElement("section");
      noData.className = "usage-no-data";
      noData.append(
        createText("strong", "No usage data"),
        createText("span", "No provider usage snapshot is available."),
      );
      details.append(noData);
    }
    return;
  }

  const reports = Array.isArray(snapshot.reports) ? snapshot.reports : [];
  const modelCatalog = usage.models;
  const modelsByProvider = new Map();
  for (const model of Array.isArray(modelCatalog?.models) ? modelCatalog.models : []) {
    if (typeof model?.provider !== "string" || !model.provider) continue;
    if (!modelsByProvider.has(model.provider)) modelsByProvider.set(model.provider, []);
    modelsByProvider.get(model.provider).push(model);
  }

  let hasRenderableDetails = false;
  const reportedProviders = new Set();
  for (const report of reports) {
    if (typeof report?.provider === "string" && report.provider) reportedProviders.add(report.provider.toLowerCase());
    details.append(buildUsageCard(report, modelCatalog));
    hasRenderableDetails = true;
  }
  for (const [provider, models] of modelsByProvider) {
    if (!reportedProviders.has(provider.toLowerCase())) {
      details.append(buildModelCatalogCard(provider, models, modelCatalog));
      hasRenderableDetails = true;
    }
  }

  const modelProviderKeys = new Set([...modelsByProvider.keys()].map((provider) => provider.toLowerCase()));
  const accountsWithoutUsage = Array.isArray(snapshot.accountsWithoutUsage)
    ? snapshot.accountsWithoutUsage.filter((account) => (
      !CLI_PROVIDER_IDS.has(account?.provider) && !modelProviderKeys.has(String(account?.provider || "").toLowerCase())
    ))
    : [];
  if (accountsWithoutUsage.length) {
    const noData = root.createElement("section");
    noData.className = "usage-no-data";
    noData.append(createText("strong", "No usage data"));
    const noDataList = root.createElement("ul");
    for (const account of accountsWithoutUsage) {
      const provider = typeof account.provider === "string" && account.provider ? account.provider : "Unknown provider";
      const type = typeof account.type === "string" && account.type ? account.type : "unknown type";
      noDataList.append(createText("li", `${providerDisplayName(provider)} · ${type}`));
    }
    noData.append(noDataList);
    details.append(noData);
    hasRenderableDetails = true;
  }

  const disabledCredentials = Array.isArray(snapshot.disabledCredentials) ? snapshot.disabledCredentials : [];
  if (disabledCredentials.length) {
    const disabledSection = root.createElement("section");
    disabledSection.className = "usage-disabled-credentials";
    disabledSection.append(createText("strong", "Disabled credentials"));
    const disabledList = root.createElement("ul");
    const disabledCounts = new Map();
    for (const credential of disabledCredentials) {
      const provider = typeof credential?.provider === "string" && credential.provider
        ? providerDisplayName(credential.provider)
        : "Unknown provider";
      const credentialStatus = typeof credential?.status === "string" && credential.status
        ? credential.status
        : "disabled";
      if (!disabledCounts.has(provider)) disabledCounts.set(provider, new Map());
      const statuses = disabledCounts.get(provider);
      statuses.set(credentialStatus, (statuses.get(credentialStatus) || 0) + 1);
    }
    for (const [provider, statuses] of disabledCounts) {
      for (const [credentialStatus, count] of statuses) {
        disabledList.append(createText("li", `${provider} · status: ${credentialStatus} · count: ${count}`));
      }
    }
    disabledSection.append(disabledList);
    details.append(disabledSection);
    hasRenderableDetails = true;
  }

  if (!hasRenderableDetails) {
    status.className = "usage-status unknown";
    status.textContent = `${statusText} · no provider data`;
    appendStateMessage(details, "Usage endpoint returned no provider data.", { error: true, retry: true });
  }
}


async function getJson(path, signal) {
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function renderCurrentState() {
  renderPreservingFocus(() => {
    renderCards(state.snapshot, state.maintenance);
    renderSessions(state.snapshot);
    renderTopConsumers(state.snapshot);
  });
}

async function runMemoryCleanup() {
  const button = byId("cleanup-memory");
  if (!button || state.cleanupBusy || !confirm("This will clear filesystem cache and recycle swap if the RAM guard passes.\nNo OMP or Herdr sessions will be closed.\nContinue?")) return;
  state.cleanupBusy = true;
  renderMaintenance(state.maintenance);
  button.disabled = true;
  button.classList.add("is-busy");
  button.title = "Cleaning memory and swap…";
  button.setAttribute("aria-label", "Cleaning memory and swap…");
  const statusNode = byId("cleanup-status");
  if (statusNode) statusNode.textContent = "Cleanup in progress…";
  try {
    const response = await fetch("/api/memory/cleanup", { method: "POST", cache: "no-store" });
    const body = await response.json();
    const parsed = parseCleanupResult(body, response.ok, response.status);
    if (parsed.result) {
      state.cleanupResult = parsed.result;
      state.cleanupMessage = parsed.ok ? null : parsed.result.error || "Cleanup failed.";
      await loadCurrent();
      return;
    }
    throw new Error(parsed.error);
  } catch (error) {
    if (isAbortError(error)) return;
    state.cleanupMessage = errorMessage(error);
    const currentStatusNode = byId("cleanup-status");
    if (currentStatusNode) currentStatusNode.textContent = `Cleanup error: ${state.cleanupMessage}`;
    renderCards(state.snapshot, state.maintenance);
  } finally {
    state.cleanupBusy = false;
    renderCards(state.snapshot, state.maintenance);
    const currentButton = byId("cleanup-memory");
    if (currentButton) {
      currentButton.classList.remove("is-busy");
      renderMaintenance(state.maintenance);
    }
  }
}

async function loadCurrent() {
  const request = beginRequest("current");
  state.loading.current = true;
  if (!state.snapshot) renderCurrentState();
  const [currentResult, healthResult, maintenanceResult] = await Promise.allSettled([
    getJson("/api/current", request.controller.signal),
    getJson("/healthz", request.controller.signal),
    getJson("/api/maintenance", request.controller.signal),
  ]);
  if (!isCurrentRequest("current", request)) return;
  if ([currentResult, healthResult, maintenanceResult].some((result) => result.status === "rejected" && isAbortError(result.reason))) return;

  state.loading.current = false;
  if (currentResult.status === "fulfilled") {
    const current = currentResult.value;
    state.snapshot = current.snapshot;
    state.events = current.events || [];
    const collectorErrors = Array.isArray(state.snapshot?.collectorErrors)
      ? state.snapshot.collectorErrors.filter(Boolean).join("; ")
      : null;
    state.sourceErrors.current = collectorErrors;
  } else {
    state.sourceErrors.current = errorMessage(currentResult.reason);
  }
  if (healthResult.status === "fulfilled") {
    state.sourceErrors.health = healthResult.value.error ? String(healthResult.value.error) : null;
  } else {
    state.sourceErrors.health = errorMessage(healthResult.reason);
  }
  if (maintenanceResult.status === "fulfilled") {
    state.maintenance = maintenanceResult.value;
    state.sourceErrors.maintenance = null;
  } else {
    state.maintenance = null;
    state.sourceErrors.maintenance = errorMessage(maintenanceResult.reason);
  }
  renderCurrentState();
  renderMaintenance(state.maintenance);
  renderEvents(state.events);
  renderErrors();
}

async function loadHistory() {
  const request = beginRequest("history");
  state.loading.history = true;
  renderHistory(state.history);
  try {
    const history = await getJson("/api/history?range=24h", request.controller.signal);
    if (!isCurrentRequest("history", request)) return;
    state.history = history;
    state.sourceErrors.history = null;
  } catch (error) {
    if (!isCurrentRequest("history", request) || isAbortError(error)) return;
    state.sourceErrors.history = errorMessage(error);
  } finally {
    if (isCurrentRequest("history", request)) {
      state.loading.history = false;
      renderHistory(state.history);
      renderErrors();
    }
  }
}

async function loadUsage() {
  const request = beginRequest("usage");
  state.loading.usage = true;
  renderUsage(state.usage);
  try {
    const usage = await getJson("/api/usage", request.controller.signal);
    if (!isCurrentRequest("usage", request)) return;
    state.usage = usage;
    state.sourceErrors.usage = null;
  } catch (error) {
    if (!isCurrentRequest("usage", request) || isAbortError(error)) return;
    state.sourceErrors.usage = errorMessage(error);
    state.usage = {
      ...state.usage,
      status: state.usage.snapshot ? "stale" : "unknown",
      error: errorMessage(error),
    };
  } finally {
    if (isCurrentRequest("usage", request)) {
      state.loading.usage = false;
      renderUsage(state.usage);
      renderErrors();
    }
  }
}

function updateUsageCountdowns() {
  for (const element of root.querySelectorAll("[data-resets-at]")) {
    element.textContent = formatCountdown(element.dataset.resetsAt);
  }
}

let refreshPromise = null;
async function refresh() {
  if (refreshPromise) return refreshPromise;
  const button = byId("refresh");
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Refreshing…";
  }
  refreshPromise = Promise.all([loadCurrent(), loadHistory(), loadUsage()]).finally(() => {
    refreshPromise = null;
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Refresh";
    }
  });
  return refreshPromise;
}

byId("model-dialog-close")?.addEventListener("click", closeModelDialog);
byId("model-dialog-filter")?.addEventListener("input", renderModelDialog);
const modelDialog = byId("model-dialog");
modelDialog?.addEventListener("close", restoreModelDialogFocus);
modelDialog?.addEventListener("click", (event) => {
  if (event.target === modelDialog) closeModelDialog();
});

byId("refresh").addEventListener("click", refresh);
void refresh();
setInterval(loadCurrent, 5000);
setInterval(loadHistory, 30000);
setInterval(loadUsage, USAGE_REFRESH_MS);
setInterval(updateUsageCountdowns, 60 * 1000);
