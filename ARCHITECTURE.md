# Mergen — Architecture, System & Pricing Report

> Generated: April 25, 2026 · Server v1.0.0

---

## 1. What Is Mergen?

Mergen is a **local browser observability bridge** that sits between your running web app and your AI coding assistant (Cursor, Claude, Windsurf, etc.). It captures runtime telemetry — console events, network calls, DOM snapshots — and exposes them to the AI via the **Model Context Protocol (MCP)**. The AI can then diagnose bugs with real execution data instead of guessing from static code.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Developer's Machine                      │
│                                                             │
│  ┌──────────────┐   HTTP POST     ┌─────────────────────┐  │
│  │ Browser /    │ ─────────────►  │  Mergen MCP Server  │  │
│  │ Browser Ext  │  (localhost:    │  (Express + MCP)    │  │
│  │ (JS agent)   │   3000–3010)    │                     │  │
│  └──────────────┘                 │  ┌───────────────┐  │  │
│                                   │  │  Ring Buffer  │  │  │
│  ┌──────────────┐   MCP/stdio     │  │  (200 events) │  │  │
│  │  AI Host     │ ◄─────────────  │  └───────────────┘  │  │
│  │  (Cursor /   │                 │  ┌───────────────┐  │  │
│  │   Claude /   │                 │  │  Causal Chain │  │  │
│  │   Windsurf)  │                 │  │  Engine       │  │  │
│  └──────────────┘                 │  └───────────────┘  │  │
│                                   │  ┌───────────────┐  │  │
│  ┌──────────────┐   /health poll  │  │  Source Map   │  │  │
│  │  VS Code     │ ◄─────────────  │  │  Resolver     │  │  │
│  │  Extension   │                 │  └───────────────┘  │  │
│  │  (Sidebar)   │                 └─────────────────────┘  │
│  └──────────────┘                          │               │
│                                            │ HTTPS         │
│                                   ┌────────▼────────┐      │
│                                   │  LemonSqueezy   │      │
│                                   │  (billing /     │      │
│                                   │   webhooks)     │      │
│                                   └─────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Component Inventory

| File | Role |
|------|------|
| `server/src/index.ts` | Entry point. Boots Express + MCP server, inits license/usage/team, auto-finds open port (3000–3010) |
| `server/src/buffer.ts` | O(1) **ring buffer** (200-event cap). Typed Zod schemas for `ConsoleEvent`, `NetworkEvent`, `ContextSnapshot` |
| `server/src/ingest.ts` | Express router at `/ingest`. Validates incoming events, enforces plan buffer limits, writes to ring buffer |
| `server/src/tools.ts` | Registers 6 MCP tools: `get_recent_logs`, `get_network_activity`, `get_dom_context`, `analyze_runtime`, `get_status`, `clear_buffer` |
| `server/src/causal.ts` | **Hypothesis Engine + Context Pack**. Tracks event dependencies (`request → response → state mutation → crash`) rather than time proximity. Emits a structured `Hypothesis` (summary, confidence score, causal path, fix hint) and renders a Context Pack with a TL;DR diagnosis at the top |
| `server/src/sourcemap.ts` | Source map resolution. Reads `.map` files from disk, resolves minified stack frames to original file/line/snippet |
| `server/src/prompts.ts` | Versioned system prompt. Section-aware instructions telling the LLM how to read a Context Pack |
| `server/src/license.ts` | License lifecycle: activate/deactivate/validate key, persist to `~/.mergen/license.json`, unified plan mapping |
| `server/src/usage.ts` | Per-month credit tracking. Persists to `~/.mergen/usage.json`. Handles overage accumulation and flush on shutdown |
| `server/src/billing.ts` | Express router for LemonSqueezy webhooks (subscription created/updated/cancelled, usage reports). HMAC-SHA256 signature verification |
| `server/src/team.ts` | Team sync scaffolding. Persists member name + team token to `~/.mergen/team.json` |
| `server/src/plans.ts` | **Single source of truth** for all plan definitions (see §5) |
| `server/src/paths.ts` | Centralised file path constants (`~/.mergen/` directory, all JSON files) |
| `server/src/logger.ts` | Pino structured logger (JSON in prod, pretty in dev) |
| `extension/` | Browser extension (JS agent). Intercepts `console.*`, `fetch`, `XMLHttpRequest`, DOM snapshots. POSTs to local server |
| `vscode-extension/` | VS Code sidebar extension. Polls `/health`, shows live buffer size, credit usage, and server status in a webview panel |
| `scripts/mergen.ts` | CLI wrapper. Commands: `start`, `stop`, `status`, `clear` |
| `SETUP.md` | End-to-end setup guide (install, extension, MCP config, AI host integration) |

