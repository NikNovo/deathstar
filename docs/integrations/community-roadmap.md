# Community roadmap: remaining local features

Status: roadmap / not-yet-ported. This branch (`community-features`) ships the
host inventory and session memory backend. The three items below exist only in
the private tree and are documented here so the community can integrate them
independently. Keep `web/logic.js` and the provider-model baseline untouched.

## 1. Async memory cleanup jobs

Contract: `POST /api/memory/cleanup` returns `202 { status: "accepted",
job: { id, state: "running", ... } }` immediately instead of blocking on the
privileged helper; `GET /api/memory/cleanup/status?id=<id>` reports
`running` / `done` / `failed` with the result payload.

Files: `src/memory-cleanup.ts` (add `CleanupJob`/`CleanupJobState`,
`start()`/`job()`, shared `runHelper` + `checkStartAllowed`, bounded job map),
`src/http.ts` (202 accept route + status route, same Origin/method/body
guards as other mutating routes), `ops/deathstar.service` (helper timeout
covers slow `swapoff`, e.g. 300s).

Frontend: button POSTs, then polls the status URL every 5s up to ~6 min;
on timeout shows "still running in background". Parse responses via
`text()` + guarded `JSON.parse`, never bare `.json()`, so severed
connections surface as explicit HTTP errors.

Tests: controller start/job lifecycle, 409 busy/cooldown mapping,
HTTP 202/status/400/404 paths, button busy-to-restored transition.

Privacy: no command output leaves the helper contract; keep the portable
`ops/install-memory-cleanup` remediation string (no workstation paths).

## 2. Same-origin `POST /api/usage/refresh`

Contract: `usage?: Pick<UsageMonitor, "current" | "refreshOnce">` in
`HttpOptions`; route checks POST, exact `Origin`, empty body, monitor
presence (503 `usage_unavailable`); runs `refreshOnce()`, returns
`usage.current()`; failures map to 500 `usage_failed`.

Frontend: `getJson(path, init)` must forward `init` to `fetch`
(`fetch(path, { ...init, cache: "no-store" })`); button disables with
"Refreshing…" label and restores in `finally`; optional 404 fallback to
plain `GET /api/usage` for older servers.

Tests: route guards (405/403/400/503/500/200), button behavior test
asserting a real POST (not a fallback GET), `tsc` clean.

## 3. Dashboard UI (`web/app.js`, `web/index.html`, `web/styles.css`)

Scope: usage per-account cards with remaining balances and reset countdowns,
usage Refresh button, cleanup card + polling button, inventory top-10
rendering with group dialogs. Do NOT delete `web/logic.js` /
`web/logic.d.ts`: `tests/http.test.ts` and `tests/web.test.ts` serve and
import them, so removal breaks the public suite.

Steps: port UI functions one section at a time (usage cards, cleanup card,
inventory list, dialogs); keep `web/logic.js` imports working; add styles
incrementally; keep captions (shared-RSS non-additive note, association
legend) and the no-kill/close contract.

Tests: `bun test tests/web.test.ts tests/http.test.ts`, `bun build
web/app.js`, contract scans for required element IDs, prohibited
kill/close/stop control strings.

## Checklist before any community PR

- `bun test tests/` green; `bunx tsc --noEmit` clean; `bun build web/app.js` clean.
- Privacy scan: no `/home/`, `/Users/`, `/root/`, tailnet hosts, emails,
  tokens, or private keys in added lines (`git diff` grep).
- `web/logic.js` still served and imported; provider-model baseline intact.
- Commits use a GitHub noreply identity, never a private email.
