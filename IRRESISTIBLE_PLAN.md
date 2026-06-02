# Mergen: 8 Steps to Irresistible
**Goal:** Make Mergen the tool every developer installs on day one of a new project — and never removes.  
**Horizon:** 3 months  
**Last Updated:** June 2, 2026

---

## Step 1 — Zero-Friction Onboarding (Week 1)
**"Install in 30 seconds or we've already lost them."**

### Problem
Today's setup requires: install Node.js → run server → install browser extension → edit IDE MCP config. That's 4 separate steps across 3 different surfaces. Every extra step cuts conversion by ~30%.

### Actions
- [ ] Create a single `install.sh` that: starts the server, prints the MCP config snippet, and deep-links to the Chrome extension install page
- [ ] Add a VS Code extension that bundles and auto-starts the Mergen server (zero Node.js config required)
- [ ] Add a health-check wizard: `mergen doctor` that auto-fixes common config issues and prints a green ✅ for each layer
- [ ] Target: **new user → first `analyze_runtime` result in < 60 seconds**

### Success Metric
- Onboarding funnel completion rate ≥ 70% (tracked via `/usage` endpoint)

---

## Step 2 — Context Compression (Week 1–2)
**"Never be the tool that breaks the AI's context window."**

### Problem
Full DOM snapshots and long log histories saturate LLM context in <5 interactions. Users blame Mergen, not the LLM.

### Actions
- [ ] Add `min_severity: 'warn' | 'error'` param to `get_recent_logs` (default: `warn`)
- [ ] Add `exclude_patterns: string[]` param to filter HMR/webpack noise
- [ ] Smart DOM diff: only send changed `localStorage` keys vs. previous snapshot
- [ ] Add `max_tokens?: number` soft-limit to all tools — truncate with `[...+X more]` footer
- [ ] Target: **avg. tool response < 1500 tokens** (down from 3000+)

### Success Metric
- Zero user-reported context saturation issues post-release

---

## Step 3 — WebSocket & SSE Inspection (Week 2–3)
**"Be the first MCP that understands real-time apps."**

### Problem
Chat apps, live dashboards, multiplayer games, and financial tickers all use WebSockets. No existing MCP captures this. Developers debugging real-time features have nowhere to turn.

### Actions
- [ ] Patch `new WebSocket(url)` in `extension/src/content.js` (same pattern as fetch/XHR)
- [ ] Capture: open/close/error events + last 50 frames per connection (both sent & received)
- [ ] Rate-limit: max 10 frames/sec to prevent buffer saturation
- [ ] New MCP tool: `get_websocket_activity(limit?, connection_url?, since?)`
- [ ] Add SSE stream capture (`EventSource`) with same pattern

### Success Metric
- Announced as "first MCP with WebSocket inspection" — measurable by mentions/shares at launch

---

## Step 4 — React & Vue Component Tree Inspection (Week 3–6)
**"See the component that broke, not just the console line."**

### Problem
The #1 gap in the entire AI-debugging ecosystem. Developers spend 60% of debugging time asking "which component is responsible for this?" Mergen already has the network and console layer — adding the component layer makes it complete.

### Actions
- [ ] Detect `__REACT_DEVTOOLS_GLOBAL_HOOK__` — serialize component tree on error or manual trigger
- [ ] Capture per-component: name, props, state, hooks (useState/useEffect values), render count
- [ ] New MCP tool: `get_component_tree(component_name?, max_depth?)`
- [ ] Vue 3 support: detect `__vueParentComponent`, capture name/props/data/computed
- [ ] Integrate into `analyze_runtime` output — automatically include guilty component when relevant

### Success Metric
- 40% of frontend users calling `get_component_tree` within first month of release

---

## Step 5 — Make the Accuracy System Visible (Week 4–5)
**"Turn our biggest differentiator into our biggest marketing asset."**

### Problem
Mergen's calibrated hypothesis system (empirical accuracy tracking per detector) is unique in the entire observability market. But it's invisible. Developers don't know it exists until they've used Mergen for weeks.

