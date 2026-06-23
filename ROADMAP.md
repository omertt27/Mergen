# Mergen Product Roadmap
**Last Updated:** 2026-06-23
**Category:** Agent Execution Governance (AEG)

---

## 🎯 Mission

We are building the execution and security layer that sits between AI agents and critical infrastructure.

AI agents can write code, deploy infrastructure, and access production systems. Prompts are not security boundaries. Mergen is the Execution and Security Gateway that enforces deterministic controls before AI actions reach your runtime, cloud infrastructure, or developer environment.

---

## 📐 The Product Pyramid — Inside-Out Progression

```
Layer 1 — Local Execution Gateway (Today)  ✅
   └── MCP proxy intercepts every tool call before the handler runs.
       Blocks destructive commands in <1ms. Holds schema mutations for HITL approval.
       Agent Blunder Log — hash-chained, tamper-evident, auto-wired.
       Value: Prevent AI agents from making dangerous local actions.

Layer 2 — Team Governance Gateway (Next)  🔄
   └── CI/CD safety gate intercepts AI-generated PRs. Corpus check + blast-radius analysis.
       HITL Slack approval before any autonomous change merges. Shared override corpus.
       Value: Prevent unsafe AI-generated changes from reaching production.

Layer 3 — Agent IAM (Future)  ← BUILDING TOWARD
   └── Federate human SSO identity (Okta/AD) to the agent's active execution thread.
       Broker ephemeral, short-lived cloud credentials scoped to a single task.
       Eliminate long-lived secrets. Automated compliance reporting.
       Value: Govern autonomous agents at enterprise scale.
```

**Strategic alignment:**
- **Today:** The local execution gate is the Trojan Horse — already running on the developer's machine when the enterprise needs governance.
- **Next:** CI gate graduates Mergen from developer utility to team product, justifying $2.5k/mo.
- **Long term:** Agent IAM positions Mergen as the non-discretionary enterprise security requirement.

---

## 📊 Current Status (v1.1.0)

### ✅ Shipped — Layer 1 (Local Execution Gate)
- [x] MCP stdio proxy with `createGuardedServer` — every tool call passes through policy before handler runs
- [x] Enterprise policy engine — JSON rules evaluated in <1ms, word-boundary pattern matching
- [x] HITL gate — Promise suspension + outbound webhook + `/hitl/approve` / `/hitl/deny`
- [x] Agent Blunder Log — hash-chained, tamper-evident, `GET /agent-blunders/verify`
- [x] Override Corpus — human overrides encoded as enforcement policy, evaluated before every gate check
- [x] Shadow mode — 30-day trust track record before autonomous execution
- [x] Pre-commit incident guard — git hook cross-references staged files against incident history
- [x] Slack-to-Override Corpus Loop — scans postmortem threads, auto-encodes constraints
- [x] Git ADR sync — reads architectural decisions, materialises as corpus entries
- [x] PagerDuty autonomous triage loop — incident → analysis → fix → validate → audit trail
- [x] Multi-IDE support — Claude Code, Cursor, Windsurf, VS Code

### 🔄 In Progress — Layer 2 (CI/CD Safety Gate)
- [x] `POST /ci/gate` — corpus check + semantic risk + enterprise policy evaluation
- [x] `action.yml` composite GitHub Action — changed files + PR diff → verdict → PR comment
- [ ] GitHub Status Check integration (show gate verdict directly on PR status line)
- [ ] Blast-radius scoring v2 (service dependency graph awareness)
- [ ] Team-scoped shared override corpus (currently per-instance)

### 🐛 Known Issues
- [ ] MERGEN_PUBLIC_URL not set in team mode: HITL webhook links point to 127.0.0.1 (warning now shown at startup)
- [ ] Policy hot-reload: 5-second polling delay before rule changes take effect
- [ ] CI gate diff analysis: very large PRs (>10KB diff) truncated — semantic analysis may miss tail content

---

## 🚀 Sprint 1: AEG Gate Hardening
**Goal:** Make the local gate production-ready for design partners. Zero false positives. Fast feedback on blocked calls.

