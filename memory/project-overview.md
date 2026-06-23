---
name: project-overview
description: What Mergen is, its architecture, and current development direction
metadata:
  type: project
---

Mergen is the Execution and Security Gateway for AI Agents that enforces deterministic controls before AI actions reach your runtime, cloud infrastructure, or developer environment. It sits inline between AI agents and your systems to block unsafe actions, enforce approval workflows, and create auditable execution trails across development and production environments.

**Architecture:** PagerDuty / OpenTelemetry / Docker / Datadog / Local Processes → POST /ingest → ring buffer → MCP server (stdio) with inline security gate -> Claude Code / Cursor / Windsurf / VS Code

**Key files:**
- `server/src/sensor/buffer.ts` — Zod schemas + ring buffer implementation
- `server/src/sensor/ingest.ts` — Rate-limited ingest endpoint
- `server/src/sensor/otel-exporter.ts` — OTLP log export + Prometheus metrics
- `server/src/intelligence/tools.ts` — 30+ MCP Tool registrations (2200+ lines)
- `server/src/intelligence/mcp-resources.ts` — MCP Resources (buffer snapshot, errors, failures)
- `server/src/intelligence/mcp-prompts.ts` — MCP Prompts (auth, network, crash, summary)
- `extension/src/content.js` — Browser event capture

**Why:** Enforces a deterministic execution sandbox and inline policy gate (unconditional blocking of destructive terminal commands, HITL approvals for database migrations, and context cross-referencing) rather than letting AI agents execute arbitrary mutations or run blind with unrestricted shell access.

**How to apply:** The project has paid plan gating — `getActivePlanId()` controls feature access. Always respect plan gates when adding features.


