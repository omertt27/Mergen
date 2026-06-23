# Mergen Customization Rules: Solo-Dev & Startup Strategy Alignment

This document outlines the core product philosophy and behavior guidelines for developers and AI agents working on Mergen.

## 🎯 The Core Philosophy (Positioning)

We reject enterprise-only abstractions in our developer-facing messaging. The value proposition of Mergen is simple:
* **"Mergen remembers what your AI coding assistant forgets."**
* **"Stop debugging the same problem twice."**
* **"Make your AI understand your codebase over time."**

The primary promise is: **"Ship faster without breaking your own system twice."**

---

## 🛠️ The 3 Killer Use Cases for Solo Developers

All developer-facing features must map into one of these three killer workflows to create immediate value in the daily coding loop:

1. **"Why did this break again?"**
   * *The Pain*: A dev hits the same bug weeks/months later, forgets the root cause, and wastes time re-diagnosing it.
   * *The Feature*: When an error occurs, Mergen checks SQLite history and returns: *"This error has happened before. Here's what you did last time and why it worked."*

2. **"My AI agent is confidently wrong"**
   * *The Pain*: Cursor or Claude Code proposes a fix that seems plausible but breaks something else.
   * *The Feature*: Intercept/check proposed changes against historical failures: *"This change previously caused incident #12 in your repo."*

3. **"I don't understand my own system anymore"**
   * *The Pain*: Side projects grow large and complex, leading to a forgotten mental model of runtime behavior.
   * *The Feature*: Present an auto-generated, living map of how your services actually communicate and behave at runtime (behavior memory, not static docs).

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

* **Solo Devs**: Generate behavioral data + distribution. They act as the **sensor network** for the intelligence layer.
* **Teams**: Generate monetization + structured knowledge.
* **Enterprise**: Generates the defensibility moat (depth of the Override Corpus).

Every interaction in solo mode must automatically capture incident traces, overrides, and fix logs to build a **micro-override corpus** that matures into an **organizational override corpus** when they upgrade or transition to a team.
