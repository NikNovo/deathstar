# OMP and Herdr integration

Deathstar treats OMP and Herdr as optional local integrations. Host health collection and the dashboard remain usable when either command is missing, times out or returns malformed JSON.

## Herdr source commands

The default binary is `herdr`; override it with an absolute `DEATHSTAR_HERDR` path.

The session source invokes these command shapes through the command-runner timeout boundary:

```text
herdr session list --json
herdr --session <session> api snapshot
herdr --session <session> pane process-info --pane <pane-id>
```

The adapter uses only structured fields needed for the public session snapshot:

- session name and running state;
- agent status and pane identity;
- foreground OMP PID;
- process RSS/virtual memory/state/start time from the local proc source;
- cgroup current/peak/OOM counters;
- whether the cgroup is shared.

Raw Herdr JSON and command errors remain local to the adapter. If a per-session read fails, that session becomes `unknown` with a generic public error after projection. If session listing fails, the collector emits the generic optional-integration warning and preserves the host snapshot.

## OMP usage commands

Usage collection invokes:

```text
omp usage --json --redact
omp models --json
```

The `--redact` flag is part of the command contract. The normalizer accepts only JSON objects with finite numeric timestamps and array-shaped reports/models. It converts timestamps to ISO strings, assigns ordinal labels such as `Account 1`, normalizes limits/windows/statuses and reports provider/model metadata without copying raw command output.

Usage status is one of `ok`, `stale` or `unknown`. A provider can be `reported`, `no-usage-data`, `not-configured` or `error`. Missing usage data is not treated as zero usage.

## OMP process correlation

For session memory details, Deathstar correlates Herdr foreground processes with OMP PIDs discovered from `/proc`. It walks the foreground process tree, reads the associated cgroup and aggregates RSS. A missing OMP PID is represented as `missing`; an ambiguous or disappearing process does not become a guessed process.

## Recovery commands

The CLI wrapper exposes local recovery:

```text
bin/deathstar session bind <name>
bin/deathstar session status <name>
bin/deathstar session close <name>
bin/deathstar session open <name> [--no-attach]
```

Mappings are stored under `${XDG_STATE_HOME:-$HOME/.local/state}/deathstar/recovery` by default. The OMP session root defaults to `$HOME/.omp/agent/sessions`. Override with:

- `DEATHSTAR_RECOVERY_DIR` — mapping files;
- `DEATHSTAR_SESSION_ROOT` — allowed OMP transcript root.

Both values must resolve to absolute paths. `open` refuses a mapping outside the configured session root, a non-JSONL file, the reserved `__advisor.jsonl`, a missing file or a changed OMP identity.

## Redaction boundary

The local adapters may need paths and diagnostics to make a recovery decision. The dashboard/storage boundary may not expose them:

| Source value | Public representation |
| --- | --- |
| session directory | `null` |
| pane ID | `null` |
| cgroup path | `null` |
| process cwd | `null` |
| command line | executable basename only |
| adapter error text | generic unavailable message |
| event message | fixed message for event kind |
| event details | numeric counters, timing, shared/source/status allowlist |

Do not loosen this projection to make a dashboard debugging task easier. Add a safe aggregate field and a focused privacy test instead.

## Troubleshooting

```bash
bin/deathstar doctor --json
DEATHSTAR_HERDR=/absolute/path/to/herdr bun run dev
```

If `herdr` is absent, inspect host cards and the source warning first. If `omp usage` is unavailable, the usage panel should show unknown/stale state rather than failing host collection. If a recovery mapping is rejected, run `status`, verify the configured session root and rebind only after reviewing the local session.
