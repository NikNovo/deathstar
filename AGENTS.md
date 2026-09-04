# AGENTS.md

This file is the operating contract for coding agents and contributors working on Deathstar.

## Read first

1. `README.md` for product behavior and commands.
2. `docs/architecture.md` for module ownership and data flow.
3. `docs/llm-context.md` for compact invariants and public API shapes.
4. The focused tests beside the module you change.

## Repository map

- `src/config.ts` — environment parsing and validated defaults.
- `src/paths.ts` — absolute HOME/XDG-derived state paths.
- `src/sources/proc.ts` — Linux `/proc`, filesystem and cgroup collection.
- `src/sources/herdr.ts` — optional Herdr session and process-tree adapter.
- `src/collector.ts` — parallel collection, state stabilization and incident detection.
- `src/privacy.ts` — public snapshot/event projection before storage.
- `src/storage.ts` — SQLite schema, retention and history aggregation.
- `src/usage.ts` — normalized OMP usage/model metadata.
- `src/maintenance.ts` and `src/memory-cleanup.ts` — readiness and guarded cleanup.
- `src/http.ts` — loopback HTTP API and static dashboard serving.
- `src/recovery/` — local Herdr/OMP mapping and recovery workflow.
- `web/` — vanilla dashboard markup, rendering and styles.
- `scripts/demo-data.ts`, `scripts/demo-server.ts` — deterministic public-safe demo.
- `ops/` — portable systemd, monitor and cleanup-helper templates.
- `tests/` — focused contract tests and synthetic fixtures.

## Non-negotiable invariants

- Default HTTP bind is `127.0.0.1`.
- Default SQLite state is `${XDG_STATE_HOME:-$HOME/.local/state}/deathstar/monitor.sqlite3`.
- Automatic cleanup defaults to `off`.
- Herdr/OMP absence must not prevent host collection or dashboard startup.
- All configured filesystem paths are absolute after validation.
- Raw prompts, transcripts, tokens, provider payloads, cgroup paths, command output and workstation-specific paths do not enter SQLite, API responses, fixtures or screenshots.
- Optional failures become explicit `unknown`, `unavailable`, stale or remediation states; never silently fabricate healthy data.
- Cleanup is an explicit, same-origin, bodyless request through the fixed privileged helper.
- Demo data remains deterministic and synthetic.

## Safe workflow

1. Locate the owning module and read its focused tests.
2. Add or update a focused test for every observable behavior change.
3. Implement the smallest change that preserves the public boundary.
4. Run the focused test and typecheck while iterating.
5. Run the full repository checks and the live demo smoke test before claiming completion.
6. Review the public payload for private markers and generated artifacts.

Recommended commands:

```bash
bun test tests/<changed-contract>.test.ts
bun run typecheck
bun test
bun run build:web
DEATHSTAR_DEMO_STATE=healthy bun run demo
```

Use a real browser only for dashboard verification. Do not treat a source-only assertion as visual proof.

## Data handling

Never add real session transcripts, runtime databases, logs, provider responses, shell history, tokens, usernames, hostnames, absolute workstation paths or account identifiers to the repository. Use names such as `agent-alpha`, `agent-beta`, `provider-a`, fixed timestamps and synthetic roots.

When a source can produce local diagnostics, normalize or redact at the boundary before persistence and HTTP exposure. Local recovery commands may inspect a transcript path for the operator, but dashboard storage must receive only the normalized public projection.

## Change boundaries

- Keep OMP and Herdr adapters optional.
- Preserve stable TypeScript types unless the API contract and all callers/tests are migrated together.
- Prefer existing modules and patterns over a second abstraction.
- Do not add runtime LLM or telemetry dependencies.
- Do not expose the server outside loopback as a convenience.
- Do not enable automatic cleanup in tests, demo mode or public service defaults.

## Review checklist

- Focused test proves the requested contract.
- Existing callsites and API responses are migrated.
- Error paths retain actionable but non-sensitive messages.
- New files are covered by `.gitignore` or intentionally tracked.
- No generated database, screenshot, build output or private artifact is staged accidentally.
- README/docs describe behavior that was actually exercised.
