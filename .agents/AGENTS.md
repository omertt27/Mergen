# Mergen Customization Rules: Solo-Dev & Startup Strategy Alignment

This document outlines the core product philosophy and behavior guidelines for developers and AI agents working on Mergen.

## 🎯 The Core Philosophy (Positioning)

We reject enterprise-only abstractions in our developer-facing messaging. The value proposition of Mergen is simple:
* **"AI agents can write code, deploy infrastructure, and access production systems. Prompts are not security boundaries."**
* **"Mergen is the Execution and Security Gateway that enforces deterministic controls before AI actions reach your runtime, cloud infrastructure, or developer environment."**

The primary promise is: **"Secure Every AI Agent Action Before It Executes."**

---

## 🛠️ The 3 Killer Use Cases for Solo Developers

All developer-facing features must map into one of these three killer workflows to create immediate value in the daily coding loop:

1. **"Why did this break again?" (Incident Re-occurrence Prevention)**
   * *The Pain*: A dev hits the same bug weeks/months later, forgets the root cause, and wastes time re-diagnosing it.
   * *The Feature*: When an error occurs, Mergen checks SQLite history and returns: *"This error has happened before. Here's what you did last time and why it worked."*

2. **"My AI agent is confidently wrong" (Tool and Command Interception)**
   * *The Pain*: Cursor or Claude Code proposes a fix that seems plausible but breaks something else (or runs a destructive command).
   * *The Feature*: Intercept/check proposed changes and tool calls against historical failures and safety rules: *"This change previously caused incident #12 in your repo."* or blocking destructive command strings.

3. **"I don't understand my own system anymore" (Execution Visualizer)**
   * *The Pain*: Side projects grow large and complex, leading to a forgotten mental model of runtime behavior.
   * *The Feature*: Present an auto-generated, living map of how your services actually communicate and behave at runtime (the visual audit trail of agent activity).

---

## 🚫 What NOT to Build for Solo Devs

Do **NOT** spend cycles on the following features for solo-dev workflows:
* Dashboards or administrative reports
* Enterprise governance interfaces
* Complex compliance or multi-tier policy systems
* Heavy administrative setup (e.g., custom configuration UI panels)

---

## 📈 Strategic Scaling Alignment

Our long-term architectural alignment matches this taxonomy:

* **Layer 1 — Local Execution Gateway (Solo Devs)**: Intercept CLI/MCP tool calls, block destructive commands, prompt-injection/secret exposure protection.
* **Layer 2 — Team Governance Gateway (Teams)**: CI/CD control gates, GitHub checks, Slack-based approvals, audit logs.
* **Layer 3 — Agent IAM (Enterprise)**: Identity federation, ephemeral credentials, least privilege execution sandboxes, SOC2/compliance.

Every interaction in solo mode must automatically capture incident traces, overrides, and fix logs to build a **micro-override corpus** that matures into an **organizational override corpus** when they upgrade or transition to a team.
