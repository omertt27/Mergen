# Mergen: 90-Day Technical Improvement & Phase Implementation Plan
**Plan Date:** June 22, 2026  
**Strategic Vector:** Knowledge Compounding & Operational Intelligence Infrastructure

---

## Executive Summary

This plan details the technical execution roadmap for Mergen's pivot from a generic SRE autopilot to an **Operational Intelligence Infrastructure** platform. 

Instead of building high-friction autonomous executors, our primary engineering milestone is **knowledge compounding**: automatically capturing, processing, and indexing engineering resolutions and postmortems into a queryable **Override Corpus**. 

This document maps out the specific files, schemas, and deliverables for each of the five maturity phases.

---

## 5-Phase Technical Roadmap & File Allocations

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Operational Memory (Sensor Ingest & Distribution)             │
│ Phase 2: Operational Intelligence (IDE Context Packs & ROI Telemetry) │
│ Phase 3: Agent Safety & Governance (CI/CD Deployment Gates)            │
│ Phase 4: Organizational Learning (Slack-to-Override Automated Loop)    │
│ Phase 5: Autonomous Operations (Self-Healing under safety policies)    │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: Operational Memory (Sensor Ingest & Distribution)
**Objective:** Package and distribute the sensors (`mergen-open`) to establish a zero-friction developer acquisition funnel.

* **Task 1.1: Standalone Server Packaging**
  * *Goal:* Package `mergen-server` into a single-binary distribution using `pkg` so developers can install it with a single command without needing Node.js installed locally.
  * *Target Files:* Modify `server/package.json` to configure target binaries (`node20-macos-x64`, `node20-linux-x64`, `node20-win-x64`) and update the build script in `scripts/build-cli.mjs`.
* **Task 1.2: Chrome Web Store & Firefox Add-on Submission**
  * *Goal:* Publish the browser extension to the official stores to remove "Developer Mode" requirements which are blocked by corporate CISO policies.
  * *Target Files:* Package files under `extension/` and configure auto-update keys in `extension/manifest.json`.
