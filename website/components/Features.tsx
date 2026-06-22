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

const IconGitCommit = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <line x1="3" y1="12" x2="9" y2="12"/>
    <line x1="15" y1="12" x2="21" y2="12"/>
  </svg>
)

const IconEye = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
)

const SlackAuditTrail = () => (
  <div style={{
    marginTop: '2rem',
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    padding: '1.25rem',
    fontSize: '0.8rem',
    color: '#1d1c1d',
    boxShadow: '0 10px 30px rgba(0,0,0,0.03)',
  }}>
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div style={{ width: '36px', height: '36px', background: 'var(--accent)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: '0.6rem' }}>MRG</div>
      <div>
        <div style={{ fontWeight: 900, marginBottom: '4px', color: '#1d1c1d' }}>Mergen <span style={{ fontWeight: 400, fontSize: '0.7rem', color: '#64748b', marginLeft: '6px' }}>APP 3:17 PM</span></div>
        <div style={{ marginBottom: '8px', color: '#1d1c1d' }}>✅ <b>Incident #402 resolved autonomously</b></div>
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '12px', borderLeft: '4px solid var(--accent)' }}>
          <div style={{ color: '#64748b', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', fontWeight: 700 }}>Audit Trail Summary</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: '#334155' }}>
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
    background: '#ffffff',
    border: '1px solid var(--gray-800)',
    borderRadius: '6px',
    padding: '0',
    overflow: 'hidden',
    boxShadow: '0 10px 30px rgba(0,0,0,0.03)',
  }}>
    <div style={{ background: '#f8fafc', padding: '8px 12px', fontSize: '0.65rem', color: '#64748b', borderBottom: '1px solid var(--gray-800)', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
      <span>auth_middleware.ts — Mergen Context</span>
      <span>mcp.json</span>
    </div>
    <div style={{ padding: '12px', fontFamily: 'var(--font-geist-mono), monospace', fontSize: '0.72rem', color: '#24292f' }}>
      <div style={{ color: '#8e8e93' }}>// Mergen: Historical Context found</div>
      <div style={{ color: '#ea580c', background: 'rgba(234, 88, 12, 0.04)', padding: '6px 10px', margin: '8px 0', borderLeft: '2px solid #ea580c', borderRadius: '2px', lineHeight: 1.5 }}>
        ⚠️ This file was modified in <b>Incident #388</b> (OOM Kill).
        <br/>Reason: Recursive token validation on nested JWTs.
        <br/>Constraint: Do not increase stack depth &gt; 4.
      </div>
      <div style={{ opacity: 0.6 }}>
        <span style={{ color: '#0550ae' }}>export const</span> <span style={{ color: '#8250df' }}>validateToken</span> = (token: <span style={{ color: '#953800' }}>string</span>) =&gt; &#123;
        <br/>&nbsp;&nbsp;<span style={{ color: '#8e8e93' }}>// checking depth...</span>
      </div>
    </div>
  </div>
)

const features = [
  {
    num: '01',
    icon: <IconDatabase />,
    title: 'Override Corpus — Infrastructure DNA',
    desc: (
      <>
        Every human override becomes machine-readable policy. After six months: your Friday settlement windows,
        compliance holds, and on-call preferences form your specific
        <span className="highlight"> operational DNA — enforcing invariants before any autonomous action triggers.</span>
        {' '}The algorithm is reproducible. This corpus is not.
      </>
    ),
  },
  {
    num: '02',
    icon: <IconLoop />,
    title: 'Per-Environment Calibration',
    desc: (
      <>
        Mergen uses <span className="highlight">Platt scaling</span> calibrated to your specific infrastructure —
        not a global benchmark. As your team tags diagnoses (correct / partial / wrong), the confidence model
        updates. After 20–50 incidents, accuracy numbers reflect your systems, not ours.
        <SlackAuditTrail />
      </>
    ),
  },
  {
    num: '03',
    icon: <IconShield />,
    title: 'Agent Blunder Log — CISO Insurance',
    desc: (
      <>
        Every blocked autonomous action is recorded: allowlist blocks, corpus halts, planning gates, semantic blocks.
        The total prevented count is the board-deck answer to{' '}
        <span className="highlight">"why would you trust an AI agent with production?"</span>
        {' '}Wired automatically — no setup required.
      </>
    ),
  },
  {
    num: '04',
    icon: <IconArchive />,
    title: 'Semantic Safety Gates',
    desc: (
      <>
        Before any autonomous execution, Mergen red-teams the proposed command using a
        <span className="highlight"> local semantic safety engine</span>: action risk, blast radius,
        and corpus-policy check — not regex allowlists.
        <IDEHint />
      </>
    ),
  },
  {
    num: '05',
    icon: <IconClock />,
    title: 'Measurable MTTR — Board-Ready ROI',
    desc: (
      <>
        The impact report isolates Mergen's context-assisted value:
        autonomous vs. manual MTTR, resolution rate, and time saved.
        <span className="highlight"> "We saved 47 engineer-hours last month"</span>
        {' '}is a sentence. The report generates it automatically.
      </>
    ),
  },
  {
    num: '06',
    icon: <IconServer />,
    title: 'Shadow Mode — 30-Day Trust Track Record',
    desc: (
      <>
        Before autonomous execution, Mergen runs in shadow mode: diagnoses every incident, records what it would have done,
        and lets your team annotate verdicts.
        <span className="highlight"> The shadow report is your CISO's 30-day evidence package</span>
        {' '}before you flip the autopilot switch.
      </>
    ),
  },
  {
    num: '07',
    icon: <IconGitCommit />,
    title: 'Pre-commit Incident Guard',
    desc: (
      <>
        Before you ship, Mergen cross-references every staged file against your incident history.{' '}
        <span className="highlight">"This file was in 3 incidents last month"</span>
        {' '}— the question a code reviewer would ask, encoded as a git hook. The corpus working before the incident happens.
      </>
    ),
  },
  {
    num: '08',
    icon: <IconEye />,
    title: 'Passive Status Surface',
    desc: (
      <>
        Mergen tracks what happened while you weren't looking.{' '}
        <span className="highlight">Next time you check: "this started failing 6 hours ago."</span>
        {' '}Not a push notification — context waiting when you return. The on-call teammate who works in silence.
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">04 // Core Systems</span>
      <h2>
        Knowledge that compounds.
        <br />
        Safety that enforces it.
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