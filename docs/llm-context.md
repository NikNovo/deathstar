# Deathstar LLM context

This page is intentionally compact and synthetic. It gives coding agents the contracts needed to make a safe local change without shipping repository data to a runtime model.

```yaml
product:
  name: deathstar
  purpose: local-first OMP/Herdr and host-memory observability
  runtime_llm: false
  telemetry: false
  platform: linux
  runtime: bun-1.x

safe_defaults:
  host: 127.0.0.1
  port: 3848
  auto_cleanup: off
  state_root: ${XDG_STATE_HOME:-$HOME/.local/state}/deathstar
  database: ${state_root}/monitor.sqlite3
  recovery: ${state_root}/recovery
  omp_session_root: $HOME/.omp/agent/sessions

optional_integrations:
  herdr: true
  omp: true
  host_collection_without_them: true
  unavailable_behavior: explicit unknown/unavailable plus remediation

privacy:
  forbidden: [prompts, transcripts, tokens, provider_payloads, command_output, cgroup_paths, workstation_paths]
  snapshot_projection:
    directory: null
    pane_id: null
    cgroup_path: null
    cwd: null
    command: executable_basename
  event_projection: fixed_message_and_safe_detail_allowlist
  fixture_names: [agent-alpha, agent-beta, provider-a, provider-b]
  fixture_time: 2026-01-15T12:00:00.000Z

http:
  GET /healthz: HealthResponse
  GET /api/current: CurrentResponse
  GET /api/history?range=1h|6h|24h: HistoryResponse
  GET /api/events?range=1h|6h|24h: EventRecord[]
  GET /api/usage: UsageResponse
  GET /api/maintenance: MaintenanceStatus
  POST /api/memory/cleanup: bodyless_same_origin_guarded_action

modules:
  config: src/config.ts
  paths: src/paths.ts
  host: src/sources/proc.ts
  integration: src/sources/herdr.ts
  collector: src/collector.ts
  privacy: src/privacy.ts
  storage: src/storage.ts
  usage: src/usage.ts
  cleanup: src/maintenance.ts + src/memory-cleanup.ts
  recovery: src/recovery/
  http: src/http.ts
  ui: web/
  demo: scripts/demo-data.ts + scripts/demo-server.ts
```

## Agent procedure

1. Read `AGENTS.md` and the focused tests.
2. Identify the owning module; do not introduce a parallel abstraction.
3. Add a focused failing test for observable behavior.
4. Implement and migrate all callers.
5. Run focused tests, `bun run typecheck`, full tests, web build and a live demo smoke test.
6. Review the public payload and generated files before claiming completion.

## Key invariants

- Host collection failure is fatal to a sample; optional Herdr failure is not fatal.
- Public projection happens inside storage methods, not only in one HTTP caller.
- Configured filesystem paths are absolute.
- Cleanup never accepts arbitrary arguments, interactive authentication or silent auto-enable.
- Recovery validates transcript containment and process identity.
- A missing optional source is not the same as zero usage or zero sessions.

## Synthetic API example

```json
{
  "snapshot": {
    "observedAt": "2026-01-15T12:00:00.000Z",
    "host": { "state": "ok", "availableBytes": 7516192768, "errors": [] },
    "sessions": [{ "name": "agent-alpha", "ompState": "working", "ompPid": 42, "directory": null, "paneId": null }],
    "ompCount": 1,
    "herdrSessionCount": 1,
    "collectorErrors": []
  },
  "events": []
}
```

Do not copy fields from a real local response into an issue, test or prompt. Reduce the behavior to synthetic values first.
