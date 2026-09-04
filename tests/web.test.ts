import { expect, test } from "bun:test";

test("dashboard keeps reclaim action in the seven-card host overview", async () => {
  const html = await Bun.file(new URL("../web/index.html", import.meta.url)).text();
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const styles = await Bun.file(new URL("../web/styles.css", import.meta.url)).text();

  expect(html).not.toContain("MEMORY MAINTENANCE");
  expect(html).not.toContain('id="maintenance-panel"');
  expect(html).not.toContain('id="usage-summary"');
  expect(html).toContain("subscription-usage");
  expect(html).toContain("usage-details");
  expect(html).toContain("top-consumers");
  expect(html).toContain('id="model-dialog"');
  expect(html).toContain('id="model-dialog-details"');
  expect(script).toContain("/api/maintenance");
  expect(script).toContain("cgroupShared");
  expect(script).toContain('getJson("/api/maintenance", request.controller.signal)');
  expect(script).toContain("renderMaintenance(maintenance)");
  expect(script).toContain("renderTopConsumers(state.snapshot)");
  expect(script).toContain("reclaimed RAM");
  expect(script).not.toContain("maintenanceFileStatus");
  expect(script).not.toContain("Helper diagnostics");
  expect(script).not.toContain("maintenance-facts");
  expect(script).not.toContain("maintenance-remediation");
  expect(script).not.toContain("auto-cleanup-mode");
  expect(script).toContain('function createCleanupCard(');
  expect(script).toContain('createText("p", "Reclaim memory", "card-label cleanup-card-title")');
  expect(script).toContain('button.id = "cleanup-memory"');
  expect(script).toContain("lastCleanup");
  expect(script).toContain("Last cleaned");
  expect(script).toContain("cleanupMessage");
  expect(script).not.toContain("renderUsageOverview");
  expect(script).not.toContain("aggregate status:");
  expect(script).not.toContain("nearest reset:");
  expect(script).not.toContain("Perplexity");
  expect(script).not.toContain("Tavily");
  expect(script).not.toContain("Meta");
  expect(styles).toContain("grid-template-columns: repeat(7, minmax(0, 1fr));");
});

test("dashboard keeps host cards visible when optional collection is degraded", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("collectorErrors");
  expect(script).toContain("state.sourceErrors.current = collectorErrors");
  expect(script).toContain("renderCurrentState()");
});
test("dashboard orders reclaim action directly after available RAM", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const cardsStart = script.indexOf("const cards = [");
  const cardsEnd = script.indexOf("const statusSignature", cardsStart);
  const cards = script.slice(cardsStart, cardsEnd);

  expect(cards.indexOf('["Available RAM"')).toBeGreaterThanOrEqual(0);
  expect(cards.indexOf('["Reclaim memory"')).toBeGreaterThan(cards.indexOf('["Available RAM"'));
  expect(cards.indexOf('["Swap"')).toBeGreaterThan(cards.indexOf('["Reclaim memory"'));
});
test("reclaim card avoids duplicated host metrics and diagnostics", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("function createCleanupCard");
  const end = script.indexOf("function renderCards", start);
  const card = script.slice(start, end);

  expect(card).not.toContain("createCleanupMetric");
  expect(card).not.toContain("Helper diagnostics");
  expect(card).not.toContain("maintenance-facts");
  expect(card).not.toContain("maintenance-remediation");
  expect(card).not.toContain("auto-cleanup-mode");
  expect(card).toContain("cleanup-summary");
  expect(card).toContain("cleanup-status");
  expect(card).toContain("createCleanupButton()");
});
test("dashboard renders each usage report only once", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  const usageStart = script.indexOf("function renderUsage(response)");
  const usageEnd = script.indexOf("async function getJson");
  expect(usageStart).toBeGreaterThanOrEqual(0);
  expect(usageEnd).toBeGreaterThan(usageStart);
  expect(script.slice(usageStart, usageEnd)).not.toContain("renderUsageOverview");
  expect(script.slice(usageStart, usageEnd)).toContain("details.append(buildUsageCard(report, modelCatalog));");
});