### Actions
- [ ] Add a "Mergen Track Record" card to the VS Code sidebar: *"87% accurate in your last 20 sessions"*
- [ ] Show per-hypothesis confidence badge in `analyze_runtime` output: `[✓ 91% accurate, 34 verdicts]`
- [ ] Add `/calibration/stats` endpoint returning human-readable accuracy summary
- [ ] Add a one-click feedback button in the VS Code panel (✓ Yes / ◐ Sort of / ✕ No) — no context switching
- [ ] Publish an aggregate accuracy leaderboard on the website (anonymized, opt-in)

### Success Metric
- Feedback submission rate ≥ 25% of `analyze_runtime` calls (up from near-zero today)

---

## Step 6 — Shareable Bug Reports (Week 5–6)
**"Make Mergen viral inside engineering teams."**

### Problem
When a developer finds a great debug insight in Mergen, they screenshot it and paste it into Slack. The causal chain, timeline, and hypothesis ranking are lost. There's no way to share the full context.

### Actions
- [ ] New CLI command: `mergen export` → generates a self-contained `.mergen-report.json` (causal chain + timeline + component tree + network)
- [ ] New MCP tool: `export_session(label?: string)` — callable from the AI mid-conversation
- [ ] Add a rendered HTML report view: `mergen open-report ./my-report.mergen-report.json`
- [ ] Optional: hosted share link via mergen.dev (opt-in, auto-expires in 7 days)

### Success Metric
- Export feature used in ≥ 15% of sessions within 30 days of release

---

## Step 7 — "Mergen is Watching" Passive Presence (Week 6–7)
**"Tools that feel alive don't get uninstalled."**

### Problem
Passive tools get forgotten. If Mergen is silent, developers assume it's broken or not running. The tool needs to communicate its presence subtly — without being annoying.

### Actions
- [ ] VS Code status bar: live indicator with error count + last event time: `⬡ Mergen · 2 errors · 4s ago`
- [ ] Status bar pulses red on new errors, returns to normal after 10s
- [ ] Sidebar "Activity Feed": last 5 events in plain English — *"Fetch to /api/user failed (401) · 12s ago"*
- [ ] Desktop notification (opt-in) when a HIGH-confidence hypothesis fires for the first time in a session
- [ ] Add `mergen guard` pre-commit hook output to show: *"Mergen: 0 runtime errors recorded in last session ✅"*

### Success Metric
- 7-day retention ≥ 60% (users who run at least one session in week 2 after install)

---

## Step 8 — Managed Cloud Tier (Month 2–3)
**"Remove the last reason not to try it."**

### Problem
`npx mergen-server` requires Node.js 18+. Many developers (especially those on older machines, Windows, or non-JS stacks) hit install issues and give up. A hosted option removes this entirely.

### Actions
- [ ] Hosted Mergen instance at mergen.dev/connect (cloud-hosted MCP server)
- [ ] Browser extension gains an optional cloud relay mode: sends telemetry to user's personal cloud instance (end-to-end encrypted)
- [ ] Pricing: Free tier (1 user, 7-day buffer retention) / Team tier ($49/mo, 5 users, 30-day retention)
- [ ] "Connect in 10 seconds": install extension → sign in → paste MCP URL → done. Zero Node.js.
- [ ] Local-first mode remains the default and always free — cloud is additive

### Success Metric
- $10K MRR within 90 days of cloud launch
- 30% of new signups choose cloud mode over local install

---

## Execution Timeline

| Step | Feature | Week | Priority |
|------|---------|------|----------|
| 1 | Zero-friction onboarding | 1 | 🔴 P0 |
| 2 | Context compression | 1–2 | 🔴 P0 |
| 3 | WebSocket & SSE inspection | 2–3 | 🔴 P0 |
| 4 | React/Vue component tree | 3–6 | 🟠 P1 |
| 5 | Visible accuracy system | 4–5 | 🟠 P1 |
| 6 | Shareable bug reports | 5–6 | 🟡 P2 |
| 7 | Passive presence / status bar | 6–7 | 🟡 P2 |
| 8 | Managed cloud tier | 8–12 | 🟢 P3 |

---

## The North Star

> A developer opens their editor, makes a change, sees a bug in the browser.  
> Their AI already knows about it — before they've typed a single word.  
> They ask "why?" and get a ranked answer with the guilty component, the failed request, and a fix.  
> They click ✓. Mergen gets smarter.  
> **Zero copy-pasting. Zero manual DevTools. Just ask.**

That's irresistible.
