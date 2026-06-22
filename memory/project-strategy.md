---
name: project-strategy
description: Mergen strategic positioning — Knowledge Compounding Company for AI-Native Engineering
metadata:
  type: project
---

## Current Positioning (as of 2026-06-22)

**Category:** Operational Intelligence Infrastructure for AI-Native Engineering Teams
**Core essence:** The Knowledge Compounding Company — not an observability tool, not an autopilot executor

**One-sentence (investor):** Mergen is the operational intelligence layer that allows AI agents and engineering teams to learn from how a company's infrastructure actually behaves.

**Landing page headline:** AI agents don't know how your systems actually work.
**Subheadline:** Mergen gives AI agents and engineers the operational context, historical decisions, and infrastructure memory needed to make safer changes.

---

## Beachhead Market

**Mid-market engineering teams (20–150 developers)** experiencing high AI coding velocity without a dedicated platform/SRE team. They already have observability (Datadog, Sentry, PagerDuty) but lack the memory layer that turns incident resolutions into durable policy.

**Why:** They're deploying fast, adopting AI assistants, burning out on-call rotation, but can't afford dedicated SREs. They feel the pain acutely. Decision-makers (VP Eng, lead SRE) respond to "hours saved" and "agents behaving safely" — not "better dashboards."

**Not (yet):** 2–5 person solo dev teams (too small for enterprise ACV) or enterprise 500+ dev orgs (too slow to buy and require compliance maturity Mergen doesn't have yet).

---

## Defensibility

**The moat is not the algorithm — it's the corpus.**

Algorithms converge across vendors. The Override Corpus — the accumulated operational knowledge of the customer's specific infrastructure — is proprietary, non-portable, and compounds with time. Competitor cannot replicate 6 months of "never restart DB pool during Friday settlement window" from a standing start.

**Three compounding assets:**
1. Override Corpus (Infrastructure DNA): every human override encoded as queryable policy
2. Calibration Corpus: Platt-scaled confidence calibrated to this environment's actual incident history
3. Agent Blunder Log: every blocked action recorded — the audit trail that answers "why trust an AI agent with prod?"

---

## Phase Ordering (Strategic)

Phase 4 (Organizational Learning) is now higher priority than Phase 5 (Autonomous Operations).

**Why:** VPs of Engineering buy "safer changes." They fear "autonomous restarts." Phase 4 (Slack→corpus ingestion, git ADR→policy) builds the knowledge foundation that makes Phase 5 credible. Shipping Phase 5 first triggers CISO security scrutiny before trust is established.

```
Phase 1: Sensor Ingest ✅
Phase 2: IDE Integration ✅
Phase 3: CI/CD Safety Gate 🔄
Phase 4: Organizational Learning ← PRIORITY (Slack+git→corpus)
Phase 5: Autonomous Operations ← DEPRIORITIZED for GTM
```

---

## 6-Month Action Plan

1. Days 1–30: Distribution — Chrome Web Store + npm, `npx mergen-setup` auto-discovery
2. Days 30–60: ROI Dashboard — time-saved tracking, VP-facing impact report
3. Days 60–90: Slack-to-Override Memory Loop (Phase 4 MVP)
4. Days 90–150: Agent Safety CI Gate / GitHub Action (Phase 3 MVP)
5. Days 150–180: Enterprise pipeline — 5 mid-market design partners → paid

---

## What to avoid

**Focus drift:** Browser-specific integrations (React Fiber trees, WebSocket inspection) are developer utilities. They drive WAUs but not enterprise ACVs. Prioritize the Override Knowledge Graph server-side.

**Autonomous execution framing:** Leading with "autopilot" triggers CISO objections before trust is established. Lead with knowledge compounding, surface autonomous execution as a later capability.

**Why:** From investment memo (2026-06-22). Use this to filter any new feature request — does it compound the knowledge graph, or does it add a new UI surface?