### Deliverables
- [ ] **Corpus-driven dynamic blocking**
  - If an action was blocked 3+ times in the override corpus for the same tag, auto-promote from `warn` → `block`
  - File: `server/src/intelligence/override-corpus.ts` + `enterprise-policy-engine.ts`
  - This closes the loop: human overrides automatically tighten the gate without manual policy edits

- [ ] **Policy rule tester**
  - `POST /ci/gate/test` — evaluate a hypothetical `{ files, commands, actor }` against current policy without side effects
  - Lets operators validate rule changes before deploying
  - File: `server/src/routes/ci-gate.ts`

- [ ] **Blunder log structured export**
  - `GET /agent-blunders?format=csv` and `?format=pdf` for compliance reviews
  - Include chain verification result in every export
  - File: `server/src/routes/agent-blunders.ts`

- [ ] **Gate latency metric**
  - Expose `p50/p95/p99` policy evaluation latency in `GET /health`
  - Alert if p99 exceeds 10ms target
  - File: `server/src/sensor/otel-exporter.ts`

### Success Metrics
- Zero false-positive blocks reported by design partners in first 30 days
- Policy evaluation p99 < 5ms (currently ~1ms; goal is headroom for corpus growth)
- Blunder log export accepted by at least one design partner's compliance team

---

## 🚀 Sprint 2: CI Gate v2
**Goal:** Make the GitHub Action the primary team upgrade path. Verdict must appear on the PR within 10 seconds of push.

### Deliverables
- [ ] **GitHub Status Check integration**
  - Post verdict as a GitHub Commit Status (`pending` → `success`/`failure`) in addition to PR comment
  - Required for branch protection rules ("require Mergen AEG gate to pass before merge")
  - File: new `server/src/routes/github-status.ts`

- [ ] **Blast-radius v2 — service graph awareness**
  - Use the service dependency graph (`serviceGraph.toJSON()`) to calculate how many downstream services a change affects
  - Upgrade verdict from `warn` → `block` if changed service has >3 downstream dependents and actor is AI
  - File: `server/src/intelligence/blast-radius.ts`

- [ ] **Diff pattern matching**
  - Extend `POST /ci/gate` to detect specific patterns in diff content: secret exposure (regex), known-bad code patterns, direct DB calls without transactions
  - File: `server/src/intelligence/action-risk.ts`

- [ ] **CI gate history**
  - `GET /ci/gate/history?pr=<number>` — all past evaluations for a PR
  - Lets the PR author see what changed between gate runs
  - File: new `server/src/routes/ci-gate-history.ts`

### Success Metrics
- Gate verdict appears on PR within 10 seconds of push
- At least 1 design partner uses branch protection with "require Mergen gate to pass"
- Zero false-block escalations in first 30 days of team use

---

## 🚀 Sprint 3: Agent IAM Foundation
**Goal:** Lay the groundwork for ephemeral credential brokering. No production release; this is scaffolding + design.

### Deliverables
- [ ] **MERGEN_PUBLIC_URL team deployment guide**
  - Document the full team deployment flow (MERGEN_BIND, MERGEN_PUBLIC_URL, MERGEN_ALLOWED_ORIGINS, TLS)
  - `mergen-server setup --team` wizard that walks through all required env vars
  - File: `INSTALL.md` + `server/src/cli.ts`

- [ ] **Non-human identity model**
  - Define the `AgentIdentity` type: `{ agentId, humanOwner, sessionId, scopedTools, expiresAt }`
  - Wire into the tool-guard: every gate evaluation records the identity of the calling agent
  - File: new `server/src/sensor/agent-identity.ts`

- [ ] **Ephemeral token scaffolding**
  - `POST /agent-tokens` — issues a short-lived (15-minute) token scoped to a specific tool set
  - `DELETE /agent-tokens/:id` — revoke before expiry
  - Tokens are stored in SQLite with `expiresAt`, validated on every guarded tool call
  - File: new `server/src/routes/agent-tokens.ts`

- [ ] **SSO federation hook (stub)**
  - `MERGEN_SSO_ISSUER` env var + OIDC discovery endpoint lookup
  - Validates `Authorization: Bearer <oidc-token>` and maps to `humanOwner` in AgentIdentity
  - File: `server/src/sensor/sso.ts` (extend existing)