test("dashboard renders usage as countdown cards, not a meter table", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const styles = await Bun.file(new URL("../web/styles.css", import.meta.url)).text();

  expect(script).toContain("model-dialog-item");
  expect(script).toContain("model-dialog-details");
  expect(script).toContain("usage-card-models");
  expect(script).not.toContain("model-limits-table");
  expect(script).not.toContain("model-provider");
  expect(styles).not.toContain(".model-table-wrap");
  expect(styles).not.toContain(".model-limit-details");
  expect(styles).toContain(".model-dialog");
  // Card-per-account rendering, not the old <table> meter grid.
  expect(script).toContain("usage-card");
  expect(script).toContain('root.createElement("article")');
  expect(script).not.toContain('for (const label of ["Meter", "Used / limit", "Remaining", "Fetched", "Resets", "Status"])');
  expect(script).not.toContain("tableWrap");

  // Remaining-amount formatting per unit.
  expect(script).toContain("function formatRemaining(");
  expect(script).toContain('amount.unit === "usd"');
  expect(script).toContain('amount.unit === "percent"');

  // Reset countdown, computed client-side, no network call inside it.
  expect(script).toContain("function formatCountdown(");
  expect(script).toContain("resets now");
  expect(script).toContain("resets —");
  expect(script).not.toMatch(/function formatCountdown\([^)]*\)\s*{[^}]*fetch\(/s);

  // A one-minute client-only countdown refresh, independent from the hourly data fetch.
  expect(script).toMatch(/setInterval\([^,]*,\s*60(?:_?000|\s*\*\s*1000)\)/);

  // Empty-limit accounts stay unknown, never healthy.
  expect(script).toContain('if (!limits.length) return "unknown";');

  // Existing safety/no-data/disabled sections stay in place.
  expect(script).toContain("disabledCredentials");
  expect(script).toContain("Disabled credentials");
  expect(script).toContain('disabledSection.className = "usage-disabled-credentials"');
  expect(script).toContain("textContent");
  expect(script).not.toContain("innerHTML");
  expect(styles).toContain(".usage-card");
  expect(styles).toContain(".usage-disabled-credentials");
});

test("dashboard never adds session-killing controls", async () => {
  const html = await Bun.file(new URL("../web/index.html", import.meta.url)).text();
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(html).not.toMatch(/kill|close session|stop OMP/i);
  expect(script).not.toMatch(/kill\(|systemctl.*stop|pane.*close/i);
});
test("dashboard logic treats invalid resource measurements as unknown", async () => {
  const logic = await import("../web/logic.js");

  expect(logic.resourceStatus(0, 0, 0.5)).toBe("unknown");
  expect(logic.resourceStatus(null, 100, 0.5)).toBe("unknown");
  expect(logic.resourceStatus(80, 100, 0.5)).toBe("warning");
});
test("dashboard defines tmpfs status before rendering cards", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain('const tmpStatus = resourceStatus(host.tmpUsedBytes, host.tmpTotalBytes, 0.8);');
});

test("dashboard logic preserves structured cleanup failures", async () => {
  const logic = await import("../web/logic.js");

  expect(
    logic.parseCleanupResult(
      { status: "failed", completedAt: "2026-09-03T18:08:45.637Z", error: "helper failed" },
      false,
      500,
    ),
  ).toEqual({
    ok: false,
    result: {
      status: "failed",
      completedAt: "2026-09-03T18:08:45.637Z",
      error: "helper failed",
    },
  });
});

test("dashboard logic preserves missing chart samples and catalog health", async () => {
  const logic = await import("../web/logic.js");

  expect(logic.chartValue(null, 1024 ** 3)).toBeNull();
  expect(logic.chartValue(-1, 1024 ** 3)).toBeNull();
  expect(logic.chartValue(1024 ** 3, 1024 ** 3)).toBe(1);
  expect(logic.catalogState({ status: "stale" })).toBe("warning");
  expect(logic.catalogState({ status: "error" })).toBe("critical");
  expect(logic.catalogState({ status: "unknown" })).toBe("unknown");
});

test("dashboard logic rejects malformed timestamps instead of emitting NaN", async () => {
  const logic = await import("../web/logic.js");

  expect(logic.formatDateValue("not-a-date")).toBe("unknown");
  expect(logic.formatAgeValue("not-a-date", Date.parse("2026-09-03T18:00:00.000Z"))).toBe(
    "unknown",
  );
});
test("dashboard exposes cleanup status and chart units", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain('cleanupStatus.id = "cleanup-status"');
  expect(script).toContain('if (unit === "bytes") return formatBytes(value);');
});

