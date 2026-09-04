# Security policy

## Scope

Deathstar is a local-first dashboard intended to bind to loopback. It reads local Linux process and resource state and can invoke one explicitly configured privileged cleanup helper.

The server has no authentication layer. Treat a non-loopback bind as unsafe unless an external, reviewed authentication and transport boundary is placed in front of it.

## Report privately

For a suspected vulnerability, do not open a public issue with secrets, transcripts, logs or exploit details. Contact the repository owner through a private GitHub security report or another private channel available to the owner. Include:

- affected commit or version;
- minimal reproduction using synthetic data where possible;
- impact and required local privileges;
- any mitigation already applied.

Allow time for triage before public disclosure.

## What not to disclose

Never include real tokens, prompts, provider payloads, cookies, session transcripts, hostnames, usernames, absolute workstation paths or runtime databases in a report. Replace them with synthetic values and state the shape of the original data.

## Local safety model

- Default bind: `127.0.0.1`.
- Cleanup automation: `off` by default.
- Cleanup action: same-origin, bodyless `POST`, fixed helper path, `sudo -n`, result validation and cooldown.
- Optional Herdr/OMP failures: explicit unavailable state rather than raw command output in the dashboard.
- Persistence: bounded SQLite under the XDG state directory, with snapshot/event projections that remove sensitive fields.
- No runtime telemetry and no runtime LLM dependency.

If you intentionally expose Deathstar beyond loopback, document the proxy, authentication, TLS and network policy outside this repository and review the threat model again.
