# Mergen: 90-Day Strategic & Technical Improvement Plan
**Plan Date:** 2026-06-20  
**Strategic Direction:** Unified Agentic Safety & Understanding Platform (Integrating Andrew Ng's Feedback)  
**Status:** In Progress (Implementing Stage 1)

---

## Executive Summary

This plan positions Mergen as the **critical safety and understanding layer for AI coding agents**. AI assistants write code at machine speed but are "blind to runtime" operations—leading to technical debt and production incidents (the **"Agent Outage Tax"**). Mergen bridges this gap by feeding real-time browser/infrastructure telemetry back into AI IDEs and enforcing autonomous safety guardrails.

### 💡 Andrew Ng Strategic Integrations
Following strategic feedback, we are adjusting our product vector to address three critical challenges:
1. **The Platt-Scaling Cold Start:** Implementing **Anonymized Federated Telemetry** to bootstrap our calibration engine on Day 0.
2. **Beyond Regex Safety:** Replacing standard regex command blocklists with a **Semantic Safety Gate** that evaluates action risk and blast radius.
3. **Enterprise GTM Defensibility:** Positioning Mergen as an SRE "insurance policy" for VP/CISO buyers by visualising prevented agent incidents via the **Agent Blunder Log**.

---

## Strategic Prioritization Matrix

| Initiative | Impact | Effort | Priority | Strategic Value |
|-----------|--------|--------|----------|----------------|
| **Deterministic Causal Joins** | 🔥 Critical | 2 weeks | **P0** | EXACT evidence joins via browser extension |
| **Federated Calibration Telemetry** | 🔥 Critical | 1 week | **P0** | Solves the Platt scaling cold-start problem |
| **Semantic Safety Gate** | 🟡 High | 2 weeks | **P1** | Replaces regex blocklist with LLM blast-radius evaluations |
| **CISO Agent Blunder Dashboard** | 🟡 High | 1.5 weeks | **P1** | Enterprise sales enablement & ROI justification |
| **AI IDE Partner Program** | 🟡 High | Ongoing | **P1** | Grassroots distribution via Claude Code & Cursor |
| **Silent Failure Detectors (×7)** | 🟢 Medium | 3 weeks | **P2** | Value-add detection of infinite loops/stale closures |
| **Team Share & Sync MVP** | 🟢 Medium | 4 weeks | **P2** | Multi-seat accounts & shared override corpus |

---

## Stage 1: The Causal Context & Calibration Layer (Weeks 1–4)

### Week 1–2: Deterministic Joins & Evidence Taxonomy

#### Task 1.1: Trace Correlation (EXACT Joins)
* **Goal:** Auto-inject `traceparent` headers to link frontend errors to backend server spans.
* **Deliverables:** Extension patch (content script) + SDK updates + telemetry matching in [causal-graph.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/causal-graph.ts).
* **Metrics:** Output contains `EXACT` tag when trace IDs match.

#### Task 1.2: Evidence-Based Prompts
* **Goal:** Instruct LLM spokesperson in [llm-spokesperson.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/llm-spokesperson.ts) to weigh structured evidence tags (`EXACT` vs. `~CORR` vs. `OBS`) over raw confidence scores.

### Week 3–4: Calibration Cold-Start Mitigation

#### Task 1.3: Anonymized Federated Calibration Telemetry
* **Goal:** Pre-train global Platt calibration coefficients and bootstrap the Day 0 experience.
* **Implementation:** 
  - Define schema in [calibration.d.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/calibration.d.ts) for opt-in telemetry payloads (`MERGEN_TELEMETRY=1`).
  - Deploy global aggregator endpoint on `corpus.mergen.dev` to collect tag-verdict outcomes.
  - Implement fallback hierarchy in [platt-scaling.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/platt-scaling.ts): `local-tag-platt` $\rightarrow$ `federated-tag-platt` $\rightarrow$ `global-platt` $\rightarrow$ `raw`.
* **Success Metric:** Day 0 installations output calibrated probabilities rather than uncalibrated raw scores.

---

## Stage 2: Safety Gates & Distribution (Weeks 5–8)

### Week 5–6: Upgrading Safety Execution Boundaries

#### Task 2.1: Semantic Safety & Blast-Radius Engine
* **Goal:** Prevent agents from executing high-risk commands that pass syntax-based regexes.
* **Implementation:** 
  - Enhance [action-risk.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/action-risk.ts) and [blast-radius.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/blast-radius.ts).
  - Feed proposed fix commands into a lightweight, local semantic analysis gate.
  - Grade commands on destructive risk (low/medium/high) and context checks (e.g., "resizing DB connection pool during a known high-load window").
* **Metrics:** 0 bypasses of critical system changes; correct classification of non-trivial destructive commands.

### Week 7–8: Distribution & Silent Detectors

#### Task 2.2: Chrome Web Store & npm Release
* **Goal:** Publish the browser extension to Chrome Web Store and the server to npm.

#### Task 2.3: Silent failure detectors
* **Goal:** Catch issues that do not crash the browser console but degrade UX.
* **Implementation:** Write specific detector plug-ins in [detector-plugins.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/detector-plugins.ts) for React infinite render loops, stale closures, and CORS preflight blocks.

---

## Stage 3: Enterprise Trust & Partnerships (Weeks 9–12)

### Week 9–10: CISO Dashboard & ROI Visualizer

#### Task 3.1: Visualizing the Agent Blunder Log
* **Goal:** Give VP of Eng/CISO a clear dashboard showing "AI errors caught before reaching prod."
* **Implementation:** 
  - Expose API at `/agent-blunders` returning blocked actions.
  - Build UI page visualizing incident prevention rates, time-saved stats, and MTTR changes.
* **Metrics:** Average estimated cost of outages prevented shown on screen.

### Week 11–12: Strategic Partnerships & Team Sync

#### Task 3.2: AI IDE Partnerships
* **Goal:** Direct standard integrations with major AI agent CLI and developer platforms.
* **Implementation:** Standardize Mergen's MCP server configuration schemas, establishing plug-and-play defaults for Claude Code and Cursor.

#### Task 3.3: Team Sync MVP
* **Goal:** Sync the override corpus and blunder logs across team seats.

---

## Success Metrics (90-Day Evaluation)

* **Calibrated Confidence:** 100% of Day 0 setups present calibrated or empirical confidence metrics rather than raw priors.
* **Zero Autopilot Outages:** Zero fatal actions executed by autopilot due to the upgraded semantic safety gate.
* **Developer Engagement:** Monthly active users (MAU) reaching 2,500; 40% organic developer response rate to PR comment reviews.
* **Enterprise ROI:** Verified reduction in MTTR by $\ge 40\%$ when using Mergen’s context briefs for manual triage.

---
