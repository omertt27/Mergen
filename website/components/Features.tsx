const features = [
  {
    num: '01',
    title: 'Blast Radius Analysis',
    desc: (
      <>
        Before executing any fix, Mergen models the worst case: scope (pod / deployment / cluster),
        estimated downtime, whether it is{' '}
        <span className="highlight">reversible</span>, and how long rollback takes.
        The full assessment is available at <code>GET /blast-radius</code> so your pipelines
        can gate on it independently.
      </>
    ),
  },
  {
    num: '02',
    title: 'Execution Gate',
    desc: (
      <>
        Deploy- and cluster-tier fixes are never run without a human sign-off.
        Mergen posts an{' '}
        <span className="highlight">Approve / Deny block to your Slack thread</span> and waits up
        to 15 minutes. Button clicks route through <code>POST /slack/actions</code> — no
        dashboards to open, no CLI commands to remember.
      </>
    ),
  },
  {
    num: '03',
    title: 'Automatic Rollback',
    desc: (
      <>
        When <code>validate_fix</code> returns a <span className="highlight">REGRESSED</span> verdict,
        Mergen derives and executes the inverse command immediately —{' '}
        <code>kubectl rollout undo</code>, <code>helm rollback</code>, package version revert.
        No human intervention needed to undo a bad fix.
      </>
    ),
  },
  {
    num: '04',
    title: 'Adaptive Confidence Threshold',
    desc: (
      <>
        The 85% execution threshold is not a constant. Mergen runs{' '}
        <span className="highlight">ROC analysis</span> (Youden's J) on your calibration corpus
        after every 20 verdicts and shifts the threshold to whatever maximises true-positive rate
        minus false-positive rate on your actual incident history.
      </>
    ),
  },
  {
    num: '05',
    title: 'Incident Replay',
    desc: (
      <>
        Every incident's telemetry snapshot is saved to disk. Replay any past incident against
        the{' '}
        <span className="highlight">current detector set</span> to regression-test new rules before
        they touch production. Use <code>POST /incidents/:pid/replay</code> to diff old vs. new
        diagnosis — no need to wait for the next real incident.
      </>
    ),
  },
  {
    num: '06',
    title: 'Local Sovereignty',
    desc: (
      <>
        Every byte stays on <span className="highlight">127.0.0.1</span>. No cloud backend, no
        accounts, no telemetry leaving your infrastructure. PII Shield scrubs JWTs, API keys,
        emails, and secrets at ingest — configurable per-entity via <code>~/.mergen/pii-config.json</code>.
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">02 // Capabilities</span>
      <h2>
        Enterprise-grade.
        <br />
        Zero config.
      </h2>
      <div className="feature-grid">
        {features.map((f, i) => (
          <div
            key={f.num}
            className="feature-card"
            style={
              i === 1 ? { gridColumn: '8 / span 5', marginTop: '5rem' }
              : i === 3 ? { gridColumn: '8 / span 4', marginTop: '-1rem' }
              : i === 2 ? { gridColumn: '2 / span 5' }
              : undefined
            }
          >
            <span className="feature-num">{f.num}</span>
            <h3 className="feature-title">{f.title}</h3>
            <p className="feature-desc">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
