# How Mergen correlates browser errors to backend commits — without guessing

*Published June 2026 · 8 min read*

---

The standard AI debugging workflow is: copy a stack trace, paste it into the chat, describe what the user was doing, paste the relevant code, ask for a diagnosis. The AI guesses based on static context.

Mergen changes the signal. Instead of guessing from static code, the AI reads live execution data — and crucially, it knows which events are *causally connected* versus which merely happened around the same time.

This works regardless of your stack. Java backend with a React frontend, C# API with Angular, Spring Boot with Vue — if your backend propagates W3C `traceparent` headers (which every modern framework does by default), Mergen can perform a deterministic join between browser errors and backend spans. No proprietary SDK required.

This post explains exactly how that works, with real trace output you can reproduce in < 5 minutes.

---

## The problem with "context" in AI debugging

When you ask an AI to debug an error, you give it context. The AI's job is to reason about what caused what. The problem is that "paste the relevant code and error" gives you the what, not the why.

The why lives in the execution trace:
- Which network request fired before the crash?
- What was in localStorage at the moment the component unmounted?
- Did the CI run for this exact commit have a failing test that covered this path?

None of that is in the code. It happened at runtime.

---

## What Mergen actually captures

Mergen runs three interception layers:

**Layer 1 — Browser** (`@mergen/browser` SDK or Chrome extension)

Intercepts `console.log/warn/error`, `fetch`, and `XMLHttpRequest`. For each fetch, it injects a W3C `traceparent` header:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              ^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^  ^^
              ver        traceId (32 hex)            spanId (16 hex)  flags
```

That 32-character traceId travels with the HTTP request to your backend. If your backend logs it — which any structured logger does automatically — Mergen can perform a **deterministic join** between the browser network event and the backend log line. Not a timestamp guess. The same ID.

**Layer 2 — Backend** (any OTel exporter pointing at `localhost:4318`)

Each inbound server request becomes a `backend_span` event with the traceId extracted from the incoming `traceparent` header. Your backend doesn't need to know about Mergen — it just needs to accept and propagate the standard W3C header, which every modern HTTP framework does by default.

That means: Spring Boot with the OTel Java agent (zero code changes), ASP.NET Core with `OpenTelemetry.Instrumentation.AspNetCore`, Django with `opentelemetry-instrumentation-django`, Rails with `opentelemetry-instrumentation-rack`, or any Go/Rust/PHP service with an OTel exporter. Point it at `localhost:4318` and it works.

**Layer 3 — CI/deployment events** (webhook from GitHub Actions, GitLab CI, Azure DevOps, Jenkins, or a `curl` from any deploy script)

Mergen records the commit SHA, branch, and status for each CI run and deployment. These get joined to browser events via `buildSha` — the git hash embedded in your frontend bundle at build time.

---

## The four confidence levels

When the AI calls `get_unified_timeline`, every event in the output carries one of four confidence labels:

```
`EXACT   `  — same traceId in both browser and backend. Deterministic.
`LINKED  `  — same git SHA in browser bundle and CI/deploy event. Structural.
`~CORR   `  — within 2 seconds of a backend error. Probabilistic.
`OBS     `  — event captured, no cross-signal link found.
```

This matters. An AI that sees `EXACT` rows has proof. An AI that only sees `~CORR` rows is still guessing, just with more data.

Here's what a real timeline looks like after running the demo:

```
22:14:31  🟡  `OBS     `  **[BROWSER]**  [auth] JWT expiry imminent — 12s remaining
22:14:32  🔴  `EXACT   `  **[BROWSER]**  GET /api/user → 401 (142ms)  ↔ backend
22:14:32  🔴  `EXACT   `  **[BACKEND ]**  [api] TokenExpiredError: jwt expired  ↔ GET /api/user
22:14:32  🔴  `OBS     `  **[BROWSER]**  console.error: TokenError: JWT expired at audience check
22:14:32  🔴  `LINKED  `  **[CI      ]**  CI failure: auth-service tests — [test/auth/token.test.ts]  [a3f7b2c]
```

The `EXACT` rows are the causal chain. The AI doesn't need to guess that the 401 and the backend log are the same request — they share a traceId. The `LINKED` row tells the AI that the CI run for the commit currently running in the browser had a failing test in `auth/token.test.ts`. That's regression attribution without a human doing the correlation.

---

## Installation (no Chrome extension)

```bash
# In your frontend
npm install @mergen/browser

