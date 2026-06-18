const categories = [
  { label: 'DB Connection Pool',              total: 5, passed: 5 },
  { label: 'OOM Kill',                        total: 5, passed: 5 },
  { label: 'Rate Limit Cascade',              total: 3, passed: 3 },
  { label: 'Certificate Expiry',              total: 3, passed: 3 },
  { label: 'Disk Pressure',                   total: 3, passed: 3 },
  { label: 'Service Unavailable',             total: 3, passed: 3 },
  { label: 'Slow Query',                      total: 2, passed: 2 },
  { label: 'Downstream Latency',              total: 3, passed: 3 },
  { label: 'Queue Backlog',                   total: 3, passed: 3 },
  { label: 'Upstream Error',                  total: 1, passed: 1 },
  { label: 'False positive (probe/scrape errors)', total: 2, passed: 0, note: 'Fires on /health and /metrics — human override needed' },
]

export default function EvalProof() {
  return (
    <section id="eval">
      <span className="section-label">05 // Evaluation</span>
      <h2>
        Evaluated before
        <br />
        you ever use it.
      </h2>

      <p style={{ maxWidth: '640px', color: 'var(--gray-400)', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '5rem' }}>
        We built a regression eval harness before shipping v1. Every PR that touches detection logic
        must pass this suite — 33 real incident scenarios, 10 infrastructure failure classes.
        When we say 94% accuracy, that number is reproducible and falsifiable.
      </p>

      <div className="eval-layout">
        {/* ── Score card ── */}
        <div className="eval-score-card">
          <span style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: '0.65rem',
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
            color: 'var(--gray-600)',
            display: 'block',
            marginBottom: '1rem',
          }}>
            Overall accuracy
          </span>
          <div style={{
            fontSize: 'clamp(4rem, 10vw, 7rem)',
            fontWeight: 900,
            letterSpacing: '-0.05em',
            color: 'var(--accent)',
            lineHeight: 1,
            fontFamily: 'var(--font-geist-mono), monospace',
          }}>
            94%
          </div>
          <div style={{ marginTop: '1.5rem', color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            31 of 33 incidents classified correctly
          </div>
          <div style={{
            marginTop: '2rem',
            paddingTop: '2rem',
            borderTop: '1px solid var(--gray-800)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}>
            {[
              { k: 'Corpus size',      v: '33 incidents' },
              { k: 'Correct',          v: '31 / 33' },
              { k: 'False positives',  v: '2 (probe errors)' },
              { k: 'Last eval run',    v: 'Jun 16, 2026' },
            ].map(({ k, v }) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                <span style={{ color: 'var(--gray-600)' }}>{k}</span>
                <span style={{ color: 'var(--white)', fontFamily: 'var(--font-geist-mono), monospace' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Category breakdown ── */}
        <div className="eval-table">
          <div className="eval-table-header">
            <span>Failure class</span>
            <span style={{ textAlign: 'right' }}>Fixtures</span>
            <span style={{ textAlign: 'right' }}>Accuracy</span>
          </div>
          {categories.map((c) => {
            const pct = Math.round((c.passed / c.total) * 100)
            const isFail = pct === 0
            return (
              <div key={c.label} className="eval-table-row" style={isFail ? { background: 'rgba(239,68,68,0.03)' } : undefined}>
                <div>
                  <span className="eval-table-label" style={isFail ? { color: 'var(--gray-400)' } : undefined}>{c.label}</span>
                  {'note' in c && c.note && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--gray-600)', fontFamily: 'var(--font-geist-mono), monospace', marginTop: '0.2rem' }}>
                      {c.note}
                    </div>
                  )}
                </div>
                <span className="eval-table-n">{c.passed}/{c.total}</span>
                <div className="eval-bar-wrap">
                  <div
                    className="eval-bar-fill"
                    style={{
                      width: `${pct}%`,
                      background: isFail ? 'rgba(239,68,68,0.4)' : undefined,
                    }}
                  />
                  <span className="eval-bar-pct" style={isFail ? { color: '#f87171' } : undefined}>{pct}%</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{
        marginTop: '4rem',
        padding: '2rem 3rem',
        border: '1px solid var(--gray-800)',
        borderLeft: '3px solid var(--accent)',
        background: 'rgba(8,145,178,0.03)',
        maxWidth: '800px',
      }}>
        <p style={{ color: 'var(--gray-400)', fontSize: '0.95rem', lineHeight: 1.7 }}>
        <span style={{ color: 'var(--white)', fontWeight: 700 }}>Why this matters:</span>{' '}
        Most observability tools are evaluated by the engineers who built them, on the incidents they chose.
        Mergen ships a public eval harness — the same suite that gates every release.
        The 2 failures are documented: the detector fires on liveness probe and Prometheus scrape errors when it shouldn't.
        Fix is in the roadmap; hiding it is not.
        </p>
        <a href="https://github.com/omertt27/Mergen/blob/main/server/eval-baseline.json" target="_blank" rel="noopener noreferrer" className="btn-ghost" style={{ marginTop: '1.5rem', display: 'inline-block' }}>
        View Full JSON Baseline →
        </a>
        </div>
        </section>
        )
        }