---

## 4. Data Flow — Anatomy of One Debug Session

```
1.  Dev opens browser with the Mergen browser extension loaded.

2.  App throws a runtime error:
    console.error("Cannot read properties of undefined")

3.  Browser extension captures:
    - ConsoleEvent  { level:'error', args:[…], stack:'…', url, timestamp }
    - ContextSnapshot { url, title, activeElement, component, localStorage, … }
    - (optional) NetworkEvent if a failed fetch preceded the error

4.  Extension  POST /ingest  →  Mergen Express server (127.0.0.1:3000)
    - Zod-validated
    - Plan buffer limit checked (free=50, paid=200)
    - Written to RingBuffer O(1)

5.  Dev says to the AI: "Why is my app crashing?"

6.  AI host calls MCP tool: analyze_runtime

7.  Mergen's causal.ts:
    a. Reads all events from the ring buffer
    b. Builds a timeline (navigation → network calls → warnings → errors)
    c. Resolves minified stack frames via source maps
    d. Correlates network failures within ±2 s window of each error
    e. Renders a structured "Context Pack" markdown document

8.  Context Pack is returned to the AI as the tool response.
    AI reads it and produces a precise, cited diagnosis.

9.  Credit is consumed (solo_standard: 1 of 500/month, solo_pro: unlimited).
    If overage, a usage record is reported to LemonSqueezy.
```

---

## 5. Pricing Plans

| Plan | Price | Buffer | `analyze_runtime` Credits | Overage | Team Sync |
|------|-------|--------|--------------------------|---------|-----------|
| **Free** | $0 | 50 events | 0 (disabled) | — | ✗ |
| **Solo Standard** | $19 / mo | 200 events | 500 / month | $0.05 / call | ✗ |
| **Solo Pro** | $39 / mo | 200 events | ∞ Unlimited | — | ✗ |
| **Team** | $49 / seat / mo | 200 events | ∞ Unlimited | — | ✓ |
| **Pay-as-you-go** | $0 base | 200 events | 0 included | $0.05 / call | ✗ |

### 5.1 Credit Mechanics

- **One credit = one `analyze_runtime` call.** All other tools (`get_recent_logs`, `get_network_activity`, `get_dom_context`, `get_status`, `clear_buffer`) are **free and unlimited**.
- **Solo Standard overage:** after 500 credits/month, each additional call is reported to LemonSqueezy as a usage-based billing record ($0.05). The user sees a warning in the MCP response at ≤20% remaining and at 0.
- **Pay-as-you-go:** every call costs $0.05, no subscription required. Requires a LemonSqueezy subscription item ID stored in `~/.mergen/license.json`.
- **Solo Pro / Team:** no credit cap, no overage charges.
- Counters reset on the **1st of every calendar month at 00:00 UTC**.

### 5.2 LemonSqueezy Variant IDs (env vars)

| Plan | Env Var |
|------|---------|
| Solo Standard | `LS_VARIANT_SOLO_STANDARD` |
| Solo Pro | `LS_VARIANT_SOLO_PRO` |
| Team | `LS_VARIANT_TEAM` |
| Pay-as-you-go | `LS_VARIANT_PAYG` |

---

## 6. MCP Tools Reference

| Tool | Cost | Description |
|------|------|-------------|
| `get_recent_logs` | Free | Returns console events. Filterable by level (`error`/`warn`/`log`) and time window (`since` ms) |
| `get_network_activity` | Free | Returns fetch/XHR events. Filterable by HTTP status code |
| `get_dom_context` | Free | Returns DOM + storage snapshots captured at each `console.error` |
| `analyze_runtime` | **1 credit** | **Routine debugging tool** — call as part of your normal workflow, not just when things break. Tracks event dependencies, emits a single root-cause diagnosis (TL;DR first), causal path, and fix hint |
| `get_status` | Free | Returns plan name, credits used/remaining, next reset date, buffer size, server version |
| `clear_buffer` | Free | Clears all events from the ring buffer |

