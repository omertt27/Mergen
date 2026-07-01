const sources = [
  { name: 'PagerDuty',     type: 'Alerting',    tag: 'Incident triggers' },
  { name: 'Datadog',       type: 'APM',         tag: 'Traces + logs' },
  { name: 'Slack',         type: 'Approvals',   tag: 'Authorization loops' },
  { name: 'Kubernetes',    type: 'Infra',       tag: 'Least privilege gates' },
  { name: 'GitHub',        type: 'CI/CD',       tag: 'PR security gate' },
]

const ides = [
  { name: 'Claude Code',    tag: 'terminal_gateway' },
  { name: 'Cursor',         tag: 'editor_intercept' },
  { name: 'VS Code',        tag: 'extension_policy' },
]

export default function Integrations() {
  return (
    <section id="integrations">
      <span className="section-label">SYSTEM_INTEGRATIONS</span>
      <h2>
        Every signal feeds
        <br />
        the enforcement gate.
      </h2>

      <div className="integ-grid mt-lg">
        <div>
          <p className="integ-label">Data Sources & Platforms</p>
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
          <span style={{ fontSize: '0.55rem', color: 'var(--gray-600)', letterSpacing: '0.1em', textTransform: 'uppercase', textAlign: 'center' }}>
            Policy<br />Engine
          </span>
          <div className="integ-arrow">→</div>
        </div>

        <div>
          <p className="integ-label">AI Agent IDEs & CLI Tools</p>
          <div className="integ-row integ-row-sm" style={{ gridTemplateColumns: '1fr' }}>
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
