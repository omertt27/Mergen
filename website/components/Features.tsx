const IconLoop = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
    <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
  </svg>
)

const IconDatabase = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3"/>
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
  </svg>
)

const IconShield = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
)

const IconArchive = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="21 8 21 21 3 21 3 8"/>
    <rect x="1" y="3" width="22" height="5"/>
    <line x1="10" y1="12" x2="14" y2="12"/>
  </svg>
)

const IconClock = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>
)

const IconServer = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
    <line x1="6" y1="6" x2="6.01" y2="6"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>
)

const features = [
  {
    num: '01',
    icon: <IconLoop />,
    title: 'Autonomous Incident Loop',
    desc: (
      <>
        PagerDuty fires → causal analysis across all telemetry → override corpus consulted →
        fix executes at <span className="highlight">≥85% confidence</span> → validated (error count before/after) →
        RESOLVED posted to your Slack thread. Engineer wakes up to a closed incident and a full audit trail.
        <span className="highlight"> 94% root cause accuracy on our 33-incident eval corpus — 31 of 33 incidents correctly classified.</span>
      </>
    ),
  },
  {
    num: '02',
    icon: <IconDatabase />,
    title: 'Override Corpus',
    desc: (
      <>
        Every time your team overrides Mergen's recommendation, that decision is encoded as policy.
        After six months of production: your Friday settlement windows, your compliance holds,
        your on-call's preferred fixes — <span className="highlight">structured, queryable, and impossible to replicate from a standing start.</span>{' '}
        The diagnosis algorithm is reproducible. The accumulated operational memory of your infrastructure is not.
        This is the moat.
      </>
    ),
  },
  {
    num: '03',
    icon: <IconShield />,
    title: 'Agent Blunder Log',
    desc: (
      <>
        Every autonomous action Mergen's safety layer blocks is recorded with its reason:
        allowlist block, RBAC rejection, override corpus halt, planning gate denial.
        <span className="highlight"> The headline number is "prevented" — autonomous actions your on-call didn't have to handle.</span>{' '}
        This is the board-deck answer to "why would you trust an AI agent with prod?" The system blocked itself, logged why, and waited.
      </>
    ),
  },
  {
    num: '04',
    icon: <IconArchive />,
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
    icon: <IconClock />,
    title: 'Measurable MTTR',
    desc: (
      <>
        Designed for the <span className="highlight">sleep-deprived on-call engineer</span>. Mergen closes
        the loop from PagerDuty trigger to validated fix without manual dashboard jumping, log grepping,
        or Slack back-and-forth. The impact report tracks{' '}
        <span className="highlight">autonomous MTTR vs. manual MTTR per failure mode</span>{' '}
        — exportable as a shareable PDF your CTO can present to the board.
      </>
    ),
  },
  {
    num: '06',
    icon: <IconServer />,
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
            <div className="feature-icon">{f.icon}</div>
            <span className="feature-num">{f.num}</span>
            <h3 className="feature-title">{f.title}</h3>
            <p className="feature-desc">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}