---

## 7. Context Pack Format

The `analyze_runtime` tool returns a structured markdown document. It **leads with the answer**, not the data:

```
### 🚨 Mergen Context Pack

> 🟢 HIGH: `userToken` is null — auth token from `/api/login` was not persisted to localStorage — code reads `userToken` and gets null.
> 💡 Fix: After `/api/login` resolves, call `localStorage.setItem('userToken', response.token)` before navigating.

### §1  Source Snippet    — exact crash line in original source + code window
### §2  Invisible State   — localStorage / sessionStorage at moment of crash
### §3  Network Pulse     — last 3 API calls with full Req/Res headers + bodies
### §4  DOM Trace         — focused element, component, current URL
### §5  Mergen Diagnosis  — structured Hypothesis: confidence, causal path, evidence, fix hint
### §6  Causal Timeline   — all events in chronological order
### §7  Task Prompt       — explicit 4-point output contract for the LLM
```

### 7.1 Hypothesis Engine (§5)

`causal.ts` tracks **event dependencies**, not time proximity:

```
request → response → state mutation → render → crash
```

Each dependency produces a structured `Hypothesis`:

```ts
{
  summary:         "auth token from /api/login was not persisted — code reads userToken, gets null",
  confidence:      "HIGH",
  confidenceScore: 0.80,
  evidence: [
    "POST /api/login → 200 OK",
    "localStorage.userToken = null at crash time",
    "Crash at AuthGuard.tsx:42 in checkAuth"
  ],
  causalPath: [
    "POST /api/login → 200 OK",
    "Expected: token stored to localStorage.userToken",
    "Actual: localStorage.userToken = null/missing",
    "Crash: code reads userToken, gets null"
  ],
  fixHint: "After /api/login resolves, call localStorage.setItem('userToken', response.token) before navigating."
}
```

Signals that contribute to `confidenceScore`:
| Signal | Score |
|--------|-------|
| Source frame resolved | +0.15 |
| Null/empty localStorage key | +0.25 |
| Successful auth call + missing token (strongest) | +0.40 |
| Failed network call before crash | +0.30 |
| Warning immediately before error | +0.10 |

---

## 8. Security Model

| Concern | Approach |
|---------|----------|
| Network exposure | Server binds to `127.0.0.1` only — no external traffic possible |
| Ingest auth | Optional `x-mergen-secret` header; set via `MERGEN_SECRET` env var |
| Webhook integrity | HMAC-SHA256 verification of `X-Signature` header on every LemonSqueezy webhook |
| Input validation | Zod schema validation on every ingest event; `1mb` Express body limit |
| Rate limiting | Configurable requests-per-minute with LRU-cache token bucket on `/ingest` |
| License keys | Stored locally in `~/.mergen/license.json`; only sent to LemonSqueezy's own validation API |

---

## 9. Reliability & Performance

| Feature | Detail |
|---------|--------|
| **Port auto-discovery** | Scans ports 3000–3010; binds first available. Extension and CLI discover active port via `/health` |
| **O(1) ring buffer** | Fixed 200-slot array with head+count pointers. `push()` never allocates; no `Array.shift()` |
| **Source map LRU cache** | Resolved frames cached by `file:line:col` key — avoids re-parsing `.map` files on every call |
| **Graceful shutdown** | `SIGTERM`/`SIGINT` handlers flush pending overage credits to LemonSqueezy before exit |
| **Background license validation** | Re-validated every 24 h in the background; never blocks the MCP transport |
| **Overage batching** | 5-second debounce timer batches rapid `analyze_runtime` calls into a single LS API request |
| **Exponential back-off** | Overage flush retries up to 3 times: 2 s → 4 s → 8 s; surviving pending credits flushed on next startup |
| **Outbound timeouts** | All `fetch` calls to LemonSqueezy have an 8-second `AbortSignal.timeout` |

---

## 10. Developer Experience

