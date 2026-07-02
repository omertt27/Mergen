# Mergen: Improvement Plan (updated 2026-07-02)

**Supersedes the 2026-06-22 draft.** That version planned forward from the pitch. This version plans forward from a code-grounded architecture review (direct read of `enterprise-policy-engine.ts`, `tool-guard.ts`, `agent-profiles.ts`, `agent-blunder-store.ts`, `blast-radius.ts`, `incident-replay.ts`, `policy-sync.ts`, `audit-export.ts`, `session-threat-tracker.ts`, `calibration-classifier.ts`, plus a full-codebase sweep) that found several claims in `CLAUDE.md`/`ROADMAP.md` don't yet match what's implemented. This plan closes those gaps in priority order, then resumes the roadmap.

**Ground truth at time of writing:** solo developer, 208/210 commits, ~80K LOC in `server/src`, 331 files. That fact is load-bearing for every priority call below — everything not in P0/P1 should stay unbuilt until P0/P1 is closed, because the biggest risk to this plan is scope, not missing features.

---

## P0 — Trust-breaking gaps

Close these before any design-partner technical review or security-diligence call. Each one is a claim in current docs/pitch that a competent reviewer disproves by reading the code for 10 minutes, and each failure mode lands on the exact "prompts aren't boundaries, trust the gate" premise the product is sold on.

### P0.1 — CLI/bash coverage doesn't match the "CLI proxy" claim
- **Finding:** `tool-guard.ts` patches `Server.setRequestHandler` for `CallToolRequestSchema` — this covers every MCP `tools/call`, including a bash command invoked *as* an MCP tool. It does not cover a bare terminal command that never goes through MCP. The README's "lightweight MCP **and CLI** proxy" and "wraps local terminal processes" claims are true for the MCP path only.
- **Fix:** Either (a) build an actual CLI wrapper — a shim binary/shell function that routes commands through the same `applyGateInner` decision path before exec — or (b) scope every "CLI proxy" / "terminal" claim in `CLAUDE.md`, `README.md`, and the pitch down to "MCP tool-call proxy" until (a) ships.
- **Files:** new `server/src/cli/gate-wrapper.ts` (or equivalent), reusing `tool-guard.ts`'s `applyGate`/`applyGateInner`; doc edits in `CLAUDE.md`, `README.md`.
- **Effort:** doc fix same day; real CLI wrapper ~1 week (needs to handle shell quoting/injection carefully — this is itself a new attack surface, test accordingly).

### P0.2 — Agent identity is self-asserted, not attested
- **Finding:** `agent-profiles.ts` identity is `MERGEN_AGENT_ID`, an env var set by whoever launches the process — the same actor the product's threat model distrusts. `conditions.agentIds` in the policy engine inherits this weakness. "Cross-agent governance" currently means "governance by a label the governed party can set."
- **Fix:** Issue a signed, server-minted token at MCP handshake, scoped to a profile server-side; the client presents the token, not a self-declared string. Minimum viable: HMAC token issued by `mergen-server setup`/`login` per IDE install, validated on every guarded call the same way policy HMAC is already validated.
- **Files:** `agent-profiles.ts`, `tool-guard.ts` (validate token instead of trusting env var), extend `enterprise-policy-engine.ts` conditions.
- **Effort:** ~3-5 days — the HMAC-verification pattern already exists in `policy-sync.ts` and can be reused.

### P0.3 — Audit chain can't detect deletion, only modification
- **Finding:** (already identified in a prior session, still open) `agent-blunder-store.ts`'s `verifyChain()` has no external anchor or monotonic counter — an attacker who deletes trailing entries produces a chain that still verifies. "Tamper-evident" currently means "detects edits," not "detects removal." This is the exact gap a SOC2/ISO27001 auditor tests for first.
- **Fix:** Add a periodic signed checkpoint (chain length + latest hash) written to a location the governed process can't easily rewrite — even a local append-only file with a separate write path, or, better, an optional push to a customer-controlled external store (S3 object with versioning, a second machine). Minimum viable: monotonic sequence number in every entry + a checkpoint file re-verified against entry count on `verify`.
- **Files:** `agent-blunder-store.ts`, `routes/audit-export.ts` (surface `chainValid` + `deletionDetected` distinctly).
- **Effort:** ~2-3 days for the counter+checkpoint version.

