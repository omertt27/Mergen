'use client'

import { useState } from 'react'

const steps = [
  {
    num: '01',
    title: 'Start the local gate',
    tag: 'zero config · Node.js 18+',
    body: 'Run one command. Mergen starts the local policy gate and binds to 127.0.0.1:3000. Every MCP tool call your AI agent makes now passes through the gate before the handler runs.',
    code: 'npx mergen-server',
    note: 'Verify the gate is live: curl http://127.0.0.1:3000/health → { "ok": true, "gate": "active" }',
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
    title: 'Build the Override Corpus',
    tag: 'shadow mode · corpus enforcement',
    body: 'Run in shadow mode to start building your team\'s Override Corpus — the record of every override, constraint, and postmortem that makes Mergen specific to your infrastructure. Enable autopilot only after the corpus has established a track record.',
    code: `# Start with shadow mode (builds corpus, no execution)
MERGEN_SHADOW_MODE=true mergen-server start

# Enable auto-learning from Slack postmortems
MERGEN_SLACK_OVERRIDE_LOOP=true mergen-server start

# When ready: opt-in to autonomous resolution
# MERGEN_AUTOPILOT=true mergen-server start`,
    note: 'Every blocked action is recorded in the Agent Blunder Log at GET /agent-blunders. Hard Safety Policies at ~/.mergen/safety-policy.json always apply first.',
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
        Gate running in 60 seconds.
        <br />
        Pilot success: first blocked action logged.
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
        <a href="/guide" className="btn btn-outline">
          Full Install Guide →
        </a>
        <a href="mailto:hello@mergen.dev" className="btn-ghost">
          Define your pilot success criteria →
        </a>
      </div>
    </section>
  )
}