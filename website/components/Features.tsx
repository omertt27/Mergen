const features = [
  {
    num: '01',
    title: 'Override Corpus',
    desc: (
      <>
        Every time your team overrides Mergen's recommendation, that decision is encoded as policy.
        After six months of production: your Friday settlement windows, your compliance holds,
        your on-call's preferred fixes — <span className="highlight">structured, queryable, and impossible to replicate from a standing start.</span> The diagnosis algorithm is reproducible. The accumulated operational memory of your infrastructure is not.
      </>
    ),
  },
  {
    num: '02',
    title: 'Agent Blunder Log',
    desc: (
      <>
        Every autonomous action Mergen's safety layer blocks is recorded with its reason:
        allowlist block, RBAC rejection, override corpus halt, planning gate denial.
        <span className="highlight"> The headline number is "prevented" — autonomous actions your on-call didn't have to handle.</span>{' '}
        This is the answer to "why would you trust an AI agent with prod?" The system blocked itself, logged why, and waited.
      </>
    ),
  },
  {
    num: '03',
    title: 'Autonomous Incident Loop',
    desc: (
      <>
        PagerDuty fires → causal analysis across all telemetry → override corpus consulted →
        fix executes at <span className="highlight">≥85% confidence</span> → validated (error count before/after) →
        RESOLVED posted to your Slack thread. Engineer wakes up to a closed incident and a full audit trail.
        MTTR: 5 minutes. Manual: 45.
      </>
    ),
  },
  {
    num: '04',
    title: 'Institutional Memory',
    desc: (
      <>
        Every resolved incident generates a structured postmortem, indexed by{' '}
        <span className="highlight">BM25 + TF-IDF hybrid retrieval</span>. When an agent opens a file,
        the IDE receives relevant past incidents automatically — before it's asked, before it writes a line.
        Future agents don't re-discover constraints that burned your on-call at 3am six months ago.
      </>
    ),
  },
  {
    num: '05',
    title: '5-Minute MTTR',
    desc: (
      <>
        Designed for the <span className="highlight">sleep-deprived on-call engineer</span>. Mergen resolves
        routine production incidents in under 5 minutes — replacing 45 minutes of manual dashboard jumping,
        log grepping, and Slack back-and-forth. The impact report shows autonomous MTTR vs. manual MTTR,
        per failure mode, as a shareable PDF your CTO can present to the board.
      </>
    ),
  },
  {
    num: '06',
    title: 'Local-First. VPC-Ready.',
    desc: (
      <>
        Mergen runs <span className="highlight">entirely on your infrastructure</span>. No Datadog required to start —
        point it at Docker containers or drop one import into your Node.js entry point.
        PII shield is always on. Execution audit trail written to <code>~/.mergen/audit.log</code> as immutable JSONL.
        Cloud mode adds TLS, SSO, RBAC, and per-tenant event isolation when you need it.
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">03 // Capabilities</span>
      <h2>
        The moat is what
        <br />
        accumulates.
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