test("dashboard styles unknown states and mobile session rows", async () => {
  const styles = await Bun.file(new URL("../web/styles.css", import.meta.url)).text();

  expect(styles).toContain(".card.unknown");
  expect(styles).toContain(".pill.unknown");
  expect(styles).toContain("td::before");
  expect(styles).toContain("100dvh");
  expect(styles).toContain("overscroll-behavior: contain");
});
test("dashboard keeps session table states inside semantic rows", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("function appendTableStateMessage");
  expect(script).toContain("cell.colSpan = 7");
});
test("dashboard does not mark incomplete usage limits healthy", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain('statuses.some((status) => status !== "ok")');
});
test("dashboard keeps model-only providers outside healthy usage states", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("function buildModelCatalogCard");
  const end = script.indexOf("function renderUsage", start);

  expect(script.slice(start, end)).toContain(
    'const status = catalogState(catalog) === "critical" ? "critical" : "unknown";',
  );
});
test("dashboard rerenders cleanup result after the busy state ends", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("async function runMemoryCleanup");
  const end = script.indexOf("async function loadCurrent", start);

  expect(script.slice(start, end)).toMatch(
    /finally \{[\s\S]*renderCards\(state\.snapshot, state\.maintenance\);/,
  );
});
test("model details retain cache pricing", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("function appendModelDialogItem");
  const end = script.indexOf("function renderModelDialog", start);

  expect(script.slice(start, end)).toContain(
    '["Cache read / write", formatModelCacheCost(model?.cost)]',
  );
});
test("model details dialog restores focus to its opener", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("modelDialogTrigger");
  expect(script).toContain("modelDialogTrigger?.focus()");
});
test("dashboard preserves cleanup errors after card rerender", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("function renderCleanupSummary");
  const end = script.indexOf("function maintenanceFlag", start);

  expect(script.slice(start, end)).toContain("state.cleanupMessage");
  expect(script.slice(start, end)).toContain("Cleanup failed");
});
test("dashboard labels cached history when refresh fails", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("Showing last successful history");
});
test("dashboard keeps cleanup disabled until maintenance readiness is known", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("state.cleanupBusy || state.maintenance?.ready !== true");
});
test("dashboard keeps unrecognized API statuses unknown", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const usageStart = script.indexOf("function usageStatusClass");
  const usageEnd = script.indexOf("function formatBytes", usageStart);
  const sessionStart = script.indexOf("function statusClass");
  const sessionEnd = script.indexOf("function statusLabel", sessionStart);

  expect(script.slice(usageStart, usageEnd)).toContain('if (status === "ok") return "ok";');
  expect(script.slice(usageStart, usageEnd)).toContain('return "unknown";');
  expect(script.slice(sessionStart, sessionEnd)).toContain('if (status === "working" || status === "idle") return "ok";');
  expect(script.slice(sessionStart, sessionEnd)).toContain('return "unknown";');
});
test("dashboard does not call unknown usage status current", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("function renderUsage(response)");
  const end = script.indexOf("async function getJson", start);

  expect(script.slice(start, end)).toContain(
    'responseStatus === "ok"\n      ? "Usage snapshot current"\n      : "Usage snapshot unavailable";',
  );
});
test("dashboard shows cleanup progress in the maintenance panel", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("async function runMemoryCleanup");
  const end = script.indexOf("async function loadCurrent", start);

  expect(script.slice(start, end)).toContain("state.cleanupBusy = true;\n  renderMaintenance(state.maintenance);");
});
test("dashboard preserves focused controls during live rerenders", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("const focusedId = root.activeElement?.id");
  expect(script).toContain("byId(focusedId)?.focus()");
});
test("dashboard avoids repeating identical source-error announcements", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("if (state.lastErrorSignature === errorSignature) return;");
});
test("dashboard marks cached current samples stale after source failure", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain('if (status === "warning" || status === "stale") return "warning";');
  expect(script).toContain('state.sourceErrors.current || state.sourceErrors.health');
  expect(script).toContain("Last successful sample");
});
test("dashboard treats an all-missing chart metric as empty data", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();
  const start = script.indexOf("function renderChart");
  const end = script.indexOf("function renderHistory", start);

  expect(script.slice(start, end)).toContain(
    'appendStateMessage(container, "History has no valid measurements.");',
  );
});
test("dashboard disables cleanup when maintenance refresh fails", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("state.maintenance = null;");
});
test("model details dialog falls back when its opener was rerendered", async () => {
  const script = await Bun.file(new URL("../web/app.js", import.meta.url)).text();

  expect(script).toContain("root.contains(modelDialogTrigger)");
  expect(script).toContain('byId("refresh")?.focus()');
});