# One line in your app entry point
import { init } from '@mergen/browser';
init(); // endpoint: http://localhost:3000 by default
```

That's the entire install. The SDK intercepts console and fetch, sends OTLP JSON to Mergen's receiver at `POST /v1/logs` and `POST /v1/traces`. Standard protocol. Works in any environment — localhost, internal staging, or production (point `endpoint` at a self-hosted instance).

For the backend, if you're on Node.js:

```bash
npm install mergen-node
```

```typescript
// Express
import { mergen } from 'mergen-node/middleware/express';
app.use(mergen()); // extracts traceparent, emits backend_span events
```

If you're on any other stack, point your existing OTel exporter at `http://localhost:4318` (the OTLP HTTP receiver Mergen runs). Zero Mergen-specific code needed.

---

## How the AI uses this data

The MCP tool `analyze_runtime` builds a **causal chain**, not a list of events. The algorithm:

1. Collect all events in the time window.
2. Build a traceId lookup table from backend spans.
3. For each browser network event, check if its traceId appears in the backend table — if yes, mark `EXACT`, link the events bidirectionally.
4. For remaining events, check buildSha against CI/deploy SHAs — if matches, mark `LINKED`.
5. Remaining events within 2s of a backend error: `~CORR`.
6. Emit a `Hypothesis` object: `{ summary, confidence, confidenceScore, causalPath, fixHint }`.

The causal path is a directed graph of events ordered by their join relationship, not by timestamp. An `EXACT`-joined pair is a single node in the graph regardless of whether the backend processed the request in 10ms or 2000ms.

The `Hypothesis` is then validated by a calibration loop. Every hypothesis has a tag (`auth_token_expired`, `network_cors`, `undefined_property_access`, etc.). When an engineer marks a hypothesis correct or wrong (`POST /calibration/verdict`), the system updates an accuracy score per tag. Tags with < 20% empirical accuracy are suppressed. This means the system gets worse at wrong guesses and better at right ones over time — it doesn't just repeat the same patterns.

---

## The demo

```bash
npx mergen-server demo
```

This starts the server and opens `http://localhost:3000/demo` in your browser. The demo page has `@mergen/browser` already active. Click "Run demo" to fire a JWT expiry scenario: a `console.warn` about token expiry, followed by a `fetch → 401` with a shared traceId, followed by a retry that also fails.

Then in GitHub Copilot, Claude Code, Cursor, or any MCP-compatible AI assistant:

> "What just happened?"

The AI calls `get_unified_timeline` and returns:

```
## Root Cause — 87% confidence
**JWT token expired before API request — refresh logic not firing**
Fix: check token expiry before initiating fetch in auth.ts:fetchWithAuth()

---

## Unified Timeline (last 5m · 5 events)
*Causal joins: 2 exact trace joins · 1 SHA-linked*

`22:14:31`  🟡  `OBS     `  **[BROWSER]**  [auth] JWT expiry imminent — 12s remaining
`22:14:32`  🔴  `EXACT   `  **[BROWSER]**  GET /api/user → 401 (142ms)  ↔ backend
`22:14:32`  🔴  `EXACT   `  **[BACKEND]**  [api] TokenExpiredError: jwt expired
`22:14:32`  🔴  `OBS     `  **[BROWSER]**  console.error: TokenError: JWT expired at audience check
```

