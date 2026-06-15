# ADR-005: Three-tier tool access model (free / pro / all)

**Date:** 2024-04-01
**Status:** Accepted

## Decision

Classify every MCP tool into one of three access tiers — `free`, `pro`, or `all` — enforced at call time via `withTierGate()`. The canonical tier for each tool is declared in `tool-manifest.ts`.

## Alternatives considered

- **Binary free / paid split** — rejected: too coarse; some tools are safe to offer for free (read-only diagnostics) while others carry execution risk or significant compute cost that must be gated.
- **Per-tool pricing** — rejected: introduces metering complexity and unpredictable bills; a flat plan with an overage ceiling is simpler to reason about.
- **No gating at all** — rejected: needed for sustainable open-source development; unrestricted execution tools (`execute_fix`, autonomous rollback) represent liability if misused without a paid support contract.
- **RBAC-only (role per user)** — rejected: RBAC is per-user within a team and is a separate concern; tier gating is per-plan at the account level.

## Rationale

Three tiers maps directly onto what engineers actually need:
- `free`: read-only analysis tools that provide immediate value with no risk — `quick_check`, `explain_warning`, `get_recent_logs`.
- `pro`: tools that execute commands, manage incidents, or integrate with paid third-party APIs.
- `all`: tools that have no tier restriction (available to every caller regardless of plan).

The single source of truth in `tool-manifest.ts` prevents tier drift: adding a tool without a tier entry fails the `tool-manifest.test.ts` consistency check.

## Consequences

- New tools must be added to `tool-manifest.ts` with a tier assignment before registration; the manifest test will fail otherwise.
- `withTierGate()` returns a user-readable upgrade prompt rather than an HTTP 403, so AI IDEs surface the message inline.
- Plan IDs are validated in `plans.ts`; adding a new plan tier requires updating both `planAllowsTier()` and the billing integration.
