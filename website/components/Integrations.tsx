const sources = [
  { name: 'Datadog',       type: 'Observability', tag: 'Traces + Logs' },
  { name: 'PagerDuty',     type: 'Alerting',      tag: 'Webhook' },
  { name: 'Terraform',     type: 'Infra',         tag: 'Topology' },
  { name: 'Git',           type: 'Code',          tag: 'Postmortems' },
  { name: 'Slack',         type: 'Chat',          tag: 'Timeline' },
  { name: 'Kubernetes',     type: 'Infra',         tag: 'Manifests' },
  { name: 'Prometheus',    type: 'Metrics',       tag: 'OpenTelemetry' },
  { name: 'AWS/GCP',       type: 'Cloud',         tag: 'Config' },
]

const ides = [
  { name: 'Claude Code',    tag: 'get_incident_context' },
  { name: 'Cursor',         tag: 'get_datadog_trace' },
  { name: 'Windsurf',       tag: 'analyze_production' },
  { name: 'VS Code',        tag: 'mcp.json' },
]

export default function Integrations() {
  return (
    <section id="integrations">
      <span className="section-label">03 // Integrations</span>
      <h2>
        Connect your stack.
        <br />
        Route your context.
      </h2>

      <div className="integ-grid mt-lg">
        <div>
          <p className="integ-label">Data Sources</p>
          <div className="integ-row">
            {sources.map((s) => (
              <div key={s.name} className="integ-card">
                <span className="integ-name">{s.name}</span>
                <span className="integ-tag">{s.tag}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="integ-divider">
          <div className="integ-arrow">→</div>
          <span style={{ fontSize: '0.55rem', color: 'var(--gray-600)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Infrastructure<br />Layer
          </span>
          <div className="integ-arrow">→</div>
        </div>

        <div>
          <p className="integ-label">AI IDEs</p>
          <div className="integ-row integ-row-sm">
            {ides.map((ide) => (
              <div key={ide.name} className="integ-card integ-card-accent">
                <span className="integ-name">{ide.name}</span>
                <code className="integ-tag">{ide.tag}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
