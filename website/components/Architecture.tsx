const sources = [
  { tag: 'DOCKER',      label: 'Container Logs',    sub: 'stdout/stderr · any stack' },
  { tag: 'PAGERDUTY',   label: 'Incident Alerts',   sub: 'Webhooks · Severity V3' },
  { tag: 'OPENTELEMETRY', label: 'Traces + Metrics', sub: 'OTLP HTTP · any language' },
  { tag: 'DATADOG',     label: 'APM Spans',         sub: 'Optional · blame attribution' },
]

const outputs = [
  { label: 'Claude Code',  sub: 'triage_incident' },
  { label: 'Cursor',       sub: 'analyze_runtime' },
  { label: 'Slack',        sub: 'Owns the thread' },
  { label: 'Audit Log',    sub: 'CISO-ready JSONL' },
]

export default function Architecture() {
  return (
    <section id="how">
      <span className="section-label">01 // How It Works</span>
      <h2>
        Production context.
        <br />
        Machine-readable.
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

          {/* ── Center: Operational Memory Layer ── */}
          <div
            className="arch-box"
            style={{
              borderColor: 'var(--accent)',
              boxShadow: '0 0 40px rgba(165, 243, 252, 0.08)',
              width: '240px',
              flexShrink: 0,
              alignSelf: 'center',
            }}
          >
            <span className="tag" style={{ background: 'var(--accent)', color: '#000' }}>
              MEMORY LAYER
            </span>
            <h4 style={{ margin: '1rem 0 0.5rem' }}>Mergen</h4>
            <code style={{ fontSize: '0.6rem', color: 'var(--accent-text)', display: 'block' }}>
              Operational Memory Layer
            </code>
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--gray-800)', paddingTop: '0.75rem' }}>
              {[
                'Override Corpus',
                'Agent Blunder Log',
                'Causal Engine',
                'Postmortem Store',
                'PII Shield',
              ].map((f) => (
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
                  {o.label === 'Slack' ? 'COMMS' : o.label === 'Audit Log' ? 'COMPLIANCE' : 'AI IDE'}
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
