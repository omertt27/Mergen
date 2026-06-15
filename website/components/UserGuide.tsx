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
    num: '03',
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

export default function UserGuide() {
  return (
    <section id="guide">
      <span className="section-label">05 // Getting Started</span>
      <h2>
        Up in five minutes.
        <br />
        Production-ready in a week.
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
            <pre className="guide-step-code"><code>{step.code}</code></pre>
            <p className="guide-step-note">{step.note}</p>
          </div>
        ))}
      </div>

      <div className="guide-cta">
        <a href="https://github.com/omertt27/Mergen/blob/main/INSTALL.md" className="btn btn-outline">
          Full Install Guide →
        </a>
        <a href="mailto:hello@mergen.dev" className="btn-ghost">
          Talk to us about your stack
        </a>
      </div>
    </section>
  )
}