# ADR-003: SQLite for persistent event history

**Date:** 2024-02-15
**Status:** Accepted

## Decision

Use SQLite (via `sql.js`) for the 1-hour persistent event history layer that backs `get_session_replay` and postmortem queries, rather than a networked database or plain JSON files.

## Alternatives considered

- **Plain JSON files** — rejected: JSON append is not atomic; a crash mid-write corrupts the file. Range queries (e.g., "events between T1 and T2") require full deserialisation.
- **PostgreSQL / MySQL** — rejected: requires a running database server, breaking the "zero-infrastructure, single `npm install`" install story.
- **Redis** — rejected: Redis persistence is optional and not enabled by default; it would also require the user to manage `AOF`/`RDB` config to avoid data loss.
- **LevelDB / RocksDB** — rejected: native bindings fail on architectures not covered by prebuilt binaries, causing install failures on ARM Macs and Alpine Linux containers.

## Rationale

`sql.js` compiles SQLite to WebAssembly, meaning zero native bindings and a consistent binary on every platform Mergen supports. SQLite provides ACID guarantees, efficient range scans on timestamp columns, and a familiar query language. The database file lives at `~/.mergen/history.db` so it survives server restarts without any external service.

## Consequences

- The `sql.js` WASM binary adds ~1.2 MB to the installed package.
- Write throughput is single-threaded; burst ingestion that saturates the ring buffer faster than SQLite can flush will silently drop the overflow (ring buffer eviction is the design intent).
- Schema migrations must be handled in `sqlite-store.ts`; there is no ORM migration framework.