### P0.4 — Gate A never reads the calibration/corpus signal automatically
- **Finding:** (re-confirmed this session) `calibration-classifier.ts` (real online logistic regression) and `override-corpus.ts`'s `hasRecentOverride()` are called live in `agent-pipeline.ts` and `tools-autonomy.ts` — both **Gate B** (autopilot's decision to run its own diagnosed fix). The tool-call firewall, **Gate A** (`tool-guard.ts` + `enterprise-policy-engine.ts`), only receives this signal after a human explicitly hits `POST /overrides/:id/review`, via `corpus-to-policy.ts`. "Mergen gets smarter from your incidents" is true for Gate B unconditionally and true for Gate A only after a human review step.
- **Fix:** Either wire a bounded, automatic promotion path (e.g., an override pattern that clears `MIN_OCCURRENCES` *and* has a consistent human verdict gets auto-staged as a `HOLD`-only proposal at `GET /policy-suggestions`, which already exists per `MERGEN_AUTO_CORPUS_PROPOSE` — extend that mechanism to also cover Gate A promotion, not just corpus synthesis) — or leave the human-gate as-is and fix the marketing language everywhere it implies full automation.
- **Files:** `corpus-to-policy.ts`, `policy-proposals.ts`, `CLAUDE.md` (three-layer architecture section).
- **Effort:** doc fix same day; auto-promotion path ~1 week, and should stay `HOLD`-only per existing `MERGEN_AUTO_CORPUS_PROPOSE` safety precedent (never auto-`BLOCK`).

### P0.5 — SIEM integration doesn't exist
- **Finding:** No SIEM code anywhere in `server/src`. It's implied as a target integration in `CLAUDE.md`'s comparison table.
- **Fix:** Remove from claims until built, or scope a minimal version (structured audit-export webhook/Splunk HEC or generic syslog forwarder — `audit-export.ts` already produces the NDJSON payload, a SIEM sink is mostly a delivery mechanism on top of it).
- **Files:** `CLAUDE.md`, `README.md`; new `server/src/routes/siem-export.ts` if building.
- **Effort:** doc fix same day; minimal HEC/syslog forwarder ~2-3 days once P0.3's checkpoint format is settled (ship them together).

---

## P1 — Naming/reality gaps

Not trust-breaking on their own, but each is a term used in `CLAUDE.md`/pitch materials that a technical evaluator will map to a stronger existing category (OPA, Vanta, Datadog APM) and find underdelivers. Close before enterprise/compliance-focused conversations, not before design-partner shadow mode.

### P1.1 — "Security Rule DSL" is a JSON+Zod schema, not a language
- **Finding:** `enterprise-policy-engine.ts` has no parser/compiler and no boolean composition (no nested AND/OR/NOT across condition categories) — condition categories are implicitly ANDed.
- **Fix:** Either build real composability (worth doing regardless — customers will eventually need "block X unless (Y or Z)") or stop using the word "DSL" externally; call it "policy rules" / "policy schema."
- **Files:** `enterprise-policy-engine.ts` (rule evaluator), `routes/policies.ts`.
- **Effort:** doc fix same day; real composition engine ~1-2 weeks (this is the highest-effort P1 item — sequence after P0).

### P1.2 — "Compliance Reporting" is an NDJSON export, not a report
- **Finding:** `audit-export.ts` produces a tamper-evident export with a SOC2-labeled header; there's no control-mapping (Security/Availability/Confidentiality trust criteria) or evidence-collection workflow like Vanta/Drata.
- **Fix:** ROADMAP.md Sprint 4 already scopes a `docs/soc2-alignment.md` control-mapping doc and a structured PDF/HTML report — pull that forward and treat it as part of this plan, not a future sprint, since it directly fixes an overclaim. Don't try to compete with Vanta/Drata on breadth — scope to "the controls Mergen itself satisfies," not general SOC2 automation.
- **Files:** new `routes/audit-report.ts`, new `docs/soc2-alignment.md` (both already specified in ROADMAP.md Sprint 4 — no new design needed, just prioritize).
- **Effort:** ~3-4 days.

