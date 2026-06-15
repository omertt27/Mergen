# ADR-001: Ring buffer as primary event store

**Date:** 2024-01-15
**Status:** Accepted

## Decision

Use a fixed-capacity (2 000-event) in-memory ring buffer as the primary store for inbound telemetry events, with O(1) eviction of the oldest event when the cap is reached.

## Alternatives considered

- **Unlimited in-memory list** — rejected: unbounded memory growth in long-running servers or high-traffic services would cause OOM crashes without any safety valve.
- **Write-through to SQLite on every event** — rejected: synchronous disk I/O on every ingest call would bottleneck throughput during incident spikes; SQLite is used for the 1-hour history window separately.
- **Redis as primary store** — rejected: adds an external dependency that breaks the "zero-infrastructure" install story; Redis is supported as an optional persistence layer but not required.

## Rationale

Incident triage tools need the *most recent* events, not a complete historical ledger. A ring buffer keeps the hot path allocation-free (no GC pressure), provides constant-time reads and writes, and caps memory at a predictable ceiling (~2 MB for typical event sizes). The 2 000-event capacity covers roughly 30–60 minutes of typical backend traffic before the SQLite history layer takes over for anything older.

## Consequences

- Reading more than 2 000 events requires querying the SQLite history store (`GET /sessions/:id`).
- Agents must account for the fact that very old events may have been evicted; `get_recent_logs` always reads from the live buffer.
- The cap is tunable via `MERGEN_BUFFER_SIZE` env var but the default is intentionally conservative.
