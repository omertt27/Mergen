'use client'

import { useState } from 'react'

const steps = [
  {
    num: '01',
    title: 'See it in 60 seconds',
    tag: 'zero config · Node.js 18+',
    body: 'Run one command. Mergen starts a local server, loads 50 sample incidents from public postmortems, and immediately shows you a root cause analysis. No PagerDuty, no OTLP, no IDE setup required.',
    code: 'npx mergen-server',
    note: 'Opens http://localhost:3000/demo — click "Trigger P1 Incident" or ask a question in the chat tab.',
  },
  {
    num: '02',
    title: 'Connect Your Stack (optional)',
    tag: 'PagerDuty · OTLP · Docker',
    body: 'When you\'re ready to switch from sample incidents to real production data, connect one source. Start with Docker logs — it requires zero configuration and works immediately.',
    code: `# Docker logs (easiest — works immediately)
curl -X POST http://127.0.0.1:3000/watchers/docker

# PagerDuty → Service → Webhooks → https://your-host:3000/webhooks/pagerduty

# OTLP (any language — one env var)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js`,
    note: 'Pilot success condition: Mergen correctly analyzes 1 real incident in your environment.',
  },
  {
    num: '03',
    title: 'Add to Your AI IDE',
    tag: 'Claude Code · Cursor · VS Code',
    body: 'Register Mergen as an MCP server. The tools — triage_incident, analyze_runtime, validate_fix — appear automatically in your IDE.',
    code: `# Guided setup (detects your IDE automatically)
mergen-server setup

# Or manually — Claude Code
claude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"`,
    note: 'Ask: "What caused the last incident?" — Mergen answers with root cause + fix hint.',
  },
  {
    num: '04',
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
        First insight in 60 seconds.
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