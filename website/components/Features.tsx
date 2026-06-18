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

const SlackAuditTrail = () => (
  <div style={{
    marginTop: '2rem',
    background: '#1a1d21',
    border: '1px solid #30363d',
    borderRadius: '8px',
    padding: '1.25rem',
    fontSize: '0.8rem',
    color: '#d1d2d3',
    boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  }}>
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div style={{ width: '36px', height: '36px', background: 'var(--accent)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyCenter: 'center', color: 'white', fontWeight: 800, fontSize: '0.6rem' }}>MRG</div>
      <div>
        <div style={{ fontWeight: 900, marginBottom: '4px', color: 'white' }}>Mergen <span style={{ fontWeight: 400, fontSize: '0.7rem', color: '#ababad', marginLeft: '6px' }}>APP 3:17 PM</span></div>
        <div style={{ marginBottom: '8px' }}>✅ <b>Incident #402 resolved autonomously</b></div>
        <div style={{ background: '#222529', border: '1px solid #30363d', borderRadius: '4px', padding: '12px', borderLeft: '4px solid var(--accent)' }}>
          <div style={{ color: '#ababad', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Audit Trail Summary</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div>• <b>Root Cause:</b> DB Connection Pool exhaustion (api-service)</div>
            <div>• <b>Confidence:</b> 91% (matches pattern: <i>stuck_idle_connections</i>)</div>
            <div>• <b>Action:</b> Flushed idle pools & increased capacity (max_idle: 5 → 20)</div>
            <div>• <b>Validation:</b> Error rate 14% → 0.02% (confirmed 3:18 PM)</div>
          </div>
        </div>
      </div>
    </div>
  </div>
)

const IDEHint = () => (
  <div style={{
    marginTop: '2rem',
    background: '#0d0d0d',
    border: '1px solid var(--gray-800)',
    borderRadius: '4px',
    padding: '0',
    overflow: 'hidden',
    boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  }}>
    <div style={{ background: '#1a1a1a', padding: '6px 12px', fontSize: '0.6rem', color: '#666', borderBottom: '1px solid #222', display: 'flex', justifyContent: 'space-between' }}>
      <span>auth_middleware.ts — Mergen Context</span>
      <span>mcp.json</span>
    </div>
    <div style={{ padding: '12px', fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.7rem' }}>
      <div style={{ color: '#666' }}>// Mergen: Historical Context found</div>
      <div style={{ color: '#4ade80', background: 'rgba(74, 222, 128, 0.05)', padding: '4px', margin: '8px 0', borderLeft: '2px solid #4ade80' }}>
        ⚠️ This file was modified in <b>Incident #388</b> (OOM Kill).
        <br/>Reason: Recursive token validation on nested JWTs.
        <br/>Constraint: Do not increase stack depth > 4.
      </div>
      <div style={{ opacity: 0.5 }}>
        <span style={{ color: '#c084fc' }}>export const</span> <span style={{ color: '#60a5fa' }}>validateToken</span> = (token: <span style={{ color: '#fbbf24' }}>string</span>) =&gt; &#123;
        <br/>&nbsp;&nbsp;<span style={{ color: '#666' }}>// checking depth...</span>
      </div>
    </div>
  </div>
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
        RESOLVED posted to your Slack thread.
        <SlackAuditTrail />
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
        your on-call's preferred fixes — <span className="highlight">structured, queryable, and impossible to replicate from a standing start.</span>
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
        <span className="highlight"> The headline number is "prevented" — autonomous actions your on-call didn't have to handle.</span>
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
        the IDE receives relevant past incidents automatically.
        <IDEHint />
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
        the loop without manual dashboard jumping or log grepping. The impact report tracks{' '}
        <span className="highlight">autonomous MTTR vs. manual MTTR per failure mode</span>.
      </>
    ),
  },
  {
    num: '06',
    icon: <IconServer />,
    title: 'Local-First. VPC-Ready.',
    desc: (
      <>
        Mergen runs <span className="highlight">entirely on your infrastructure</span>. Point it at Docker containers
        or drop one import into your Node.js entry point. PII shield is always on.
        Execution audit trail written to <code>~/.mergen/audit.log</code> as immutable JSONL.
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