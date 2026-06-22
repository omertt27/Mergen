# Mergen Product Roadmap
**Last Updated:** 2026-05-25  
**Strategic Context:** See [IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md)

---

## 🎯 Mission
Make AI assistants **natively runtime-aware** by streaming live browser telemetry into every IDE with zero copy-pasting.

---

## 📊 Current Status (v1.0.0)

### ✅ Shipped
- [x] MCP server with stdio transport
- [x] Chrome extension (console, network, DOM capture)
- [x] Source map de-minification
- [x] HMR checkpoints (Vite, webpack, Next.js)
- [x] Multi-IDE support (Claude Code, Cursor, Windsurf, VS Code)
- [x] Causal chain analysis (`analyze_runtime` tool)
- [x] Credit system with usage tracking
- [x] LemonSqueezy billing integration

### 🐛 Known Issues
- [ ] Context bloat: Full DOM snapshots can saturate LLM context window (#1216 pattern)
- [ ] No WebSocket/SSE visibility
- [ ] No framework-native state inspection (React/Vue component trees)
- [ ] No filtering by severity/pattern in console logs
- [ ] Token budget not enforced per-tool

---

## 🚀 Sprint 1: Context Compression (Week of May 26)
**Goal:** Solve token bloat. Never exceed 2000 tokens per tool call.

### Deliverables
- [ ] **Add severity filtering to `get_recent_logs`**
  - New param: `min_severity: 'log' | 'warn' | 'error'` (default: `warn`)
  - Filters out low-priority noise
  - File: [server/src/intelligence/tools.ts](./server/src/intelligence/tools.ts)

- [ ] **Add exclude patterns**
  - New param: `exclude_patterns: string[]` (e.g., `["HMR", "webpack", "vite"]`)
  - Regex-based filtering
  - Common patterns auto-suggested in docs

- [ ] **Smart DOM context compression**
  - Only send changed localStorage keys (diff vs. previous snapshot)
  - Limit sessionStorage to 10 most-recently-modified keys
  - Add `focused_element_only: boolean` mode (default: false)
  - File: [server/src/sensor/buffer.ts](./server/src/sensor/buffer.ts)

- [ ] **Token budget soft-limits**
  - Add `max_tokens?: number` param to all tools
  - Truncate responses with `[...truncated, +X more items]` footer
  - Log truncation events for observability

### Success Metrics
- Avg. `get_recent_logs` response: < 1500 tokens (down from 3000+)
- Zero user reports of context saturation
- Tool response time: < 200ms (no perf regression)

### Testing
- Unit tests: Filter logic with known console data
- Integration test: 500-event buffer → confirm compressed output < 2000 tokens
- Manual: Run in Cursor with long session, verify LLM doesn't hit context limit

---

## 🚀 Sprint 2: WebSocket Inspection (Week of June 2)
**Goal:** Capture real-time communication (WebSocket, SSE). First MCP to ship this.

### Deliverables
- [ ] **Intercept WebSocket constructor**
  - Patch `new WebSocket(url)` in [extension/src/content.js](./extension/src/content.js)
  - Capture: open/close/error events, last 50 frames per connection
  - Rate-limit: Max 10 frames/sec (prevent buffer saturation)

- [ ] **New MCP tool: `get_websocket_activity`**
  - Params: `limit?: number`, `connection_url?: string`, `since?: number`
  - Returns: connection status, frame history (sent + received), duration
  - File: [server/src/intelligence/tools.ts](./server/src/intelligence/tools.ts)

- [ ] **Server-Sent Events (SSE) support**
  - Detect `EventSource` usage
  - Capture event stream (last 50 messages)
  - Include in same tool output

- [ ] **Buffer storage for WS frames**
  - Add `websocket` event type to ring buffer
  - File: [server/src/sensor/buffer.ts](./server/src/sensor/buffer.ts)

### Success Metrics
- 20% of users with WebSocket usage call `get_websocket_activity` within first week
- Zero perf impact on apps with high-frequency WS traffic (tested with 100 msg/sec)
- AI can debug "WebSocket connection drops randomly" without user intervention

### Testing
- Unit test: Mock WebSocket, verify frame capture
- Integration test: Run against Socket.io demo app
- Load test: 1000 frames/min → confirm rate-limiting works

---

## 🚀 Sprint 3: Debug Hypothesis Workflow (Week of June 9)
**Goal:** Enable autonomous multi-step debugging. Implement "Debug Mode" pattern from report.

### Deliverables
- [ ] **New tool: `start_debug_session`**
  - Params: `hypothesis: string`, `target_component?: string`
  - Returns: session ID + baseline state capture
  - Prompts user: "Reproduce the issue now, then call `end_debug_session(id)`"

- [ ] **New tool: `end_debug_session`**
  - Params: `session_id: string`
  - Returns: diff between baseline and post-reproduction state
  - Auto-calls `analyze_runtime` with filtered events

- [ ] **Tool: `suggest_logging_locations`**
  - Params: `hypothesis: string`, `file_path?: string`
  - Analyzes source code (via Read tool)
  - Returns: "Add console.log at line X to track Y"

- [ ] **Integration with `analyze_runtime`**
  - If root cause unclear, auto-suggest starting debug session
  - Add `debug_hypothesis` field to response

### Success Metrics
- 30% of `analyze_runtime` calls preceded by `start_debug_session`
- User feedback: "Mergen walked me through debugging like a senior engineer"

### Testing
- E2E test: Simulate bug reproduction workflow
- User study: 5 beta testers attempt debugging with vs. without this tool

---

## 🚀 Sprint 4–5: React DevTools Integration (Weeks of June 16 & 23)
**Goal:** Expose component state to AI. Largest ecosystem whitespace.

### Phase 1: React Support
- [ ] **Detect React DevTools hook**
  - Check for `__REACT_DEVTOOLS_GLOBAL_HOOK__`
  - Fallback: Manual Fiber tree traversal
  - File: [extension/src/content.js](./extension/src/content.js)

- [ ] **Serialize component tree**
  - Capture on `console.error` or manual trigger
  - Per component: name, props, state, hooks, render count
  - Max depth: 10 levels (configurable)

- [ ] **New tool: `get_component_tree`**
  - Params: `component_name?: string`, `max_depth?: number`, `include_props?: boolean`
  - Returns: nested component hierarchy with state

- [ ] **Auto-capture on error**
  - When `console.error` fires, snapshot React tree
  - Include in `get_dom_context` output

### Phase 2: Vue Support
- [ ] **Detect Vue DevTools hook**
  - Check for `__VUE_DEVTOOLS_GLOBAL_HOOK__`
  - Support Vue 2 (`__vue__`) and Vue 3 (`__vueParentComponent`)

- [ ] **Serialize Vue component tree**
  - Capture: name, props, data, computed, watchers

### Success Metrics
- 40% of React/Vue users call `get_component_tree` within first week
- AI can answer: "Why is this component re-rendering?" without user manually inspecting DevTools
- Beta feedback: "This is a game-changer for debugging state issues"

### Testing
- Test apps: Create React App, Next.js, Vue 3 Vite starter
- Edge cases: Error boundaries, Suspense, portals
- Perf test: 500-component tree serialization < 100ms

---

## 🚀 Sprint 6: Marketing & Positioning Refresh (Week of June 30)
**Goal:** Clearly communicate Mergen's advantages vs. chrome-devtools-mcp.

### Deliverables
- [ ] **Comparison doc**
  - New file: `docs/why-mergen.md`
  - Table: Mergen vs. chrome-devtools-mcp vs. playwright-mcp
  - Highlight: Real browser, auth support, HMR checkpoints

- [ ] **Update README.md**
  - Add "Why Mergen?" section at top
  - Include demo GIF (auth-gated debugging)

- [ ] **Demo video (30 sec)**
  - Scenario: Debug a bug in a production app behind OAuth
  - Show: AI finds root cause without opening DevTools
  - Publish: YouTube + embed in README

- [ ] **Update CLAUDE.md**
  - Add competitive positioning section
  - Include when-to-use guide

### Success Metrics
- 50% of new users mention "real browser debugging" in onboarding survey
- 2x increase in GitHub stars week-over-week
- Featured in at least one AI engineering newsletter

---

## 🚀 Solo Developer Safety Layer (Planned)

**Context:** Solo devs face three structural absences that teams don't: no code reviewer, no one watching while they're away, no shared institutional memory. These features compensate for each — not as convenience, but as structural substitutes.

### Feature A: Pre-commit Incident Cross-Reference
**The gap:** A team has code review. A solo dev has nothing between "I wrote this" and "it's in production."
- At commit time, cross-reference staged file paths against incident ring buffer
- Output: `auth_middleware.ts was modified in Incident #388 (OOM Kill) — constraint: do not increase stack depth > 4`
- Hooks into `guard` pre-commit flow; requires `file`/`service` tags on buffer events
- This is not a lint check — it's the teammate instinct: "didn't this break before?"

### Feature B: Passive Status Surface (doctor enhancement)
**The gap:** No one watching while you sleep.
- When `/health` or `/doctor` is queried, surface first-error-timestamp: "this started failing 6h ago"
- Not a push notification — context waiting when you return, not an interrupt while you're working
- Requires: `firstSeenAt` timestamp on error records in ring buffer (one-field addition)

### Feature C: Rationale Field on Override Records
**The gap:** You're the only source of institutional memory. If you forget why a workaround exists, no one else knows.
- Add optional `reason` field to override corpus records
- Surface at query time: "3 weeks ago you overrode restart-during-window — reason: Friday settlement window"
- The override corpus already stores *policy* (don't do X). This stores *rationale* (here's why past-you decided that)
- Schema addition only; exposed in `/override-corpus` response and MCP tool output

---

## 📅 Future Sprints (July–December 2026)

### Q3 2026: Enterprise Hardening
- OpenTelemetry export (week of July 7)
- MCP permission system (week of July 14)
- Audit logging (week of July 21)
- Sentry integration (week of July 28)
- Playwright trace analyzer (week of August 4)

### Q4 2026: Scale & Monetization
- Team buffer sharing (September)
- Managed Cloud SaaS (October)
- VS Code native extension (November)
- Public beta launch (December)

---

## 🎁 Backlog (Nice-to-Haves)

### Developer Experience
- [ ] TypeScript types for all MCP tools (auto-generated from Zod schemas)
- [ ] CLI tool: `mergen diagnose` (run health check, test extension connectivity)
- [ ] Better error messages when extension disconnected
- [ ] Dark mode for extension popup

### Advanced Features
- [ ] GraphQL query/mutation inspection (similar to network tool)
- [ ] Performance profiling: capture flame graphs on demand
- [ ] A/B test detection: auto-tag events with feature flags
- [ ] Local replay: re-run buffer events in a sandbox

### Integrations
- [ ] Datadog MCP integration
- [ ] LogRocket correlation
- [ ] Supabase real-time database logs
- [ ] Vercel deployment correlation (match errors to deploy ID)

---

## 🚨 Risk Mitigation

### Competitive Threats
- **chrome-devtools-mcp adds auth support** → Mitigation: Ship WebSocket + React DevTools before they do (6-month lead)
- **Cursor builds native runtime tools** → Mitigation: MCP-native approach works in all IDEs (not locked to Cursor)

### Technical Risks
- **React Fiber API instability** → Mitigation: Abstract behind adapter layer, support multiple React versions
- **Context bloat regression** → Mitigation: Add CI test that fails if any tool response > 2500 tokens
- **Browser API changes break extension** → Mitigation: Automated smoke tests in CI (Playwright runs extension in headless Chrome)

### Business Risks
- **Low adoption** → Mitigation: VS Code native extension (zero-config onboarding)
- **Hard to monetize** → Mitigation: Enterprise features (OTEL, team sharing) behind paid tier

---

## 📈 KPIs (Monthly Tracking)

| Metric | May 2026 | Target (Aug 2026) | Target (Dec 2026) |
|--------|----------|-------------------|-------------------|
| Weekly active users | 50 | 500 | 2,000 |
| GitHub stars | 120 | 500 | 1,500 |
| MRR | $0 | $1K | $10K |
| Avg. session duration | 15 min | 30 min | 45 min |
| Tools calls per session | 3 | 8 | 12 |
| Net Promoter Score (NPS) | N/A | 40 | 60 |

---

## 🤝 How to Contribute

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup and PR guidelines.

**High-impact contributions:**
- React/Vue DevTools integration (advanced, 2-week effort)
- WebSocket inspection (intermediate, 1-week effort)
- Context compression (beginner, 2-day effort)

---

## 📚 Related Docs
- [IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md) — Strategic analysis and competitive positioning
- [CLAUDE.md](./CLAUDE.md) — AI assistant instructions for this codebase
- [QUICKSTART.md](./QUICKSTART.md) — 2-minute setup guide
- [INSTALL.md](./INSTALL.md) — Detailed installation options
