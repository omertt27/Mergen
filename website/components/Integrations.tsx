const sources = [
  { name: 'PagerDuty',     type: 'Alerting',      tag: 'Incident trigger' },
  { name: 'Datadog',       type: 'Observability', tag: 'Traces + Logs' },
  { name: 'Slack',         type: 'Knowledge',     tag: 'Postmortem → corpus' },
  { name: 'Git',           type: 'Code',          tag: 'ADR → policy' },
  { name: 'Kubernetes',    type: 'Infra',         tag: 'Events + Manifests' },
  { name: 'Prometheus',    type: 'Metrics',       tag: 'OpenTelemetry' },
  { name: 'GitHub',        type: 'CI/CD',         tag: 'PR safety gate' },
  { name: 'AWS/GCP',       type: 'Cloud',         tag: 'Config + Topology' },
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
      <span className="section-label">04 // Integrations</span>
      <h2>
        Every source is a lesson.
        <br />
        Mergen keeps the receipt.
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
            Knowledge<br />Corpus
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