| Feature | How to Access |
|---------|--------------|
| Start the server | `mergen start` · or · `npm start` in `server/` |
| Check status | `mergen status` (CLI) · or · `get_status` MCP tool |
| Stop the server | `mergen stop` |
| Clear buffer | `mergen clear` · or · `clear_buffer` MCP tool |
| Live sidebar | VS Code extension → Mergen panel in Activity Bar |
| Low-credit warning | Shown inline in every MCP tool response when ≤ 20% credits remain |
| First-overage notice | One-time `💳` message when crossing the included-credit wall |
| Full setup guide | `SETUP.md` in repo root |

---

## 11. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js (ESM modules) | 20 |
| Language | TypeScript | 5.3 |
| TS target | ES2022 | — |
| HTTP server | Express | 4.18 |
| MCP protocol | `@modelcontextprotocol/sdk` | 1.29 |
| Schema validation | Zod | 3.25 |
| Source maps | `source-map` | 0.7 |
| LRU cache | `lru-cache` | 11 |
| Logging | Pino | 10 |
| Billing SDK | `@lemonsqueezy/lemonsqueezy.js` | 4.0 |
| Test framework | Vitest | 4.1 |
| Dev watch | tsx | 4.x |
| VS Code extension | VS Code Extension API + Webview | — |
| Build | `tsc` + `scripts/build-cli.mjs` | — |

---

## 12. Test Coverage

| Suite | File | Key Scenarios |
|-------|------|---------------|
| Buffer | `__tests__/buffer.test.ts` | Ring wrap-around, level filtering, `since` timestamp filtering |
| Sourcemap | `__tests__/sourcemap.test.ts` | Frame resolution, missing map, malformed stack |
| Causal | `__tests__/causal.test.ts` | Empty buffer, correlated network, state block, full timeline |
| Ingest | `__tests__/ingest.test.ts` | Valid events, plan buffer limits, Zod rejection |
| Usage | `__tests__/usage.test.ts` | Credit limits, month rollover, overage flush, retry back-off |
| Billing | `__tests__/billing.test.ts` | Webhook HMAC validation, subscription lifecycle |
| License | `__tests__/license.test.ts` | Activate/deactivate, plan mapping, background revalidation |
| Validation | `__tests__/validation.test.ts` | Schema edge cases |

**Total: 80 tests · 100% pass**

---

## 13. File Storage Layout

All persistent state lives under `~/.mergen/`:

```
~/.mergen/
├── license.json    # { key, planId, lsSubscriptionItemId, validatedAt }
├── usage.json      # { month, used, overageReported, overagePending }
└── team.json       # { memberName, teamToken }
```

---

## 14. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LS_API_KEY` | For billing | LemonSqueezy API key — enables overage reporting |
| `LS_WEBHOOK_SECRET` | For billing | HMAC secret for webhook signature verification |
| `LS_VARIANT_SOLO_STANDARD` | For billing | LemonSqueezy variant ID for Solo Standard plan |
| `LS_VARIANT_SOLO_PRO` | For billing | LemonSqueezy variant ID for Solo Pro plan |
| `LS_VARIANT_TEAM` | For billing | LemonSqueezy variant ID for Team plan |
| `LS_VARIANT_PAYG` | For billing | LemonSqueezy variant ID for Pay-as-you-go |
| `MERGEN_SECRET` | Optional | Shared secret for the `/ingest` endpoint |
| `LOG_LEVEL` | Optional | Pino log level (`info`, `debug`, `warn`, `error`) |

---

## Summary

Mergen is a **single-binary MCP server** that runs locally, has zero external dependencies at runtime, costs nothing for basic use, and unlocks deep AI-assisted debugging for **$19–$49/month**. The architecture is intentionally minimal: one ring buffer, one causal engine, one MCP transport. Every design decision optimises for:

- **Latency** — local-only, O(1) buffer, LRU source map cache
- **Precision** — source-mapped frames, ±2 s causal correlation, 7-section structured Context Pack
- **Privacy** — no telemetry leaves the machine; all data stays in `~/.mergen/`
- **Reliability** — exponential back-off, graceful shutdown flush, background license revalidation
- **Simplicity** — one `mergen start` command, works with any MCP-compatible AI host
