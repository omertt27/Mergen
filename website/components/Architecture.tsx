const sources = [
  { tag: 'PAGERDUTY',     label: 'Incident Alerts',   sub: 'Webhooks · Severity V3' },
  { tag: 'OPENTELEMETRY', label: 'Traces + Metrics',  sub: 'OTLP HTTP · any language' },
  { tag: 'DOCKER',        label: 'Container Logs',    sub: 'stdout/stderr · any stack' },
  { tag: 'DATADOG',       label: 'APM Spans',         sub: 'Optional · blame attribution' },
]

const outputs = [
  { label: 'Claude Code',  sub: 'triage_incident' },
  { label: 'Cursor',       sub: 'analyze_runtime' },
  { label: 'Slack',        sub: 'Owns the thread' },
  { label: 'Audit Log',    sub: 'Reversible JSONL' },
]

const howSteps = [
  {
    num: '1',
    title: 'Connect your production stack',
    desc: 'Ingest signals from PagerDuty, OpenTelemetry, Docker, Kubernetes, and optionally Datadog. No agent required.',
  },
  {
    num: '2',
    title: 'Detect and understand incidents',
    desc: 'When an alert fires, Mergen correlates telemetry across services, identifies the likely root cause, and matches it against past incidents and overrides.',
  },
  {
    num: '3',
    title: 'Apply operational memory',
    desc: 'Mergen checks what your team did last time — past fixes, human overrides, known failure patterns — before generating a validated remediation plan.',
  },
  {
    num: '4',
    title: 'Resolve or recommend',
    desc: 'Shadow mode: suggestion only. Assisted: recommended fix + approval. Autopilot: safe execution within constraints. Every action is logged and reversible.',
  },
]

export default function Architecture() {
  return (
    <section id="how">
      <span className="section-label">03 // How It Works</span>
      <h2>
        Four steps from alert
        <br />
        to resolution.
      </h2>

      {/* ── Step list ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1px', background: 'var(--gray-800)', border: '1px solid var(--gray-800)', marginBottom: '5rem' }}>
        {howSteps.map((s) => (
          <div key={s.num} style={{ background: 'var(--bg)', padding: '2.5rem' }}>
            <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.65rem', color: 'var(--accent-text)', letterSpacing: '0.1em', display: 'block', marginBottom: '1rem' }}>
              STEP {s.num}
            </span>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--white)', marginBottom: '0.75rem', lineHeight: 1.3 }}>
              {s.title}
            </h3>
            <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.7 }}>
              {s.desc}
            </p>
          </div>
        ))}
      </div>

      {/* ── Data flow diagram ── */}
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
                'Incident history',
                'Override corpus',
                'Root cause engine',
                'Agent Blunder Log',
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