### Success Metrics
- `AgentIdentity` recorded in every blunder log entry (enables "which agent triggered this block?")
- Ephemeral tokens working end-to-end in local mode
- Design: document reviewed by at least one enterprise design partner CISO

---

## 🚀 Sprint 4: Compliance & Audit
**Goal:** Make the Agent Blunder Log and override corpus CISO-presentable. Close the SOC 2 gap.

### Deliverables
- [ ] **Structured audit report**
  - `GET /audit/report?from=<epoch>&to=<epoch>&format=pdf|html|json`
  - Sections: blocked actions by type, HITL approvals/denials, corpus growth, agent identities, chain verification result
  - File: new `server/src/routes/audit-report.ts`

- [ ] **RBAC actor scoping in policy rules**
  - Extend `EnterprisePolicyRule.conditions` with `roles?: string[]` — only applies to actors with that role
  - `POST /rbac/roles` — assign roles to actors (human or agent)
  - File: `server/src/sensor/rbac.ts` + `enterprise-policy-engine.ts`

- [ ] **Retention controls**
  - `MERGEN_AUDIT_RETENTION_DAYS=365` — blunders older than N days are exported to S3/GCS/local archive before deletion
  - `MERGEN_ZERO_RETENTION=true` already exists; add `MERGEN_ARCHIVE_PATH` for regulated environments
  - File: `server/src/sensor/agent-blunder-store.ts`

- [ ] **SOC 2 alignment doc**
  - Map every Mergen control to SOC 2 Trust Service Criteria (Security, Availability, Confidentiality)
  - File: new `docs/soc2-alignment.md`

### Success Metrics
- Audit report accepted without modification by at least one design partner compliance review
- RBAC roles working end-to-end: different policy rules fire for `cursor-agent` vs `github-actions`

---

## 🚀 Sprint 5: Design Partner & Distribution
**Goal:** Sign 3 design partners. Measure shadow mode value before the first paid conversion.

### Deliverables
- [ ] **Outreach execution**
  - Send 20 cold emails using `docs/design-partner/outreach-email.md`
  - Target: VP Engineering at companies with public postmortems in last 6 months, 20–150 person eng teams
  - Goal: 3 design partners in shadow mode within 30 days

- [ ] **`npx mergen-server` first-run experience**
  - On first run with no config: print the AEG pitch + 3 setup steps + link to QUICKSTART.md
  - Detect if Claude Code / Cursor is installed and offer one-command MCP registration
  - File: `server/src/cli.ts`

- [ ] **MCP marketplace submissions**
  - Submit `mcp/cursor-directory.json` as a PR to cursor.directory
  - Submit to glama.ai and pulsemcp.com via their submission flows
  - Update npm package description to AEG category

- [ ] **Shadow report shareable PDF**
  - `GET /shadow-report?format=pdf` — CISO-ready one-pager
  - Include: total evaluated, would-have-blocked, corpus size, calibration accuracy
  - This is the design partner deliverable at day 30

### Success Metrics
- 3 design partners in active shadow mode
- At least 1 MCP marketplace listing live under "security" category
- First design partner produces a shadow report at day 30

---

## 📅 6-Month Action Plan (Agent Execution Governance Focus)

Sequenced around the Inside-Out progression: establish the local enforcement gate, graduate to CI/CD governance, then Agent IAM.

### Days 1–30: Sign 3 design partners (Sprint 5)
- Outreach using `docs/design-partner/outreach-email.md`
- Shadow mode onboarding using `docs/design-partner/shadow-mode-onboarding.md`
- **Why:** The product is ready. The blocker is not engineering — it's distribution.

### Days 30–60: CI gate to production (Sprint 2)
- GitHub Status Check integration — makes the gate enforceable via branch protection
- Blast-radius v2 — makes the gate defensible ("here's the blast radius score and why")
- **Why:** This moves Mergen from "developer utility" to "team requirement."

