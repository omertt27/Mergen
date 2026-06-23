---
name: project-strategy
description: Mergen strategic positioning — Agent Execution Governance (AEG) platform; Inside-Out progression from local gate to Agent IAM
metadata:
  type: project
---

## Current Positioning (as of 2026-06-23)

**Category:** Execution and Security Gateway for AI Agents
**Core essence:** The Execution and Security Layer for AI Engineering — enforcing deterministic controls before actions reach systems.

**Core Positioning:**
* Prompts are not security boundaries. AI agents write code, deploy infrastructure, and access production systems.
* Mergen is the Execution and Security Gateway that enforces deterministic controls before AI actions reach your runtime, cloud infrastructure, or developer environment.

**One-sentence (investor):** We are building the execution and security layer that sits between AI agents and critical infrastructure.

**Landing page headline:** Secure Every AI Agent Action Before It Executes
**Subheadline:** Mergen sits inline between AI agents and your systems, blocking unsafe actions, enforcing approval workflows, and creating auditable execution trails across development and production environments.

---

## The Product Pyramid & Beachhead Market

Instead of treating solo devs and mid-market teams as disjoint products, we unify them under the execution security hierarchy:

* **Layer 1 — Local Execution Gateway (Today)**:
  * Intercepts CLI and MCP tool calls locally.
  * Blocks destructive commands and enforces prompt-injection / secret exposure protection.
  * *Value (Solo Dev / Sensor Network)*: Prevent AI agents from making dangerous local actions or executing unauthorized mutations.
* **Layer 2 — Team Governance Gateway (Next)**:
  * CI/CD control gate, GitHub checks integration, and deployment approvals.
  * Slack-based HITL approval workflows and structured audit logs.
  * *Value (Teams / Monetization)*: Prevent unsafe AI-generated changes from reaching production.
* **Layer 3 — Agent IAM (Future)**:
  * Ephemeral credentials, least-privilege execution sandboxes, and identity federation.
  * Human-to-agent authorization boundaries and automated compliance reporting.
  * *Value (Enterprise / Moat)*: Govern autonomous agents at scale.

---

## Defensibility

**The moat is the execution gate corpus and audit trail.**

The Agent Blunder Log is our primary defensibility asset: every blocked action is recorded to answer the compliance and platform question, "how do you trust an AI agent with production/terminal access?"

---

## Phase Ordering (Strategic)

```
Phase 1: Local Execution Gate (Interception, Destructive Command Blocks) ✅
Phase 2: IDE Integration (Tool Guard, Agent Blunder Logging) ✅
Phase 3: CI/CD Safety Gate (Inline checks, composite GitHub Action) 🔄
Phase 4: Continuous Flywheel (Slack approvals & ADR policy compiler) ✅
Phase 5: Agent IAM / Ephemeral Credentials (Enterprise Scale) ← FUTURE
```

---

## 6-Month Action Plan (Solo & Team Alignment)

1. **Days 1–30: Distribution**: Chrome Web Store + npm, `npx mergen-setup` auto-discovery. (Shipped/Done)
2. **Days 30–60: Instant Personal Leverage (3 Killer Solo Use Cases)**:
   * **"Why did this break again?"**: Retrieve previous diagnosis/resolutions for matching error signatures in IDE.
   * **"My AI agent is confidently wrong"**: Warn/block changes that touch files/code implicated in previous failures.
   * **"I don't understand my own system anymore"**: Auto-generate living behavioral maps from local telemetry.
3. **Days 60–90: Slack-to-Override Corpus Loop (Phase 4 MVP)**
4. **Days 90–150: Agent Safety CI Gate / GitHub Action (Phase 3 MVP)**
5. **Days 150–180: Enterprise pipeline** — 5 mid-market design partners → paid

---

## What to avoid

* **Focus drift on Administrative UI**: Avoid spending cycles on dashboards, enterprise governance panels, complex policy definition UIs, and compliance features for the developer-facing distribution tier. Keep the focus entirely on instant feedback loop value inside the IDE.
* **Headless/Stateless Autopilot**: Leading with "autopilot" triggers CISO objections before trust is established. Lead with enforcement-first execution gates and local safety checks.
* **Soft Advisory Framing**: The product must generate visible enforcement moments (such as a corpus block surfacing when the AI IDE proposes a dangerous fix) so developers feel the gate working immediately and share it. Never frame Mergen as advisory — it is the stop sign, not the recommendation engine.
