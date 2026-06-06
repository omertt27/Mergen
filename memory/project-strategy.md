---
name: project-strategy
description: Mergen strategic pivot — Phase 1 Wedge architecture targeting backend/infra enterprise engineers
metadata:
  type: project
---

Mergen has pivoted from browser console log bridge to **AI Agent Infrastructure Layer** — the "Stripe of AI + Infrastructure."

**Target customer:** On-call senior backend engineers at companies running Datadog APM.

**The $100M thesis:** Datadog sells observability to humans. Mergen sells it to AI agents. No one has the multi-source context-routing layer that feeds live infra state into Claude Code, Cursor, etc.

**Phase 1 Wedge (implemented):**
- Single Datadog integration only (not multi-source yet)
- Semantic Compactor: 4-stage pipeline compressing 500KB raw traces → 1KB "Runtime Fact"
- PagerDuty webhook trigger: auto-fetches Datadog trace when incident fires
- `mergen-server init`: guided DD_API_KEY + DD_APP_KEY setup
- MCP tools: `get_incident_context`, `get_datadog_trace`

**Why:** Defensible moat is the Semantic Compactor (Datadog has no incentive to minimize token usage for third-party LLMs) + sitting *above* all observability vendors as the context-routing layer.

**30-day milestone:** One on-call engineer resolves a 2am production incident in under 5 minutes using Mergen + Claude Code instead of 45 minutes of manual Datadog dashboard work.

**Key files:**
- `server/src/datadog/client.ts` — Datadog API client (spans + logs)
- `server/src/datadog/compactor.ts` — 4-stage compaction pipeline
- `server/src/datadog/line-matcher.ts` — Maps production stack frames to local source
- `server/src/datadog/incident-state.ts` — Active incident in-memory state
- `server/src/routes/pagerduty.ts` — PagerDuty v3 webhook → auto-fetch
- `server/src/intelligence/tools-datadog.ts` — MCP tools

**How to apply:** All new feature decisions should be evaluated against "does this help the on-call engineer at 2am?" — not "does this make a better dashboard?"