### P1.3 — Datadog integration is a health-check stub, not the "blame attribution + trace fetch" client the docs describe
- **Finding:** `health-integrations.ts` only checks `DD_API_KEY`/`DD_APP_KEY` presence; no trace-fetch or blame-attribution client was found.
- **Fix:** Either build the real client (fetch trace by service+timeframe, map span owner via git blame — both well-defined, Datadog's API is documented) or scope the env var docs down to "health check only, full integration planned."
- **Files:** `CLAUDE.md` env var table; new `server/src/datadog/trace-client.ts` if building.
- **Effort:** doc fix same day; real client ~1 week.

### P1.4 — Diff Explosion Detector doesn't exist
- **Finding:** `blast-radius.ts` scores *command* impact (kubectl/helm/SQL), not code-diff size/scope. No file/LOC-count anomaly detector exists anywhere.
- **Fix:** Build the minimal version as part of the CI gate (Layer 2) work already scheduled: `git diff --stat` against a per-repo historical baseline (median PR size for that repo/author), threshold-flag outliers, feed into `POST /ci/gate` verdict alongside blast-radius. This is genuinely a one-to-two day feature and closes a gap a CISO will ask about by name.
- **Files:** new `server/src/intelligence/diff-size.ts`, wire into `routes/ci-gate.ts`.
- **Effort:** ~1-2 days.

---

## P2 — Structural / strategic (the actual leverage)

These don't have a "file: fix" shape — they're where the review's conclusions bear on how effort gets allocated over the next two quarters.

### P2.1 — Scope cut: separate the firewall (AEG) from the diagnosis/observability engine
- **Finding:** The repo contains two products under one roof: the execution-governance firewall (Gate A/B, policy, HITL, audit, corpus — the AEG story `positioning_decision` memory already committed to) and a runtime-diagnosis/incident-copilot engine (`causal-graph.ts`, `behavior-baseline.ts`, `cascade-detector.ts`, `degradation-watcher.ts`, `war-room.ts`, `case-study-generator.ts`, `llm-spokesperson.ts`). One developer is maintaining both while also fixing category-defining security bypasses (three rounds already, per prior sessions' findings) in the first.
- **Recommendation:** Freeze new investment in the diagnosis/observability half. Don't delete it — it's shipped, working, and some of it (incident-replay, calibration) genuinely feeds the firewall story — but no new files, no new detectors, no new dashboards there until P0 is fully closed. Every hour this quarter goes to: closing P0, shipping Layer 2 (CI gate), and starting Layer 3 groundwork (P2.3).
- **Owner call, not an engineering task** — flagging because it's the single biggest lever in the whole review and easy to lose under a backlog of individually-reasonable feature requests.

### P2.2 — Validate the override-corpus switching-cost thesis with real customers
- **Finding:** The corpus is the best-reasoned asset in the moat analysis, but it's unproven — `ROADMAP.md` KPI table shows 0 design partners, 0 corpus entries as of the last update.
- **Fix:** This is the existing ROADMAP.md Sprint 5 (design partner outreach) — no new task, just: don't let P0/P1 engineering work delay it. Shadow mode onboarding should start in parallel with P0, not after.

### P2.3 — Start Layer 3 (Agent IAM) groundwork now, in parallel, not after Layers 1-2 feel done
- **Finding:** Layer 3 (ephemeral credential brokering) is the only layer in the full 15-layer review with a plausible structural moat — the others are commoditized or replicable in weeks by a well-resourced competitor. `ROADMAP.md` currently sequences it as Sprint 3 (days 90-150), after CI gate and compliance work.
- **Fix:** Pull the *design* work forward (not the production build) — the `AgentIdentity` type and non-human identity model already scoped in ROADMAP.md Sprint 3 overlaps directly with P0.2's token work above. Do them together: the signed-token fix for agent-profile spoofing (P0.2) is the same primitive Layer 3 needs, just scoped to local policy today and to cloud credential brokering later. Building P0.2 with the Layer 3 data model in mind avoids redoing it.
- **Files:** `server/src/sensor/agent-identity.ts` (already scoped in ROADMAP.md Sprint 3) — pull forward, build alongside P0.2.

---

## Explicitly not doing right now

Named to prevent scope creep back in, consistent with P2.1:

- More third-party integrations (Slack/GitHub/Jira/PagerDuty coverage is already deep and is pure table stakes — commoditized, zero moat, not worth more investment until P0/P1 close)
- A cross-customer telemetry/data moat (structurally contradicts the no-cloud positioning already settled in `moat_strategy` — don't reopen this)
- New diagnosis detectors, new dashboards, `case-study-generator`/`war-room`/`llm-spokesperson` feature work (see P2.1)
- Sandboxed execution / Layer 3 production release (ROADMAP.md Q3 2026 — sequencing unchanged, only the *design* work in P2.3 moves earlier)

---

## How this reconciles with `ROADMAP.md`

`ROADMAP.md`'s 3-layer structure and 6-month sequencing stay correct at the strategic level — this plan doesn't replace it, it inserts a P0/P1 remediation pass before Sprint 2 (CI Gate v2) and pulls part of Sprint 3 (non-human identity model) forward to run alongside P0.2. `ROADMAP.md`'s "Known Issues" and Sprint checklists should be updated to reflect: RBAC roles (`rbac.ts`) already exist and are further along than "🔄 In Progress" suggests; corpus-driven promotion has a first version (`corpus-to-policy.ts`'s review-triggered activation) that P0.4 above extends rather than starts from scratch.
