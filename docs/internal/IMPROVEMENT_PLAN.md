# Mergen: 90-Day Improvement Plan
**Plan Date:** 2026-06-02  
**Target:** Become the definitive runtime context layer for AI agents  
**Status:** Strategic Refinement Complete

---

## Executive Summary

This plan transforms Mergen from a **telemetry bridge** to a **causal context layer** for AI agents. 

AI agents can read code, but they are "blind to runtime." They cannot see the causal links between a browser crash and a backend timeout. Mergen bridges this gap by providing **deterministic causal joins** (EXACT evidence) that give agents the ground truth they need to debug accurately.

**The Moat:** Unlike headless browser MCPs, Mergen runs in the developer's **REAL browser** with REAL authentication, cookies, and state. This makes it the only tool capable of debugging production-gated issues.

---

## Prioritization Matrix

| Initiative | Impact | Effort | Priority | Strategic Value |
|-----------|--------|--------|----------|----------------|
| **Deterministic Causal Joins** | 🔥 Critical | 2 weeks | **P0** | **The Moat:** EXACT evidence joins |
| **Evidence-based Taxonomy** | 🔥 Critical | 1 week | **P0** | Credibility vs. raw confidence |
| **Real Browser Advantage Doc** | 🔥 Critical | 1 week | **P0** | Market differentiation |
| **npm + Web Store publish** | 🟡 High | 2 weeks | **P1** | Distribution |
| **Silent failure detectors (×7)** | 🟡 High | 4 weeks | **P1** | Value beyond crashes |
| **ROI / Time-saved metrics** | 🟡 High | 2 weeks | **P1** | Enterprise justification |
| **Team sync MVP** | 🟢 Medium | 4 weeks | **P2** | Collaboration & Revenue |

---

## Stage 1: The Causal Context Layer (Weeks 1–4)

### Week 1: Deterministic Joins & Evidence Taxonomy

#### Task 1.1: Implement EXACT joins (Trace Correlation) ⏱️ 3 days

**Goal:** Link browser network calls to backend logs with 100% certainty.

**Implementation:**
- [ ] Auto-inject `traceparent` headers into all outbound `fetch`/`XHR` in the extension.
- [ ] Update Node/Python/Go SDKs to extract `traceparent` and include it in log metadata.
- [ ] Update `causal.ts` to scan for matching trace IDs and label them as **EXACT** in the Context Pack.

**Acceptance criteria:**
- [ ] `analyze_runtime` shows `EXACT` labels when trace IDs match.
- [ ] AI agent can cite specific backend log lines as the confirmed cause of a browser error.

---

#### Task 1.2: Evidence-based Taxonomy Update ⏱️ 2 days

**Goal:** Move from "91% confidence" to "2 EXACT joins, 1 LINKED join."

**Implementation:**
- [ ] Update `Hypothesis` type to include `evidenceTier: 'EXACT' | 'LINKED' | '~CORR' | 'OBS'`.
- [ ] Replace percentage-based confidence with a list of verified evidence pieces.
- [ ] Update `prompts.ts` to instruct the LLM on how to weigh different evidence tiers.

**Acceptance criteria:**
- [ ] Context Pack leads with Evidence, not just Confidence.
- [ ] "EXACT" evidence is prioritized at the top of the diagnosis.

---

#### Task 1.3: "Why Mergen?" Marketing & Docs ⏱️ 2 days

**Goal:** Explicitly differentiate against `chrome-devtools-mcp`.

**Implementation:**
- [ ] Update `README.md` and `CLAUDE.md` to highlight the **Real Browser** moat.
- [ ] Create a "Headless vs. Real" comparison table.
- [ ] Record a 30s demo debugging an app behind a REAL login (OAuth/SSO) that headless tools can't touch.

---

## Stage 2: Distribution & silent failures (Weeks 5–8)

### Week 5: Distribution Foundation

#### Task 2.1: npm + Chrome Web Store publish ⏱️ 7 days

**Goal:** One-click install via `npx mergen-server` and the Web Store.

---

### Week 6–8: Silent Failure Detectors

#### Task 3.1: Catch "Invisible" Bugs ⏱️ 14 days

**Implementation:**
- [ ] Implement detectors for:
  - Infinite render loops (React/Vue)
  - Swallowed promises (empty catch blocks)
  - CORS preflight failures (silent in console)
  - Hydration mismatches (SSR/CSR)
  - Stale closures (React useState)

---

## Stage 3: ROI & Team Features (Weeks 9–12)

### Week 9–10: ROI Metrics

#### Task 4.1: Time-to-resolution tracking ⏱️ 7 days

**Goal:** Prove "3.2 hours saved per month" by tracking time from `analyze_runtime` to `git commit`.

---

### Week 11–12: Team Sync MVP

#### Task 5.1: Shared Calibration ⏱️ 7 days

**Goal:** Aggregate "Evidence accuracy" across the team to suppress flaky detectors.

---

## Success Metrics (90-Day Checkpoint)

- [ ] **1,000 weekly active users**
- [ ] **$5,000 MRR**
- [ ] **EXACT joins enabled in 50% of user sessions** (SDK adoption metric)
- [ ] **Avg detector accuracy > 75%**

---

**End of Plan**
