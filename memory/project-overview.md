---
name: project-overview
description: What Mergen is, its architecture, and current development direction
metadata:
  type: project
---

Mergen is a local-first production and behavior telemetry MCP server that gives AI IDEs production and runtime memory — remembering what your AI assistant forgets to ensure you never debug the same problem twice.

**Architecture:** PagerDuty / OpenTelemetry / Docker / Datadog / Local Processes → POST /ingest → ring buffer → MCP server (stdio) → Claude Code / Cursor / Windsurf / VS Code

**Key files:**
- `server/src/sensor/buffer.ts` — Zod schemas + ring buffer implementation
- `server/src/sensor/ingest.ts` — Rate-limited ingest endpoint
- `server/src/sensor/otel-exporter.ts` — OTLP log export + Prometheus metrics
- `server/src/intelligence/tools.ts` — 30+ MCP Tool registrations (2200+ lines)
- `server/src/intelligence/mcp-resources.ts` — MCP Resources (buffer snapshot, errors, failures)
- `server/src/intelligence/mcp-prompts.ts` — MCP Prompts (auth, network, crash, summary)
- `extension/src/content.js` — Browser event capture

**Why:** Gives AI agents real browser and runtime behavior context (auth cookies, real errors, visual details, and historical resolution memory) vs. blind code generation.

**How to apply:** The project has paid plan gating — `getActivePlanId()` controls feature access. Always respect plan gates when adding features.

