# Architectural Decision Records

Each significant design decision is captured here so future engineers and AI agents know *why* the system is built the way it is — not just *what* it does.

## Index

| ID | Title | Status |
|----|-------|--------|
| [ADR-001](ADR-001-ring-buffer-architecture.md) | Ring buffer as primary event store | Accepted |
| [ADR-002](ADR-002-mcp-protocol.md) | MCP protocol over custom REST for AI IDE integration | Accepted |
| [ADR-003](ADR-003-sqlite-for-history.md) | SQLite for persistent event history | Accepted |
| [ADR-004](ADR-004-localhost-only-binding.md) | Ingest server binds to 127.0.0.1 by default | Accepted |
| [ADR-005](ADR-005-tier-access-control.md) | Three-tier tool access model (free / pro / all) | Accepted |

## Template

```markdown
# ADR-NNN: Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN

## Decision

One sentence.

## Alternatives considered

- **Option A** — why rejected
- **Option B** — why rejected

## Rationale

Why this option was chosen.

## Consequences

What becomes easier, what becomes harder, what assumptions must hold.
```

## Querying ADRs

```bash
# List all ADRs
curl http://127.0.0.1:3000/adrs

# Search by keyword
curl "http://127.0.0.1:3000/adrs?q=buffer"

# Get one
curl http://127.0.0.1:3000/adrs/ADR-001
```

From an AI IDE, call the `search_adrs` MCP tool before touching any module the tool surfaces.
