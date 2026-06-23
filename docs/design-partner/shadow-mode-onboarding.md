# Design Partner Shadow Mode Onboarding

30-day track record before any autonomous execution. Zero risk — Mergen diagnoses and records but never acts.

---

## Day 0 — Install (15 minutes)

```bash
# 1. Install
npm install -g mergen-server

# 2. Start in shadow mode
MERGEN_SHADOW_MODE=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start

# 3. Add to your AI IDE
claude mcp add mergen --transport stdio -- node "$(which mergen-server-bin)"

# 4. Verify
curl http://127.0.0.1:3000/health
```

Shadow mode means: Mergen evaluates every agent tool call against its policy engine, records what it would have blocked, but **never blocks the handler**. Your agents run exactly as before — Mergen watches and records.

---

## Day 1–7 — Let agents run normally

Don't change agent behavior. The shadow log builds from your actual traffic.

Check what's accumulating:
```bash
# Shadow log: what would have been blocked
curl http://127.0.0.1:3000/shadow-report/entries | jq '.entries[] | {tool, verdict, reason}'

# Override corpus: patterns Mergen is learning
curl http://127.0.0.1:3000/override-corpus | jq '.summary'

# Agent blunder log (shadow mode still records what would have been blocked)
curl http://127.0.0.1:3000/agent-blunders | jq '{total: .stats.total, byType: .stats.byType}'
```

---

## Day 7 — First feedback call (30 min)

Agenda:
1. Review shadow log together — are the verdicts reasonable?
2. Tune policy rules if needed (`~/.mergen/enterprise-policy.json`)
3. Check if override corpus is picking up your team's patterns

What to send before the call:
```bash
curl http://127.0.0.1:3000/shadow-report | jq > shadow-week1.json
```

---

## Day 14 — Connect PagerDuty (optional, for incident triage value)

```bash
# In PagerDuty: Service → Webhooks → https://your-server:3000/webhooks/pagerduty
MERGEN_PAGERDUTY_SECRET=your-pd-signing-secret mergen-server restart
```

Once connected, every PagerDuty incident is:
1. Analyzed against your telemetry
2. Matched against the override corpus
3. Posted to Slack with root cause + fix recommendation

All in shadow mode — no commands execute.

---

## Day 21 — Review shadow report

```bash
curl http://127.0.0.1:3000/shadow-report
```

At this point you should see:
- `totalEvaluated`: total agent tool calls evaluated
- `wouldHaveBlocked`: calls that would have been blocked by policy
- `wouldHaveHeld`: calls that would have required HITL approval
- `corpusMatches`: pattern matches from your override corpus

This is the CISO evidence package. Share it with your security team.

---

## Day 30 — Decision point

Option A: **Enable autopilot** (autonomous incident resolution)
```bash
MERGEN_AUTOPILOT=true \
MERGEN_SHADOW_MODE=false \
MERGEN_PAGERDUTY_SECRET=... \
mergen-server restart
```

Option B: **Stay in shadow mode** (diagnosis + Slack alerts, no autonomous execution)
Continue as-is. The shadow report keeps growing.

Option C: **Enable HITL only** (agent tool calls held for human approval)
```bash
MERGEN_HITL_WEBHOOK_URL=https://hooks.slack.com/... \
mergen-server restart
```
This gives you the enforcement gate without full autopilot.

---

## Sharing feedback

Weekly check-in (10 min):
```bash
# Export the week's data
curl http://127.0.0.1:3000/shadow-report/entries?since=$(date -d '7 days ago' +%s)000 > week.json
curl http://127.0.0.1:3000/agent-blunders > blunders.json
```

Send to hello@mergen.dev or post in the shared Slack channel.

Specifically useful:
- False positives (Mergen said it would block something benign)
- False negatives (Mergen missed something it should have caught)
- Policy rules you want to add or modify
- Corpus patterns that surprised you

---

## Key metrics to track

| Metric | Where | Why it matters |
|--------|-------|----------------|
| `wouldHaveBlocked` total | `/shadow-report` | Board answer to "what would agents have done?" |
| Override corpus size | `/override-corpus` | Moat building — how much your team's knowledge is encoded |
| Corpus accuracy | `/shadow-report/entries` + your annotations | Trust signal before enabling autopilot |
| MTTR delta | `/incidents/impact-report` (after PD connected) | ROI: how much faster are incidents with Mergen? |
