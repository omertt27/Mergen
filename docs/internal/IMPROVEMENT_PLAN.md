# Mergen: 90-Day Technical Improvement & Phase Implementation Plan
**Plan Date:** June 22, 2026  
**Strategic Vector:** Execution & Security Gateway for AI Agents

---

## Executive Summary

This plan details the technical execution roadmap for Mergen as the **Execution and Security Gateway for AI Agents**.

AI agents can write code, deploy infrastructure, and access production systems. Prompts are not security boundaries. Mergen sits inline between AI agents and your systems, blocking unsafe actions, enforcing approval workflows, and creating auditable execution trails across development and production environments.

This document maps out the specific files, schemas, and deliverables for each of the three layers of the Product Pyramid.

---

## 3-Layer Technical Roadmap & File Allocations

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Local Execution Gateway (Today)                               │
│ Layer 2: Team Governance Gateway (Next)                                │
│ Layer 3: Agent IAM (Future)                                            │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Layer 1: Local Execution Gateway (Today)
**Objective:** Intercept and evaluate agent actions on the developer machine to prevent dangerous local executions.

* **Task 1.1: Local Gateway & MCP Interception**
  * *Goal:* Intercept standard stdio and JSON-RPC tool calls from Cursor, Claude Code, and other editors, evaluating them in under 1ms.
  * *Target Files:* Audit and optimize [server/src/sensor/buffer.ts](file:///Users/omer/Desktop/Mergen/server/src/sensor/buffer.ts) and [server/src/intelligence/execution-gate.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/execution-gate.ts).
* **Task 1.2: Destructive Command & Secret Exposure Blocking**
  * *Goal:* Match proposed command lines against destructive patterns (e.g., `rm -rf`, `terraform destroy`) and scan input payloads for exposed credentials or secrets before they reach the shell.
  * *Target Files:* Implement pattern filters and secret scan patterns in `server/src/intelligence/action-risk.ts`.
* **Task 1.3: Standalone Server Distribution**
  * *Goal:* Package `mergen-server` into a single-binary distribution via `npm` so developers can run `npx mergen-server` with zero local configuration.
  * *Target Files:* Modify `server/package.json` configurations and build commands.

---

### Layer 2: Team Governance Gateway (Next)
**Objective:** Enforce policies at the team boundary, blocking unsafe AI-generated code from reaching production.

* **Task 2.1: CI/CD Gates (GitHub Action)**
  * *Goal:* Create a GitHub Action (`mergen-gate`) that runs on every Pull Request to analyze changed files against historical incident traces and safety policies.
  * *Target Files:* Create `packages/github-action/index.ts` and write handlers in `server/src/routes/ci-gate.ts`.
* **Task 2.2: Slack Approval Workflows (HITL)**
  * *Goal:* Implement held-promise workflows where database schema migrations or high-risk changes trigger a Slack interactive button payload, resuming only after developer confirmation.
  * *Target Files:* Implement webhook routes in [server/src/intelligence/slack.ts](file:///Users/omer/Desktop/Mergen/server/src/intelligence/slack.ts) and link to the execution gate.
* **Task 2.3: Audit Logging & Tamper-Evident History**
  * *Goal:* Log all blocked commands, calibration parameters, and human overrides to a hash-chained Agent Blunder Log.
  * *Target Files:* Build router handlers in `server/src/routes/agent-blunders.ts`.

---

### Layer 3: Agent IAM (Future)
**Objective:** Govern autonomous agents at enterprise scale with rigorous identity and privilege bounds.

* **Task 3.1: Identity Federation & Ephemeral Credentials**
  * *Goal:* Provision short-lived AWS/GCP session credentials dynamically scoped per tool execution rather than using long-lived developer tokens.
  * *Target Files:* Create mock credential providers under `server/src/auth/ephemeral-credentials.ts`.
* **Task 3.2: Least Privilege Execution Sandboxes**
  * *Goal:* Confine shell execution to lightweight sandboxes, preventing raw access to the developer's root host OS or cloud networks.
  * *Target Files:* Configure runtime execution wrappers in `server/src/sandbox/runner.ts`.
* **Task 3.3: Human-to-Agent Authorization Mapping**
  * *Goal:* Maintain fine-grained authorization maps matching human roles (e.g. CISO, Tech Lead) to the execution limits they are authorized to delegate to an agent.

---

## 90-Day Execution Timeline

```
 Weeks 1-4 (Layer 1 Core & Local Interception)
  ├── Build local command parser and regex gate controllers.
  ├── Ship prompt-injection and secret exposure interceptors.
  └── Finalize single-binary packaging for frictionless developer setup.

 Weeks 5-8 (Layer 2 CI/CD & Team Control Gates)
  ├── Develop GitHub Action integration and blast-radius evaluation engine.
  └── Connect Slack webhook handler for human-in-the-loop approvals.
  └── Standardize JSONL tamper-evident audit logs.

 Weeks 9-12 (Layer 3 Specifications & Enterprise Design)
  ├── Prototype ephemeral session token generator.
  └── Draft SOC2 compliance reporting framework.
  └── Initiate design partner pilots with early access cohorts.
```
