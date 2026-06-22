# ADR-006: Route non-critical analytics queries to read replicas

**Date:** 2026-06-22
**Status:** Accepted

## Decision

All analytics and non-critical reporting queries must be routed to read replica nodes rather than the primary database node.

## Alternatives considered

- **Routing all queries to primary** — rejected: causes CPU spikes on primary, leading to database connection pool exhaustion.
- **Caching query results in Redis** — rejected: stale reporting data is unacceptable for billing reconciliation.

## Rationale

By routing heavy analytics queries to the read replicas, the primary database node remains responsive during peak traffic hours, drastically reducing connection pool timeout incidents.

## Consequences

- Applications must maintain two distinct database connection pools (primary and read replica).
- Slight data replication lag (typically <500ms) is expected for analytics queries.
