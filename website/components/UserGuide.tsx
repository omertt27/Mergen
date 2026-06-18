'use client'

import { useState } from 'react'

const steps = [
  {
    num: '01',
    title: 'Install',
    tag: 'npm / binary',
    body: 'One command sets up Mergen, walks you through integrations, and creates the config file.',
    code: 'npx mergen-server@latest setup',
    note: 'Requires Node.js 18+. Binaries available for macOS / Linux / Windows.',
  },
  {
    num: '02',
    title: 'Replay Your Last Incident',
    tag: '< 30 min · no real alert required',
    body: 'Before a real incident fires, replay one that already happened. POST your last alert to the demo endpoint — Mergen runs full causal analysis and posts what it would have done.',
    code: `# Inject a past incident and see Mergen's diagnosis
curl -X POST http://127.0.0.1:3000/demo \\
  -H 'Content-Type: application/json' \\
  -d '{"scenario":"db-pool-exhaustion"}'

# Or replay a real PagerDuty incident payload:
curl -X POST http://127.0.0.1:3000/webhooks/pagerduty \\
  -H 'Content-Type: application/json' \\
  -d @your-last-alert.json`,
    note: 'Pilot success condition: Mergen correctly analyzes 1 real incident in your environment.',
  },
  {
    num: '03',
    title: 'Connect Your Stack',
    tag: 'PagerDuty · OTLP · Docker',
    body: 'Point your PagerDuty webhook at Mergen, set your OTLP exporter endpoint, or stream Docker logs in one curl.',
    code: `# PagerDuty → Service → Webhooks → https://your-host:3000/webhooks/pagerduty
# OTLP (any language)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js
# Docker logs
curl -X POST http://127.0.0.1:3000/watchers/docker`,
    note: 'No Datadog required. Start with Docker logs — it works from day one.',
  },
  {
    num: '04',
    title: 'Add to Your AI IDE',
    tag: 'Claude Code · Cursor · VS Code',
    body: 'Register Mergen as an MCP server. The tools — triage_incident, analyze_runtime, validate_fix — appear automatically in your IDE.',
    code: `# Claude Code
claude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"

# Cursor / Windsurf / VS Code
# .cursor/mcp.json and .vscode/mcp.json are already committed in this repo`,
    note: 'Ask: "What caused the last incident?" — Mergen answers with root cause + fix hint.',
  },
  {
    num: '05',
    title: 'Enable Autopilot',
    tag: 'optional · ≥85% confidence gate',
    body: 'Set MERGEN_AUTOPILOT=true to let Mergen execute fixes autonomously. Starts in shadow mode for 30 days — builds a track record before it acts.',
    code: `MERGEN_AUTOPILOT=true mergen-server start
# Shadow mode (observe only, no execution):
# omit MERGEN_AUTOPILOT — triage_incident still available on demand`,
    note: 'Every blocked action is recorded in the Agent Blunder Log. Audit trail at ~/.mergen/audit.log.',
  },
]

function StepCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block-container">
      <pre className="guide-step-code"><code>{code}</code></pre>
      <button className="copy-btn guide-copy-btn" onClick={handleCopy} aria-label="Copy code">
        {copied ? (
          <span className="copy-ok">✓</span>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  )
}

export default function UserGuide() {
  return (
    <section id="guide">
      <span className="section-label">06 // Getting Started</span>
      <h2>
        First value in 30 minutes.
        <br />
        Pilot success: 1 real incident analyzed.
      </h2>

      <div className="guide-steps mt-lg">
        {steps.map((step) => (
          <div key={step.num} className="guide-step">
            <div className="guide-step-header">
              <span className="guide-step-num">{step.num}</span>
              <div>
                <span className="tag">{step.tag}</span>
                <h3 className="guide-step-title">{step.title}</h3>
              </div>
            </div>
            <p className="guide-step-body">{step.body}</p>
            <StepCode code={step.code} />
            <p className="guide-step-note">{step.note}</p>
          </div>
        ))}
      </div>

      <div className="guide-cta">
        <a href="https://github.com/omertt27/Mergen/blob/main/INSTALL.md" className="btn btn-outline">
          Full Install Guide →
        </a>
        <a href="mailto:hello@mergen.dev" className="btn-ghost">
          Define your pilot success criteria →
        </a>
      </div>
    </section>
  )
}