* **Task 1.3: Continuous System Ingest**
  * *Goal:* Cleanly ingest local process errors, network logs, and Docker streams into the O(1) local ring buffer.
  * *Target Files:* Audit and optimize [server/src/sensor/buffer.ts](file:///Users/omer/Desktop/Mergen/server/src/sensor/buffer.ts) and [server/src/sensor/otlp-receiver.ts](file:///Users/omer/Desktop/Mergen/server/src/sensor/otlp-receiver.ts).

---

### Phase 2: Operational Intelligence (IDE Integration & ROI)
**Objective:** Serve structured context briefs to Cursor/Claude Code and prove developer time savings.

* **Task 2.1: Semantic Context Pack Builder**
  * *Goal:* Compress log noise to output a structured, cache-friendly markdown Brief for AI assistants.
  * *Target Files:* Enhance [server/src/intelligence/tools-analysis.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/tools-analysis.ts) to filter out Vite/Next.js HMR clutter.
* **Task 2.2: Time-to-Resolution (TTR) tracking**
  * *Goal:* Deduce time saved per bug. Automatically infer when a bug is resolved by watching Git hooks.
  * *Target Files:* Implement git log watch in `server/src/sensor/commit-context-store.ts` and aggregate metrics in [server/src/routes/impact-report.ts](file:///Users/omer/Desktop/Mergen/server/src/routes/impact-report.ts).
* **Task 2.3: VS Code Sidebar UI Panel**
  * *Goal:* Present live credit usage, active detectors, and the `/roi` dashboard.
  * *Target Files:* Update the sidebar webview panel in `vscode-extension/src/sidebar.ts`.

---

### Phase 3: Agent Safety & Governance (CI/CD Deployment Gates)
**Objective:** Intercept agent-written code changes in CI/CD and block them before they reach production.

* **Task 3.1: GitHub Action CI Gate**
  * *Goal:* Create a GitHub Action (`mergen-gate`) that runs on every Pull Request. It extracts modified file paths and configuration changes, queries the local Mergen daemon, and evaluates safety.
  * *Target Files:* Create `packages/github-action/index.ts` and write routes in `server/src/routes/ci.ts`.
* **Task 3.2: Semantic Action Risk & Blast Radius Evaluator**
  * *Goal:* Evaluate proposed deployment modifications (e.g., database env edits, package upgrades) against the historical failure context using a local LLM prompt.
  * *Target Files:* Complete [server/src/intelligence/action-risk.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/action-risk.ts) and [server/src/intelligence/blast-radius.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/blast-radius.ts).

---

### Phase 4: Organizational Learning (Slack-to-Override Memory Flywheel)
**Objective:** Capture unstructured human conversations from Slack or Postmortems and automatically translate them into machine-readable policy.

* **Task 4.1: Slack Thread NLP Resolution Ingestion**
  * *Goal:* Listen to messages in Slack incident channels. When an engineer posts a resolution summary or triggers a postmortem command, send the thread text to a local LLM to extract context-dependent rules (e.g., *"auth changes require API reboot during off-hours"*).
  * *Target Files:* Implement NLP parser logic in [server/src/intelligence/slack-digest.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/slack-digest.ts) and link it to Slack event router in [server/src/intelligence/slack.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/slack.ts).
* **Task 4.2: Automated Override Generation**
  * *Goal:* Write extracted policies directly into the Override Corpus with a generated rationale field containing the original Slack message link.
  * *Target Files:* Create automated writers in [server/src/intelligence/override-corpus.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/override-corpus.ts).
* **Task 4.3: Git ADR & Postmortem Parser**
  * *Goal:* Read Markdown files matching `docs/adr/*.md` or `docs/postmortems/*.md` on every commit and import historical rules.
  * *Target Files:* Create markdown parser in `server/src/intelligence/postmortem-store.ts`.

---

### Phase 5: Autonomous Operations (Self-Healing under safety policies)
**Objective:** Execute autonomous fixes safely under strict, user-defined safety policies.

* **Task 5.1: Immutable Safety Policy Gate (Layer 3)**
  * *Goal:* Implement a policy file (`~/.mergen/safety-policy.json`) that explicitly forbids the execution of high-risk actions (e.g., DB restarts, volume wipes, data drop) regardless of LLM confidence scores.
  * *Target Files:* Code validation gates in [server/src/intelligence/execution-gate.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/execution-gate.ts).
* **Task 5.2: Self-Correcting Rollback & Incident Validation**
  * *Goal:* After running an approved change, monitor the telemetry receiver for 5 seconds. If error counts increase, execute the rollback command automatically.
  * *Target Files:* Refine loop in [server/src/intelligence/incident-autopilot.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/incident-autopilot.ts) and rollback definitions in [server/src/intelligence/rollback.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/rollback.ts).
* **Task 5.3: CISO Agent Blunder Log**
  * *Goal:* Log all blocked commands and self-healed incidents as audit proof.
  * *Target Files:* Expose audit log API in `server/src/routes/agent-blunders.ts`.

---

## 90-Day Execution Timeline

```
 Weeks 1-4 (Phase 1 & 2 Boost)
  ├── Publish mergen-open to Chrome Web Store and npm.
  ├── Compress Context Pack token output size.
  └── Build /roi time-saved telemetry database.

 Weeks 5-8 (Phase 3 Gate & Risk Models)
  ├── Build GitHub Action PR safety controller.
  └── Complete Semantic Action Risk + Blast Radius evaluation engines.

 Weeks 9-12 (Phase 4 Flywheel & Postmortems)
  ├── Connect Slack event receiver to local LLM parser.
  └── Implement automatic override corpus compilation from postmortems.
  └── Ship Phase 4 dashboard representing the "Knowledge Compounding" metrics.
```
