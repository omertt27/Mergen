const sources = [
  { tag: 'CLAUDE CODE',   label: 'MCP Tool Ingestion', sub: 'Synchronous stdio stream' },
  { tag: 'CURSOR',        label: 'IDE Execution Wrapper', sub: 'Intercepts terminal runs' },
  { tag: 'CI/CD PIPELINE',label: 'Git Hooks & Actions', sub: 'Autonomous PR evaluation' },
  { tag: 'CUSTOM AGENTS', label: 'SDK / API Integrations', sub: 'Zero-trust runtime gate' },
]

const outputs = [
  { label: 'OS & File System', sub: 'Enforced sandboxed paths' },
  { label: 'Cloud Infrastructure', sub: 'AWS, GCP, Terraform APIs' },
  { label: 'Databases & VPCs', sub: 'Isolated query execution' },
  { label: 'Slack HITL',      sub: 'Operator approval webhook' },
]

const howSteps = [
  {
    num: '1',
    title: 'Define local security policies',
    desc: 'Set up rules matching command patterns, file paths, and environment settings. Rules can block outright or require validation.',
  },
  {
    num: '2',
    title: 'Intercept agent tool calls',
    desc: 'MCP tool calls, terminal commands, and filesystem modifications pass through the local gate before execution.',
  },
  {
    num: '3',
    title: 'Enforce deterministic rules',
    desc: 'Mergen checks commands against safety rules and SQLite history in <1ms without LLM latency, blocking destructive actions.',
  },
  {
    num: '4',
    title: 'HITL approval & audit logs',
    desc: 'Pauses execution for unverified actions to request human approval. Logs every block to ~/.mergen/agent-blunders.json.',
  },
]

export default function Architecture() {
  return (
    <section id="arch">
      <span className="section-label">03 // How It Works</span>
      <h2>
        Four steps from tool call
        <br />
        to target runtime.
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

          {/* ── Center: Execution & Security Gateway ── */}
          <div
            className="arch-box"
            style={{
              borderColor: 'var(--accent)',
              boxShadow: '0 0 40px rgba(255, 85, 0, 0.06)',
              width: '240px',
              flexShrink: 0,
              alignSelf: 'center',
            }}
          >
            <span className="tag" style={{ background: 'var(--accent)', color: '#fff' }}>
              SECURITY GATEWAY
            </span>
            <h4 style={{ margin: '1rem 0 0.5rem' }}>Mergen</h4>
            <code style={{ fontSize: '0.6rem', color: 'var(--accent-text)', display: 'block' }}>
              Execution &amp; Security Gateway
            </code>
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--gray-800)', paddingTop: '0.75rem' }}>
              {[
                'SQLite override corpus',
                'Local policy engine',
                'Deterministic gates',
                'Agent Blunder Log',
                'PII & Secret Shield',
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
                  {o.label === 'Slack HITL' ? 'COMMS' : 'TARGET'}
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
