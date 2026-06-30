# Design Partner Outreach — Email Templates

## Target profile

Prioritize prospects by segment:

**Tier 1 — self-serve / low-friction**
- Small and mid-size engineering teams already using Cursor, Windsurf, Claude Code, VS Code Copilot, or GitHub Copilot Coding Agent with real shell/file/MCP access.
- Power users who have publicly discussed agent mistakes, destructive commands, prompt-injection issues, or unsafe tool access.
- AI agent framework maintainers or infra teams building LangChain, CrewAI, AutoGPT-style, or internal agent platforms.

**Tier 2 — design partner / paid pilot**
- Fintech or healthtech companies deploying internal AI agents for ops, support, incident response, or engineering automation.
- DevOps/SRE teams allowing agents to touch Terraform, Kubernetes, CI/CD, deployment, database, or incident-remediation workflows.
- Teams with PagerDuty, Datadog, Sentry, or public postmortems in the last 12 months.

**Tier 3 — later enterprise motion**
- Central security, platform, or AI governance teams at larger enterprises.
- Track these accounts, but do not lead outreach here until shadow-mode proof and the enterprise threat model are ready.

Best current target: mid-market engineering teams (15–100 developers) with AI coding agents in active use, enough incident volume to care, and no fully staffed AI governance function yet.

**Find them:** Search LinkedIn for "VP Engineering" + "Cursor" or "Claude Code" at companies with 50–300 employees. GitHub: repos with `.cursor/mcp.json` or `.claude/mcp.json` committed.

---

## Email 1 — Cold outreach (VP Engineering)

**Subject:** AI agents in your stack — are they gated?

Hi [name],

I noticed [company] is using [Cursor / Claude Code] — we are too, and we ran into the same problem: agents inherit full tool access with no enforcement layer. A prompt saying "don't drop tables" isn't a gate. It's a suggestion.

We built Mergen to solve this. It's a lightweight MCP proxy that physically intercepts every tool call before the handler runs — in under 1ms, deterministically, with no LLM in the path. Destructive commands are blocked. Schema mutations are held for approval. Every blocked action is hash-chained to an audit log your CISO can read.

The first 30 days run in shadow mode — Mergen watches what your agents would have done and records what it would have blocked. Zero risk. At the end of 30 days you have a concrete track record: "here are the 47 agent actions our gate would have intercepted."

Would you be open to a 20-minute call? I can show you what shadow mode looks like against your actual agent traffic.

[Your name]
Mergen — The Execution and Security Gateway for AI Agents
hello@mergen.dev

---

## Email 2 — Follow-up (if no response after 5 days)

**Subject:** Re: AI agents in your stack

Hi [name],

One specific thing I wanted to share: the problem isn't that agents are malicious. It's that they're helpful — so they'll do exactly what you ask, including the thing you didn't realize you were asking.

The case that keeps happening: an agent asked to "clean up stale records" calls the same `execute_fix` tool that runs `DROP TABLE`. Nothing in the MCP protocol prevents it.

Mergen's local gate stops it in <1ms — before the handler runs, with no cloud call. Takes 10 minutes to set up. I can walk you through it.

[Your name]

---

## Email 3 — CISO / Head of Platform (direct)

**Subject:** Governance layer for AI coding agents

Hi [name],

Your engineering team is likely using AI coding agents with write access to production systems. Most aren't governed — MCP tools have no mandatory authorization layer, and system prompts are probabilistic guardrails that fail under adversarial injection or unusual context shifts.

Mergen is the first Agent Execution Governance (AEG) platform. We sit inline between the agent and your infrastructure:

- Hard blocks on destructive commands (<1ms, no LLM in path)
- HITL approval via Slack for schema migrations and high-blast-radius changes
- Hash-chained Agent Blunder Log — tamper-evident audit trail of every intercepted action
- Shadow mode: 30-day evidence package before you grant autonomous execution

This isn't a recommendation engine. The gate physically holds the Promise until a human approves.

I'd like to set up a 20-minute technical call. Do you have time this week?

[Your name]

---

## Qualifying questions for the first call

1. "What AI coding agents are you running today — Claude Code, Cursor Composer, GitHub Copilot Coding Agent?"
2. "Do any of them have write access — can they run shell commands, execute database queries, or deploy?"
3. "What's your current answer to 'how do you know an agent won't do something destructive?'"
4. "Have you had any incidents where an AI agent did something unexpected?"
5. "Who on your team would need to sign off on a governance tool — is this a VP Eng decision or does it need CISO?"

**Green flags:** "we're thinking about this", "we had an incident last month", "our CISO asked us this question"
**Red flags:** "we don't give agents write access" (not the right stage), "we use system prompts to control it" (education opportunity)

---

## Design partner terms

What we ask for:
- Install Mergen in shadow mode for 30 days
- Review and annotate shadow verdicts weekly (10 min/week)
- One 30-min feedback call at day 15 and day 30
- Willing to share anonymized metrics (blunder count, corpus size) for case study

What you get:
- Free Growth tier for 6 months ($1,800 value)
- Direct access to the roadmap — your incidents shape the override corpus features
- CISO-ready shadow report at day 30: "here's what your agents tried to do, here's what Mergen would have blocked"
