# Contributing to Deathstar

Thanks for improving Deathstar. Keep changes local-first, observable and safe to publish.

## Before opening a change

- Read `README.md`, `AGENTS.md` and the relevant architecture/integration guide.
- Check existing issues and focused tests.
- Keep the change narrow; do not bundle unrelated host automation or credential handling.

## Development loop

```bash
bun install --frozen-lockfile
bun test tests/<focused-test>.test.ts
bun run typecheck
bun test
bun run build:web
```

For dashboard changes, run a demo state and inspect the actual page in a browser:

```bash
DEATHSTAR_DEMO_STATE=healthy bun run demo
```

Use `pressure` and `unavailable` when the change affects degraded states, events, usage or remediation. Screenshots must come from deterministic demo data only.

## Contract-first changes

Add a focused failing test before changing observable behavior. Tests should defend a real contract: state transitions, boundaries, precedence, normalization, error behavior, HTTP status/origin checks or rendered user-visible states. Avoid tests that only assert source text or incidental implementation details unless the contract is a packaging/safety rule.

When changing a public type or endpoint, update every caller, focused fixture and documentation page in the same change. Do not leave compatibility aliases or dead paths behind.

## Public data rules

Never commit:

- real runtime databases, SQLite WAL/SHM files or logs;
- OMP/Herdr transcripts, prompts, command output or provider responses;
- tokens, cookies, account identifiers or credentials;
- usernames, private hostnames, tailnet domains or machine-specific absolute paths;
- screenshots taken from a real workstation.

Use synthetic names, paths, providers and fixed timestamps. If a bug requires sensitive material, reduce it to a minimal synthetic reproduction before posting it.

## Pull requests

A pull request should include:

- the user-visible behavior and the safety boundary it preserves;
- focused verification commands and results;
- documentation updates for new configuration, endpoints or operator actions;
- a screenshot only when a dashboard surface changed, generated from demo data.

Do not paste raw command output or transcripts into issues or pull requests. Attach a redacted, minimal reproduction instead.

## Commit hygiene

Keep commits reviewable. Do not include generated `dist/`, local state, databases, logs or editor artifacts. Run the public payload audit before publication or release.