### Days 60–90: AEG gate hardening + compliance (Sprints 1 & 4)
- Corpus-driven dynamic blocking, audit report, RBAC actor scoping
- **Why:** Design partners are 60 days in — they have real corpus data and real CISO questions.

### Days 90–150: Agent IAM foundation (Sprint 3)
- Ephemeral tokens, SSO federation hook, AgentIdentity model
- **Why:** By now, design partners are asking "how do we know which agent did this?" — IAM is the answer.

### Days 150–180: Enterprise pipeline
- Convert 3 design partners → paid Growth ($299/mo) or Enterprise (custom)
- Target 5 additional mid-market teams via warm intros from design partners
- **Why:** Proof of commercial viability before any fundraising conversation.

---

## 📅 Future Quarters (Q3–Q4 2026)

### Q3 2026: Enterprise Hardening
- Agent IAM production release (Okta/AD federation, ephemeral credentials)
- VPC deployment option
- SOC 2 Type I preparation
- Managed Cloud SaaS (multi-tenant)

### Q4 2026: Scale
- Team buffer sharing with tenant isolation
- Policy authoring web UI (edit `enterprise-policy.json` visually)
- VS Code native extension
- Public beta launch with press

---

## 🚨 Risk Mitigation

### Competitive Threats
- **Anthropic ships tool-level authorization in the MCP spec** → Mitigation: Mergen's override corpus and Agent Blunder Log compound with use — a new MCP feature provides a protocol but not the 6-month enforcement history.
- **Datadog/PagerDuty ships an "AI agent policy" layer** → Mitigation: They are post-incident tools. We are the pre-execution gate. Different category, different buyer motion.
- **Open-source AEG tool emerges** → Mitigation: The algorithm is reproducible. The override corpus and blunder log built from a team's real incidents are not.

### Technical Risks
- **Policy engine performance degrades as corpus grows** → Mitigation: Indexed SQLite lookups + in-memory LRU cache; benchmark at 10k corpus entries.
- **HITL webhook approval window expires on slow Slack responses** → Mitigation: 15-minute window is configurable; add `MERGEN_HITL_TIMEOUT_MS` env var.
- **SQLite file corruption on crash** → Mitigation: Atomic tmp-rename on every write + Redis persistence option for production deployments.

### Business Risks
- **Design partners don't convert to paid** → Mitigation: Shadow report + blunder log give them CISO evidence; price the Growth tier below their cost-per-incident.
- **CISO blocks adoption** → Mitigation: Shadow mode is the answer — no autonomous execution until the CISO has seen 30 days of evidence.

---

## 📈 KPIs (Monthly Tracking)

| Metric | Jun 2026 | Target (Sep 2026) | Target (Dec 2026) |
|--------|----------|-------------------|-------------------|
| Design partners in shadow mode | 0 | 3 | 8 |
| Weekly active developers (gate calls) | — | 50 | 300 |
| GitHub stars | — | 200 | 800 |
| MRR | $0 | $900 | $8K |
| Agent Blunder Log entries (all partners) | 0 | 500 | 5,000 |
| Override corpus entries (all partners) | 0 | 200 | 2,000 |
| NPS (design partners) | — | 50 | 60 |

---

## 🤝 How to Contribute

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup and PR guidelines.

**High-impact contributions:**
- Corpus-driven dynamic blocking (Sprint 1 — medium effort, 3-5 days)
- GitHub Status Check integration (Sprint 2 — medium effort, 2-3 days)
- Ephemeral token scaffolding (Sprint 3 — advanced, 1 week)
- Audit report generation (Sprint 4 — beginner-friendly, 2 days)

---

## 📚 Related Docs
- [CLAUDE.md](./CLAUDE.md) — AI assistant instructions + AEG positioning framework
- [QUICKSTART.md](./QUICKSTART.md) — Install + verify the gate in 5 minutes
- [docs/design-partner/outreach-email.md](./docs/design-partner/outreach-email.md) — Design partner outreach templates
- [docs/design-partner/shadow-mode-onboarding.md](./docs/design-partner/shadow-mode-onboarding.md) — 30-day shadow mode guide
- [.github/SECURITY.md](./.github/SECURITY.md) — Vulnerability disclosure policy
