# Mergen — System Analysis Report

> **Generated:** 2026-06-02  
> **Scope:** Full server codebase (`server/src/`) — intelligence engine, sensor layer, billing, licensing, telemetry, and persistence.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Boot Sequence](#3-boot-sequence)
4. [Sensor Layer](#4-sensor-layer)
5. [Intelligence Engine](#5-intelligence-engine)
6. [MCP Tool Surface](#6-mcp-tool-surface)
7. [Billing & Licensing](#7-billing--licensing)
8. [Usage Tracking](#8-usage-tracking)
9. [Pricing Plans](#9-pricing-plans)
10. [Team Sync](#10-team-sync)
11. [Persistence & File Paths](#11-persistence--file-paths)
12. [Security Model](#12-security-model)
13. [Telemetry](#13-telemetry)
14. [REST API Surface](#14-rest-api-surface)
15. [Key Constants & Tunables](#15-key-constants--tunables)
16. [Identified Risks & Observations](#16-identified-risks--observations)

---

## 1. System Overview

Mergen is a **local-first, open-core developer observability tool** that bridges the browser's runtime telemetry (console logs, network events, DOM snapshots) with AI coding assistants via the **Model Context Protocol (MCP)**.

| Layer | Technology | Role |
|---|---|---|
| Browser Extension | Chrome / Firefox (Manifest V3) | Captures runtime events; POSTs to local server |
| VS Code Extension | TypeScript / VS Code API | Sidebar panel, status bar, MCP host bridge |
| **Local Server** | Node.js / Express / TypeScript | Ring buffer, Hypothesis Engine, MCP server, billing |
| MCP Transport | stdio (JSON-RPC) | Feeds structured context packs to AI agents |
| Persistence | `~/.mergen/` (JSON + SQLite) | License, usage, calibration, team state |
| Billing | LemonSqueezy | License key activation, usage-based overage reporting |

The core value proposition: **continuous, automatic causal-chain diagnosis** — the server watches the buffer and rebuilds a "Context Pack" without the developer ever asking.

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser Tab                               │
│  content.js → intercepts console / fetch / XHR / WebSocket      │
│  background.js → batches & POSTs to http://127.0.0.1:3000-3010  │
└─────────────────────────────┬────────────────────────────────────┘
                              │ POST /ingest
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Local MCP Server                             │
│                                                                  │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────────┐  │
│  │  Ring Buffer│   │ SQLite Store │   │  Watcher (15s tick)  │  │
│  │  (200 events│   │  (1hr history│   │  Auto-triggers causal│  │
│  │  in-memory) │   │  sql.js WASM)│   │  rebuild on activity │  │
│  └──────┬──────┘   └──────────────┘   └──────────┬───────────┘  │
│         │                                         │              │
│         └──────────────┬──────────────────────────┘              │
│                        ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              Hypothesis Engine                           │    │
│  │  causal.ts → orchestrator                                │    │
│  │  detectors.ts → N independent detectors                  │    │
│  │  calibration.ts → feedback loop, self-improving scores   │    │
│  │  hypothesis-history.ts → ring of last 20 builds          │    │
│  │  format-context-pack.ts → renders pack for MCP/panel     │    │
│  └──────────────────────┬───────────────────────────────────┘    │
│                         │                                        │
│         ┌───────────────┴──────────────┐                         │
│         ▼                              ▼                         │
│  ┌─────────────┐              ┌────────────────┐                 │
│  │  MCP stdio  │              │  REST API      │                 │
│  │  (tools.ts) │              │  (routes/)     │                 │
│  │  AI agents  │              │  VS Code panel │                 │
│  └─────────────┘              └────────────────┘                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              Billing & Identity                          │    │
│  │  license.ts → activation/validation via LemonSqueezy     │    │
│  │  usage.ts   → monthly credit counter + overage flush     │    │
│  │  billing.ts → webhook handler (subscription events)      │    │
│  │  plans.ts   → plan definitions & feature flags           │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                              │ stdio JSON-RPC
                              ▼
                   AI Agent (Claude, Cursor, etc.)
```

---

## 3. Boot Sequence

Executed in `index.ts` in strict order:

| Step | Action | Notes |
|---|---|---|
| 1 | `lemonSqueezySetup()` | Configures LS SDK with `LS_API_KEY` |
| 2 | `initLicense()` | Loads `~/.mergen/license.json`; serves from cache immediately; validates in background |
| 3 | `initUsage()` | Loads `~/.mergen/usage.json`; flushes any pending overage from previous session |
| 4 | `initTeam()` | Loads `~/.mergen/team.json` if present |
| 5 | `initTelemetry()` | Loads telemetry opt-in state |
| 6 | Load/generate local secret | Writes `~/.mergen/secret` on first run |
| 7 | `setBufferSizeGetter()` | Connects plan's `bufferSize` to the ring buffer |
| 8 | `historyStore.init()` | Initialises SQLite (sql.js WASM) for 1-hour history |
| 9 | `startWatcher()` | Starts 15s background loop |
| 10 | `createApp()` + HTTP listen | Express server, port auto-discovery 3000–3010 |
| 11 | `McpServer` + `StdioServerTransport` | MCP stdio server starts |
| 12 | `registerTools()` | All MCP tool handlers registered |
| 13 | `checkForUpdates()` | Background npm version check |

---

## 4. Sensor Layer

### Ring Buffer (`buffer.ts`)
- **Capacity:** plan-gated (default 200 events, same for all plans — moat is the engine, not the buffer)
- **Event types:** `console`, `network`, `context` (DOM snapshot), `websocket`, `sse`
- **Validation:** Zod schemas on every ingest call — malformed events are rejected
- **Thread safety:** in-process, synchronous ring; no locking needed

### Extended Buffer (`extended-buffer.ts`)
- Supplements the ring with burst-detection logic (net_burst, slow_burst triggers)

### SQLite History Store (`sqlite-store.ts`)
- **Purpose:** 1-hour event replay beyond the 200-event ring
- **Engine:** `sql.js` pure WASM — no native compilation
- **Flush cadence:** every 50 writes (amortises fsync cost)
- **Pruning:** events older than 1 hour are deleted on each flush cycle
- **Path:** `~/.mergen/history.db`

### Watcher (`watcher.ts`)
- **Interval:** 15s default (overridable via `MERGEN_WATCH_INTERVAL_MS`)
- **Disable:** `MERGEN_WATCH=0`
- **Logic:** on each tick, checks if buffer has grown since last tick; if yes, fires `notifyPeriodic()` on `HypothesisHistory`
- **Cost:** zero I/O, zero LLM — purely in-memory buffer inspection

### Ingest (`sensor/ingest.ts`)
- POST `/ingest` — accepts `BrowserEvent[]`, validates each, pushes into ring + SQLite + notifies hypothesis history + broadcasts to team SSE stream

### Source Maps (`sourcemap.ts`)
- Resolves minified stack frames to original file/line/column
- Used by causal engine to enrich `ErrorBlock.primaryFrame`

---

## 5. Intelligence Engine

### Causal Engine (`causal.ts`)

The orchestrator for a single causal-chain rebuild. Steps:

1. Pull recent events from ring buffer
2. Identify primary error (`ErrorBlock`) and correlated state snapshot (`StateBlock`)
3. Correlate network calls within a 5s window before the error
4. Run all detectors in `ALL_DETECTORS` array
5. Apply `applyCalibration()` to demote/suppress hypotheses with poor track records
6. Rank by `confidenceScore` descending
7. Resolve source map frames
8. Format into a Context Pack string (`format-context-pack.ts`)

**Output types:**
```
CausalChain
  ├── events: CausalEvent[]        (timeline of what happened)
  ├── primaryError: ErrorBlock
  ├── stateAtError: StateBlock
  ├── correlatedNetwork: CorrelatedNetworkCall[]
  └── hypotheses: Hypothesis[]     (ranked, calibration-adjusted)
```

### Detectors (`detectors.ts`)

Each detector is a pure function `(DetectorInput) => Hypothesis | null`. They run **independently** on the same input — no shared state between detectors.

| Detector Tag | What it detects |
|---|---|
| `auth_token_not_persisted` | Successful login but token missing from localStorage at crash time |
| `network_failure_before_error` | HTTP error/timeout correlated with a JS crash |
| `slow_api_silent` | Slow API responses (>500ms) even without a JS error |
| `cors_error` | CORS-related network failures |
| `unhandled_promise` | Uncaught promise rejections |
| `undefined_prop_access` | `Cannot read properties of undefined/null` pattern |
| `state_mutation` | Unexpected state change near crash |
| *(+ more)* | Extensible array; new detectors just pushed to `ALL_DETECTORS` |

**Scoring:**
- Each detector computes a `confidenceScore` (0–1)
- `scoreToConfidence()` maps: `≥0.65 → HIGH`, `≥0.40 → MEDIUM`, `≥0.25 → LOW`
- Hypotheses below `MIN_HYPOTHESIS_SCORE = 0.25` are discarded

### Calibration Engine (`calibration.ts`)

The self-improving feedback loop — the most architecturally important module.

**How it works:**
1. Every hypothesis surfaces with a stable `pid` (prediction ID, UUID)
2. User or AI posts `POST /feedback { pid, verdict: 'correct' | 'wrong' | 'partial' }`
3. Verdicts are stored in `~/.mergen/calibration.json` (bounded ring, max 500 verdicts)
4. `applyCalibration()` reads empirical accuracy per detector tag:
   - `< SUPPRESS_THRESHOLD (20%)` → hypothesis culled entirely
   - `< DEMOTE_THRESHOLD (50%)` → `HIGH` demoted to `MEDIUM`
5. Minimum 5 samples required before calibration takes effect (small samples are noisy)

**Temporal decay:** verdicts older than 30 days count at 50% face value — lets an improved detector recover its standing in ~3 weeks.

**Privacy:** only `tag + confidence + verdict` stored — never error messages, stack traces, or URLs.

### Hypothesis History (`hypothesis-history.ts`)

- **Ring size:** 20 entries
- **Rebuild debounce:** 2s — burst of 50 errors → 1 rebuild
- **Trigger reasons:** `error`, `pageload`, `net_burst`, `slow_burst`, `hmr`, `periodic`, `manual`
- **Free-tier visibility:** builds run without consuming a credit — gate is on the `analyze_runtime` MCP tool only
- **Calls `recordAnalysis()`** on every rebuild (engagement KPI, not billed)

### Token Budget (`token-budget.ts`)

- Soft token limit on MCP responses (1 token ≈ 4 chars heuristic)
- Truncates item arrays with a `[...truncated, +N more]` footer
- Prevents context window saturation in AI hosts

---

## 6. MCP Tool Surface

Registered in `tools.ts` via `registerTools(server: McpServer)`.

| Tool | Credit Cost | Description |
|---|---|---|
| `analyze_runtime` | **1 credit** | Full causal chain + ranked hypotheses. The primary paid surface. |
| `get_recent_logs` | Free | Recent console events with severity/pattern filtering |
| `get_network_activity` | Free | Recent network events with failure filtering |
| `get_dom_context` | Free | Latest DOM/state snapshot |
| `get_status` | Free | Server health, plan, usage snapshot, last activity |
| `get_component_tree` | Free | React/Vue component tree from last context snapshot |
| `clear_buffer` | Free | Flush the event ring buffer |
| `quick_check` | Free | Short summary of current errors/warnings |
| `explain_warning` | Free | Explain a specific warning in plain language |
| `session_summary` | Free | Summary of current debug session state |
| `suggest_logging_locations` | Free | Recommend where to add logging based on errors |
| `get_recent_logs` | Free | Debug session tools (start/checkpoint/end/diff) |

**Call tracking:** `toolCallCounts` (in-process, never persisted) and `lastMcpCallAt` are exported for the `/usage` endpoint — used to optimize free→paid conversion messaging.

**Credit bar:** `analyze_runtime` responses include a visual `[████████░░] 80%` bar showing quota consumption.

---

## 7. Billing & Licensing

### License Flow (`license.ts`)

```
Purchase on LemonSqueezy
    → Email with license key
    → POST /license { key }
    → server calls LS activateLicense(key, "mergen-<hostname>")
    → variant_id → planId mapping
    → persisted to ~/.mergen/license.json
    → background re-validation on every startup
```

**Key design decisions:**
- **Serve from cache immediately** on startup — zero latency for the user
- **Background validation** — revocations applied asynchronously; LS API errors trust the cache
- **Multiple activations** per key supported (up to LS plan limit, per machine hostname)
- **Deactivation** calls `deactivateLicense()` then deletes the local file

### Webhook Handler (`billing.ts`)

| Event | Action |
|---|---|
| `subscription_created` | Write planId + status + lsSubscriptionItemId to license file |
| `subscription_updated` | Update plan + status |
| `subscription_expired` | Set status = `inactive` (downgrades to free) |
| `order_created` | Placeholder for future PAYG top-ups |

**Signature verification:** HMAC-SHA256 on raw body using `LS_WEBHOOK_SECRET`. Fail-closed — returns 401 if secret is not configured. Uses `crypto.timingSafeEqual` with length guard to prevent timing attacks.

---

## 8. Usage Tracking

### State (`~/.mergen/usage.json`)

| Field | Type | Description |
|---|---|---|
| `month` | `YYYY-MM` | Current billing month |
| `used` | `number` | Total credits consumed (included + overage) |
| `overageReported` | `number` | Overage already sent to LemonSqueezy |
| `overagePending` | `number` | Overage queued but not yet sent |
| `analysesByDay` | `Record<YYYY-MM-DD, number>` | Daily auto-rebuild counts (not billed) |

### Credit Flow (one call to `consumeCredit()`)

```
consumeCredit()
  └─ withLock()  [mutex — all R-M-W serialised]
       ├─ month changed? → flush pending overage → reset counters
       ├─ used < included?
       │    ├─ increment used, save
       │    ├─ remaining == 0? → show "last credit" notice
       │    └─ remaining ≤ threshold? → show low-credit warning
       ├─ overageCentsPerCredit > 0?
       │    ├─ increment used + overagePending, save
       │    ├─ isFirstOverage? → show consent notice
       │    └─ scheduleFlush() [debounced 5s]
       └─ else → { allowed: false, reason: "limit reached + upgrade prompt" }
```

### Overage Flush

- **Debounce:** 5s — rapid calls batched into one LS API POST
- **Retry:** 3 attempts, exponential back-off: 2s → 4s → 8s
- **On startup:** flushes any `overagePending > 0` left from last session
- **On shutdown:** `flushOverageOnShutdown()` cancels debounce timer and flushes immediately
- **On month rollover:** flushes pending overage before resetting counters

### Engagement KPI (`analysesByDay`)

- Incremented on every automatic causal-chain rebuild (not a billing event)
- Rolling 30-day window — older days are trimmed on write
- Persisted every 5th increment to amortise disk I/O
- Exposed in `/usage` snapshot as `analysesToday` and `analysesAvgPerDay7d`

---

## 9. Pricing Plans

| Plan | Price | Credits/mo | Overage | Burst | Team Features |
|---|---|---|---|---|---|
| `free` | $0 | 100 | Hard cap (no billing) | 10/hr | — |
| `solo_starter` | $15/mo | 500 | $0.03/call | None | — |
| `solo_pro` | $29/mo | 2,000 | $0.02/call | None | — |
| `solo_power` | $49/mo | 5,000 | $0.01/call | None | — |
| `team` | $39/seat/mo | 3,000/seat (pooled) | $0.02/call | None | Team sync |
| `team_pro` | $59/seat/mo | 8,000/seat (pooled) | $0.01/call | None | Sync + Insights |
| `pay_as_you_go` | $0 base | 0 included | $0.05/call | None | — |

**Key design rationale:**
- No "Unlimited" tier — prevents unbounded infra cost + scales revenue with usage
- Free tier gets 100 credits (enough to build habit, ~3–4/day)
- Free tier hard-cap prevents surprise bills; upgrade nudge on exhaustion
- PAYG rate ($0.05) is intentionally high to nudge users toward subscriptions

---

## 10. Team Sync

### Architecture (`team.ts`)

- Members share a **team token** (stored in `~/.mergen/team.json`)
- Built-in relay: SSE stream at `GET /team/stream`
- Events pushed via `POST /team/push` (authenticated by team token)
- `broadcastToTeam()` called on every ingest — fans events to all connected SSE subscribers
- Token comparison uses `crypto.timingSafeEqual` with length guard

### State (`~/.mergen/team.json`)

| Field | Description |
|---|---|
| `token` | Shared HMAC secret |
| `memberName` | Human-readable name (default: hostname) |
| `relayUrl` | External relay URL, `null` = use built-in |
| `enabled` | Boolean |
| `joinedAt` | ISO timestamp |

**Plan gating:** team features (`teamSync`, `teamInsights`) are boolean flags on the plan object — checked at the route level.

---

## 11. Persistence & File Paths

All paths defined in the single source of truth: `sensor/paths.ts`.

| Path | Contents | Reset behaviour |
|---|---|---|
| `~/.mergen/license.json` | Key, instanceId, planId, status, lsSubscriptionItemId | Updated by webhook / activation |
| `~/.mergen/usage.json` | month, used, overage counters, analysesByDay | Monthly rollover |
| `~/.mergen/calibration.json` | Last 500 detector verdicts | Rolling ring, never resets |
| `~/.mergen/team.json` | Team token + relay config | Manual init/delete |
| `~/.mergen/telemetry.json` | Opt-in flag + anonymous installId | Manual |
| `~/.mergen/secret` | Local HMAC secret for REST auth | Generated once on first boot |
| `~/.mergen/history.db` | SQLite: 1-hour event history | Pruned continuously |

---

## 12. Security Model

| Concern | Mechanism |
|---|---|
| **REST mutation auth** | `x-mergen-secret` header required on all non-GET requests to sensitive paths |
| **CORS** | Wildcard `*` — safe because server binds to `127.0.0.1` only |
| **Webhook signature** | HMAC-SHA256 + `timingSafeEqual` + length guard; fail-closed if `LS_WEBHOOK_SECRET` unset |
| **Team relay auth** | `timingSafeEqual` token comparison on `POST /team/push` |
| **Calibration privacy** | Only `tag + confidence + verdict` stored — no error messages, URLs, or stack traces |
| **Telemetry privacy** | Anonymous UUID only; no PII; opt-in (default off) |
| **Secret rotation** | `~/.mergen/secret` regenerated if deleted; VS Code extension reads it on start |

---

## 13. Telemetry

**Default state:** disabled (`MERGEN_TELEMETRY=1` or `POST /telemetry { enabled: true }` to opt in).

**What is collected (opt-in only):**
- Anonymous `installId` (UUID, generated locally)
- Tool call counts per tool name
- Active `planId`
- Server version + Node major version

**What is never collected:** source code, log content, network bodies, context packs, license keys, emails, file paths, repo names, IP-based fingerprinting.

**Send cadence:** at most once per 24h. Network failures are silently swallowed.

**Endpoint:** configurable via `MERGEN_TELEMETRY_URL` — not shipped with a live default, so opt-in has no effect until the operator enables a collector.

---

## 14. REST API Surface

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/ingest` | None (local only) | Receive browser events |
| `GET` | `/health` | None | Server status + active signals |
| `GET` | `/status` | None | Alias for /health with usage snapshot |
| `GET` | `/usage` | None | Current usage snapshot + tool call counts |
| `GET` | `/last-pack` | None | Latest causal context pack (full) |
| `GET` | `/hypotheses` | None | Last N hypothesis history entries |
| `POST` | `/feedback` | Secret | Submit verdict for a hypothesis pid |
| `POST` | `/diagnose` | None | Trigger manual causal rebuild |
| `POST` | `/checkpoint` | Secret | Debug session checkpoint |
| `GET/POST/DELETE` | `/license` | Secret (mutating) | License activation / status / deactivation |
| `POST` | `/billing/webhook` | HMAC signature | LemonSqueezy webhook receiver |
| `POST` | `/team/init` | Secret | Enable team sync |
| `DELETE` | `/team` | Secret | Disable team sync |
| `GET` | `/team` | None | Team state |
| `GET` | `/team/stream` | Token | SSE stream of teammate events |
| `POST` | `/team/push` | Token | Ingest teammate event batch |
| `GET/POST` | `/telemetry` | Secret (POST) | Telemetry opt-in state |
| `GET` | `/calibration` | None | Calibration stats per detector |
| `GET` | `/setup` | None | Setup wizard UI |
| `POST` | `/otel-config` | Secret | OpenTelemetry config |
| `POST` | `/sentry` | HMAC | Sentry webhook |

---

## 15. Key Constants & Tunables

| Constant | Value | Location | Override |
|---|---|---|---|
| Ring buffer size | 200 (all plans) | `plans.ts` | Plan config |
| Hypothesis history ring | 20 entries | `hypothesis-history.ts` | Code only |
| Rebuild debounce | 2,000ms | `hypothesis-history.ts` | Code only |
| Watcher interval | 15,000ms | `watcher.ts` | `MERGEN_WATCH_INTERVAL_MS` |
| Watcher disable | false | `watcher.ts` | `MERGEN_WATCH=0` |
| Overage flush debounce | 5,000ms | `usage.ts` | Code only |
| Overage flush timeout | 8,000ms | `usage.ts` | Code only |
| Overage flush retries | 3 (exp back-off: 2s/4s/8s) | `usage.ts` | Code only |
| analysesByDay window | 30 days | `usage.ts` | Code only |
| analysesByDay save interval | every 5th increment | `usage.ts` | Code only |
| Calibration ring max | 500 verdicts | `calibration.ts` | Code only |
| Min samples for calibration | 5 | `calibration.ts` | Code only |
| Demote threshold | 50% accuracy | `calibration.ts` | Code only |
| Suppress threshold | 20% accuracy | `calibration.ts` | Code only |
| Temporal decay half-life | 30 days (50% weight) | `calibration.ts` | Code only |
| Feedback expiry | 72 hours | `calibration.ts` | Code only |
| Min hypothesis score | 0.25 | `detectors.ts` | Code only |
| SQLite flush cadence | every 50 writes | `sqlite-store.ts` | Code only |
| SQLite retention window | 1 hour | `sqlite-store.ts` | Code only |
| HTTP port range | 3000–3010 | `index.ts` | Code only |
| Telemetry send interval | 24 hours | `telemetry.ts` | Code only |
| Token budget heuristic | 1 token ≈ 4 chars | `token-budget.ts` | Code only |

---

## 16. Identified Risks & Observations

### 🔴 High

| # | Issue | Location | Notes |
|---|---|---|---|
| R1 | `LS_WEBHOOK_SECRET` not set → webhook verification disabled | `billing.ts` | Startup warning logged but server still runs. Production deployments must enforce this. |
| R2 | `LS_API_KEY` not set → overage flush silently skipped | `usage.ts` | Overage accumulates in `overagePending` indefinitely with no user-facing alert. |

### 🟡 Medium

| # | Issue | Location | Notes |
|---|---|---|---|
| R3 | Calibration file corruption silently resets all history | `calibration.ts` | A `try/catch` on `fs.readFile` initialises an empty state — 500 verdicts can be lost on disk error. |
| R4 | `analysesByDay` only persists every 5th increment | `usage.ts` | Up to 4 analyses can be lost on unclean shutdown. Acceptable for an engagement KPI but worth noting. |
| R5 | Background license validation trust-falls on cache if LS unreachable | `license.ts` | Revoked licenses continue to work until the server restarts with a reachable LS API. |
| R6 | SQLite WASM path is resolved relative to the compiled module | `sqlite-store.ts` | Breaks if the binary is moved or installed outside the expected directory structure. |

### 🟢 Low / Observations

| # | Observation | Location |
|---|---|---|
| O1 | `toolCallCounts` is in-process only — lost on restart | `tools.ts` |
| O2 | Team SSE clients stored in a `Map` with no expiry — disconnected clients cleaned only on write error | `team.ts` |
| O3 | `order_created` webhook branch is a no-op placeholder | `billing.ts` |
| O4 | `MERGEN_TELEMETRY_URL` has no live default — telemetry opt-in is effectively a no-op until an endpoint is deployed | `telemetry.ts` |
| O5 | `_resetForTesting` and `_setSleepForTesting` exports are not tree-shaken in production unless the bundler is configured to do so | `usage.ts` |

---

*End of report. Generated by GitHub Copilot on 2026-06-02.*