The AI knows this with 87% confidence because: the traceId join is deterministic, the error pattern `auth_token_expired` has a 91% historical accuracy rate, and the fix hint is derived from the stack frame in the backend span pointing to `fetchWithAuth`.

---

## Where the architecture points: from one dev to a team

The demo proves single-session causality. One developer, one machine, one JWT error. That's the floor.

The ceiling is more interesting, and it's worth describing concretely because the data model already supports it — the query just isn't written yet.

Every event in Mergen carries two fields that are invisible in the single-dev case but become load-bearing at team scale:

```typescript
// ConsoleEvent and NetworkEvent — both have these
userId:   string | undefined  // which developer's browser captured this
buildSha: string | undefined  // which commit was running when it happened
```

`userId` is set from the engineer's git config or a manual label in the extension popup. `buildSha` is embedded in the frontend bundle at build time and tagged on every event automatically.

This means if you point `@mergen/browser` at a shared server instead of localhost:

```bash
# Shared instance — accessible to the team
MERGEN_BIND=0.0.0.0 npx mergen-server start

# Each developer's frontend points at it
init({ endpoint: 'https://mergen.internal.yourco.com' });
```

...the server sees events from every developer's browser, each tagged with `userId` and `buildSha`. The error fingerprinting layer already normalizes messages to stable patterns (stripping timestamps, line numbers, and variable data). So the query "how many developers hit this error pattern on this commit" is a GROUP BY over data that's already being collected.

What that output would look like with a team MCP tool:

```
## Pattern: auth_token_expired
Fingerprint: `jwt expired at audience check`
Build SHA: a3f7b2c (deployed 4h ago to staging)

Seen by 3 developers in the last 2 hours:
  @mia    — 7 occurrences, first at 10:14, last at 12:31
  @carlos — 2 occurrences, first at 11:02
  @priya  — 1 occurrence, first at 12:45

Exact trace joins available for 4 of 10 occurrences.
Closest CI event: auth-service build a3f7b2c — 1 failing test (test/auth/token.test.ts:88)
CODEOWNERS: @auth-team
```

Nothing in this output requires new data. `userId` is already on every event. The error fingerprint already deduplicates message patterns. The CI join via `buildSha` already works for single-dev mode. `MERGEN_BIND=0.0.0.0` already puts the server in team mode. What's missing is the aggregation query and a MCP tool that surfaces it.

The reason this matters for engineering teams specifically: the hardest debugging problems aren't "I hit a 401." They're "I think this might be broken but I'm not sure if it's just me." A shared Mergen instance answers that question in one query without asking anyone to file a ticket or post in Slack. The AI sees the pattern frequency, the affected SHAs, the CODEOWNERS, and the CI signal — and gives a diagnosis that's grounded in what actually happened across the team, not just on your machine.

That's not built yet. But the schema contracts and the join model that make it possible are already committed.

---

## What this is not

**Not a replacement for your observability stack.** Mergen runs alongside Sentry, Datadog, Grafana. It's the local, developer-speed layer — the feedback loop you complete in seconds during active development, not the aggregate dashboard you check after an incident.

**Not AI guessing from code.** The causal chain is built from execution data. The AI's output is grounded in events that actually happened, in sequence, with explicit confidence labels. If the confidence is low, the AI says so.

**Not a Chrome extension.** The `@mergen/browser` SDK is a 50-line OTel exporter. It requires no browser permissions, works in headless environments, and passes any enterprise security review because it's standard OTLP over HTTP.

---

## Try it

```bash
npx mergen-server demo
```

After the demo, configure your IDE:

```bash
npx mergen-server setup
```

For team and enterprise deployment, see [docs/enterprise.md](enterprise.md) — covers self-hosted Docker setup, Java/C#/Go/Ruby/PHP backend instrumentation, Azure DevOps + Jenkins CI integration, and GitHub Copilot + JetBrains MCP configuration.

Source: [github.com/omertt27/Mergen](https://github.com/omertt27/Mergen)
