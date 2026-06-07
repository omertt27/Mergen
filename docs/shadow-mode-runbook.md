# Shadow Mode Runbook

**Time to complete:** ~30 minutes  
**Audience:** SRE / platform team, design partners

Shadow mode runs the full Mergen diagnosis pipeline on every PagerDuty incident and posts what it _would have done_ to your Slack thread — without executing anything. After 30 days you have a track record: approval rate, MTTR delta, failure mode breakdown. That track record is what your CISO reviews before approving autonomous execution.

---

## Step 1 — Install the server (5 min)

```bash
npm install -g mergen-server
```

Verify:

```bash
mergen-server --version
```

---

## Step 2 — Create a Slack app (5 min)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it **Mergen** (or anything), select your workspace
3. **OAuth & Permissions** → scroll to **Bot Token Scopes** → add `chat:write`
4. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
5. Invite Mergen to your incidents channel: `/invite @Mergen` in `#incidents`

---

## Step 3 — Connect PagerDuty (5 min)

In PagerDuty:

1. Select the service you want Mergen to watch
2. **Integrations** → **Add another integration** → **Generic Webhooks (V3)**
3. Webhook URL: `https://YOUR_SERVER:3000/webhooks/pagerduty`
4. Events: `incident.triggered` (required), optionally `incident.resolved`

If you're running locally (no public URL yet): use [ngrok](https://ngrok.com) to expose the port:

```bash
ngrok http 3000
# Use the https://xxx.ngrok.io URL in PagerDuty
```

---

## Step 4 — Connect your telemetry (5 min)

Point your OpenTelemetry exporter at Mergen. Zero code changes required.

```bash
# Python
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 python your_app.py

# Node.js
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node your_app.js

# Or add the one-line SDK to your Node.js entry point:
import 'mergen-server/sdk/node.js';
```

If you use Datadog and want trace context in diagnoses:

```bash
export DD_API_KEY=...
export DD_APP_KEY=...
export DATADOG_SITE=datadoghq.com   # or your Datadog region
```

---

## Step 5 — Start in shadow mode (1 min)

```bash
MERGEN_SHADOW_MODE=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-YOUR_TOKEN \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

That's it. Mergen is now running in shadow mode.

**Verify the server started:**

```bash
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

Expected output includes `"status": "ok"`.

---

## Step 6 — Trigger a test incident (5 min)

Simulate an incident to verify the end-to-end flow before waiting for a real one:

```bash
# 1. Inject a fake error event
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "console",
    "level": "error",
    "args": ["[api] database connection timeout — pool exhausted after 30s"],
    "url": "http://api:8080/health",
    "timestamp": '$(date +%s000)'
  }'

# 2. Fire a test PagerDuty webhook (simulates incident.triggered)
curl -X POST http://127.0.0.1:3000/webhooks/pagerduty \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [{
      "event": "incident.triggered",
      "incident": {
        "id": "TEST001",
        "title": "api-service HIGH error rate",
        "service": { "summary": "api-service" },
        "created_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
      }
    }]
  }'
```

Within 10 seconds, you should see a Slack thread reply in `#incidents`:

```
👁️ Shadow mode — would execute:
   <command based on diagnosis>
   Diagnosis: X% confidence | Remediation: Y% confidence
   Awaiting manual action.
```

If you don't see the message: check `mergen-server` logs for errors and verify the bot is in the channel.

---

## Week 1–4: annotating shadow entries

After each real incident, review Mergen's recommendation in the Slack thread and annotate it:

```bash
# Get the list of recent shadow entries
curl -s http://127.0.0.1:3000/shadow-report/entries | python3 -m json.tool

# Approve a recommendation
curl -X POST http://127.0.0.1:3000/shadow-report/<id>/verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "would-approve"}'

# Record a case where you would have done something different
curl -X POST http://127.0.0.1:3000/shadow-report/<id>/verdict \
  -H 'Content-Type: application/json' \
  -d '{
    "verdict": "would-override",
    "overrideReason": "batch-window",
    "note": "Friday 20-24 UTC — settlement run makes pool resize unsafe",
    "manualAction": "kubectl rollout restart deployment/api"
  }'
```

Valid override reasons: `batch-window` · `cost-constraint` · `on-call-discretion` · `compliance-hold` · `prefer-read-replica` · `maintenance-window` · `wrong-diagnosis` · `wrong-fix` · `other`

`would-override` annotations automatically build the **override corpus** — Mergen learns your operational patterns and will consult them before executing in autopilot mode.

---

## Weekly digest (automatic)

If you set `MERGEN_SLACK_DIGEST_CHANNEL`, Mergen posts a weekly digest every Monday at 09:00 UTC. To preview at any time:

```bash
# JSON summary
curl http://127.0.0.1:3000/shadow-report

# Slack block format (what the weekly post looks like)
curl http://127.0.0.1:3000/shadow-report/slack-digest
```

---

## After 30 days: review the track record

```bash
# Open the full impact report in your browser (save as PDF for CISO)
open http://127.0.0.1:3000/impact-report?format=html

# JSON for your own analysis
curl http://127.0.0.1:3000/impact-report
```

The report shows:
- Total incidents processed
- Approval rate (recommendations your team would have applied as-is)
- Average autonomous MTTR vs. actual manual MTTR
- Per-failure-mode breakdown (which detector types are most/least accurate)
- Side-by-side comparison: Mergen's proposed action vs. what your engineer did

**If approval rate > 80%:** you're ready to enable autopilot. See below.

**If approval rate < 80%:** review the `wrong-diagnosis` and `wrong-fix` override entries. Common causes: service name not matching (`api` vs `api-service`), missing Datadog trace context, or detector thresholds tuned for a different traffic volume. Open a GitHub issue with the shadow entry JSON and we'll help tune it.

---

## Enabling autopilot

Once you're satisfied with the track record:

```bash
# Replace MERGEN_SHADOW_MODE=true with MERGEN_AUTOPILOT=true
MERGEN_AUTOPILOT=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-YOUR_TOKEN \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

The override corpus carries over — patterns your team marked during shadow mode will continue to gate autopilot execution.

---

## Troubleshooting

**No Slack thread after PagerDuty fires:**
- Confirm `MERGEN_SLACK_BOT_TOKEN` is set: `echo $MERGEN_SLACK_BOT_TOKEN`
- Confirm bot is in the channel: `/invite @Mergen` in `#incidents`
- Check logs: `mergen-server start 2>&1 | grep -i slack`

**Shadow report is empty:**
- Confirm `MERGEN_SHADOW_MODE=true` is set
- Confirm PagerDuty webhook is sending `incident.triggered` events (not just `incident.resolved`)
- Test with the manual webhook curl above

**Diagnosis confidence is always low (<50%):**
- Ensure your OpenTelemetry exporter is pointed at Mergen (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000`)
- Add `OTEL_SERVICE_NAME=your-service-name` to your app startup
- If using Datadog: verify `DD_API_KEY` and `DD_APP_KEY` are set

**Questions or issues:**
- GitHub: [github.com/omertt27/Mergen/issues](https://github.com/omertt27/Mergen/issues)
- Email: hello@mergen.dev
