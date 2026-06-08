const sources = [
  { tag: 'PAGERDUTY',  label: 'PagerDuty Webhook',  sub: 'incident.triggered · P1/P2' },
  { tag: 'OTLP :4318', label: 'OpenTelemetry',       sub: 'Spans · Logs · Go · Java · .NET' },
  { tag: 'DOCKER',     label: 'Docker / K8s',        sub: 'Container log streams' },
  { tag: 'CI/CD',      label: 'CI Pipeline',         sub: 'GitHub Actions · build events' },
]

const outputs = [
  { label: 'Slack Thread',  sub: 'Diagnose · Approve · Resolve' },
  { label: 'Claude Code',   sub: 'claude mcp add mergen' },
  { label: 'Cursor',        sub: '.cursor/mcp.json' },
  { label: 'VS Code',       sub: '.vscode/mcp.json' },
]

export default function Architecture() {
  return (
    <section id="how">
      <span className="section-label">01 // How It Works</span>
      <h2>
        Alert in.
        <br />
        Fix out.
      </h2>

      <div className="arch-view mt-lg">
        <div className="arch-grid" />
        <div className="arch-flow">

          {/* ── Sources column ── */}
          <div className="arch-col">
            {sources.map((s) => (
              <div key={s.tag} className="arch-mini-box">
                <span className="tag" style={{ fontSize: '0.5rem' }}>{s.tag}</span>
                <h4 style={{ fontSize: '0.7rem', marginTop: '0.5rem', marginBottom: '0.25rem' }}>
                  {s.label}
                </h4>
                <p style={{ fontSize: '0.6rem', color: 'var(--gray-600)', lineHeight: 1.4 }}>
                  {s.sub}
                </p>
              </div>
            ))}
          </div>

          {/* ── Left connector ── */}
          <div className="arch-flow-connector">
            <div className="arch-flow-line" />
            <div className="arch-flow-arrow">›</div>
          </div>

          {/* ── Center: MCP Server ── */}
          <div
            className="arch-box"
            style={{
              borderColor: 'var(--accent)',
              boxShadow: '0 0 40px rgba(165, 243, 252, 0.08)',
              width: '220px',
              flexShrink: 0,
              alignSelf: 'center',
            }}
          >
            <span className="tag" style={{ background: 'var(--accent)', color: '#000' }}>
              AUTOPILOT
            </span>
            <h4 style={{ margin: '1rem 0 0.5rem' }}>Mergen Server</h4>
            <code style={{ fontSize: '0.6rem', color: 'var(--accent-text)', display: 'block' }}>
              localhost:3000
            </code>
            <code style={{ fontSize: '0.6rem', color: 'var(--gray-600)', display: 'block', marginTop: '0.25rem' }}>
              OTLP: 4318
            </code>
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--gray-800)', paddingTop: '0.75rem' }}>
              {['Causal analysis', 'Blast radius model', 'Execution gate', 'Auto-rollback', 'Adaptive threshold'].map((f) => (
                <div key={f} style={{ fontSize: '0.6rem', color: 'var(--gray-400)', marginBottom: '0.3rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: 'var(--accent-text)', fontSize: '0.5rem' }}>—</span>
                  {f}
                </div>
              ))}
            </div>
          </div>

          {/* ── Right connector ── */}
          <div className="arch-flow-connector">
            <div className="arch-flow-line" />
            <div className="arch-flow-arrow">›</div>
          </div>

          {/* ── Outputs column ── */}
          <div className="arch-col">
            {outputs.map((o) => (
              <div key={o.label} className="arch-mini-box">
                <span className="tag" style={{ fontSize: '0.5rem', background: 'var(--gray-800)', color: 'var(--gray-400)' }}>
                  AI IDE
                </span>
                <h4 style={{ fontSize: '0.7rem', marginTop: '0.5rem', marginBottom: '0.25rem' }}>
                  {o.label}
                </h4>
                <code style={{ fontSize: '0.55rem', color: 'var(--gray-600)' }}>{o.sub}</code>
              </div>
            ))}
          </div>

        </div>
      </div>
    </section>
  )
}
