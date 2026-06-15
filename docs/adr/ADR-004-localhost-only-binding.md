# ADR-004: Ingest server binds to 127.0.0.1 by default

**Date:** 2024-03-01
**Status:** Accepted

## Decision

The Express HTTP server listens on `127.0.0.1:3000` (loopback) by default, not `0.0.0.0`, making it unreachable from the network without explicit opt-in.

## Alternatives considered

- **Bind to 0.0.0.0 by default** — rejected: any process or user on the local network could read the event buffer, inject fake events, or trigger autonomous fix execution without authentication.
- **Bind to 0.0.0.0 with mandatory API key** — rejected: the key management burden defeats the "zero-config local install" goal; most users run Mergen on a development laptop where loopback is sufficient.
- **Unix domain socket** — rejected: not supported on Windows; cross-platform path resolution adds complexity.

## Rationale

Developer tools that run locally should be safe by default. Binding to loopback means Mergen's attack surface is limited to processes already running on the same machine — the same trust boundary as a local database. Teams that need network-accessible deployments (shared infra, CI runners) can set `MERGEN_HOST=0.0.0.0` and pair it with `MERGEN_SECRET` or cloud-mode TLS + API keys.

## Consequences

- Browser extensions and SDK integrations must point to `http://127.0.0.1:3000`, not `localhost` (which may resolve differently on some systems).
- Docker-based deployments require `--network=host` or explicit port mapping + `MERGEN_HOST=0.0.0.0`.
- Cloud mode (`MERGEN_CLOUD_MODE=true`) overrides the default to `0.0.0.0` and enforces TLS + hashed API keys.
