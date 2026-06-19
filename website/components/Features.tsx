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
      <div style={{ width: '36px', height: '36px', background: 'var(--accent)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: '0.6rem' }}>MRG</div>
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
        <br/>Constraint: Do not increase stack depth &gt; 4.
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
    title: 'Operational Memory & Calibration',
    desc: (
      <>
        Every resolved incident generates a structured record. To resolve AI overconfidence, Mergen uses{' '}
        <span className="highlight">Platt scaling calibration</span> to convert raw heuristics into empirical probabilities
        based on your system's verdict corpus—ensuring autonomous actions run only at calibrated safety levels.
        <SlackAuditTrail />
      </>
    ),
  },
  {
    num: '02',
    icon: <IconDatabase />,
    title: 'Override-Based Policy',
    desc: (
      <>
        Every time your team overrides Mergen's recommendation, that decision becomes machine-readable policy.
        After six months: your Friday settlement windows, compliance holds, and on-call preferences form your specific
        <span className="highlight"> operational DNA—enforcing invariants before autopilot triggers.</span>
      </>
    ),
  },
  {
    num: '03',
    icon: <IconShield />,
    title: 'Agent Blunder Log (CISO Insurance)',
    desc: (
      <>
        Your audit trail for AI-driven operations and your financial insurance policy against the Agent Outage Tax.
        Mergen records every blocked action—allowlist blocks, corpus halts, planning gates, and semantic blocks—so
        <span className="highlight"> security teams can quantify prevented downtime.</span>
      </>
    ),
  },
  {
    num: '04',
    icon: <IconArchive />,
    title: 'Semantic Safety Gates',
    desc: (
      <>
        AI agents generate code in seconds but create silent risks. Mergen red-teams commands using a
        <span className="highlight"> local semantic safety engine</span>, assessing action risk, blast radius,
        and context limits instead of relying on simple string/regex allowlists.
        <IDEHint />
      </>
    ),
  },
  {
    num: '05',
    icon: <IconClock />,
    title: 'Measurable MTTR & Progress',
    desc: (
      <>
        Show the before/after in a board deck. The impact report isolates Mergen's context-assisted value,
        contrasting autonomous vs. manual MTTR and tracking developer engagement rates to demonstrate
        <span className="highlight"> organic workflow integration.</span>
      </>
    ),
  },
  {
    num: '06',
    icon: <IconServer />,
    title: 'Staged Trust Progression',
    desc: (
      <>
        De-risk automation step-by-step. Run in shadow mode for 30 days to build a track record, then gradually promote
        execution permission tiers from
        <span className="highlight"> service restarts, to rollbacks/pins, to full autonomous action.</span>
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">04 // Core Systems</span>
      <h2>
        Memory that compounds
        <br />
        with every incident.
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