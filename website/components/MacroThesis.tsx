'use client'

const problems = [
  {
    num: '01',
    title: 'Context is lost at deploy time',
    sub: 'Engineers reconstruct from scratch under pressure',
    desc: 'When a human spent three days on a complex fix, the context lived in their head. When incidents happen now, engineers grep logs, jump dashboards, and ask Slack — rebuilding understanding under pressure, at 3am.',
  },
  {
    num: '02',
    title: 'Knowledge is trapped in people',
    sub: 'Slack threads and individual memory don\'t scale',
    desc: 'Past incidents live in individual engineers, old Slack threads, and runbooks nobody updates. When the person who fixed it last time is on holiday, the team starts from zero. Every repeat incident is a failure of memory, not a failure of engineering.',
  },
  {
    num: '03',
    title: 'AI-generated code ships silent risk',
    sub: 'Fast code, slow understanding',
    desc: 'AI coding tools generate production logic in seconds. Nobody documented it. Nobody knows the failure modes. Connection pool exhaustion, timeout cascades, silent regressions — these only manifest in production, and only the system that watched them happen can explain them.',
  },
]

export default function MacroThesis() {
  return (
    <section id="thesis">
      <span className="section-label">02 // The Problem</span>
      <h2>
        AI increased deployment speed.
        <br />
        Production systems didn't get safer.
      </h2>

      <p style={{ maxWidth: '680px', color: 'var(--gray-400)', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '6rem' }}>
        Modern teams ship code faster than ever. But operational understanding is still human —
        reconstructed from scratch every time something breaks.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0', border: '1px solid var(--gray-800)' }}>
        {problems.map((f, i) => (
          <div
            key={f.num}
            style={{
              padding: '3rem',
              borderRight: i < problems.length - 1 ? '1px solid var(--gray-800)' : 'none',
              transition: 'background 0.3s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,85,0,0.02)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{
              fontFamily: 'var(--font-geist-mono), monospace',
              fontSize: '0.65rem',
              color: 'var(--accent-text)',
              letterSpacing: '0.1em',
              display: 'block',
              marginBottom: '1.5rem',
            }}>
              {f.num}
            </span>
            <h3 style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--white)',
              marginBottom: '0.5rem',
              lineHeight: 1.3,
            }}>
              {f.title}
            </h3>
            <p style={{
              fontSize: '0.75rem',
              fontFamily: 'var(--font-geist-mono), monospace',
              color: 'var(--accent-text)',
              marginBottom: '1.5rem',
              letterSpacing: '0.03em',
            }}>
              {f.sub}
            </p>
            <p style={{ color: 'var(--gray-400)', fontSize: '0.95rem', lineHeight: 1.7 }}>
              {f.desc}
            </p>
          </div>
        ))}
      </div>

      <div style={{
        border: '1px solid var(--gray-800)',
        borderTop: 'none',
        borderLeft: '4px solid var(--accent)',
        background: 'rgba(255, 85, 0, 0.02)',
        display: 'grid',
        gridTemplateColumns: '1fr 2fr',
        gap: '4rem',
        alignItems: 'flex-start',
        padding: '3rem',
      }}>
        <div>
          <span style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: '0.65rem',
            color: 'var(--accent-text)',
            letterSpacing: '0.1em',
            display: 'block',
            marginBottom: '1.5rem',
          }}>
            04
          </span>
          <h3 style={{
            fontSize: '1.1rem',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--white)',
            marginBottom: '0.5rem',
            lineHeight: 1.3,
          }}>
            Solo devs have no reviewer
          </h3>
          <p style={{
            fontSize: '0.75rem',
            fontFamily: 'var(--font-geist-mono), monospace',
            color: 'var(--accent-text)',
            letterSpacing: '0.03em',
          }}>
            Nothing between "I wrote this" and "it's in production"
          </p>
        </div>
        <p style={{ color: 'var(--gray-400)', fontSize: '0.95rem', lineHeight: 1.7, paddingTop: '2.5rem' }}>
          A team has code review as a safety net — someone else reads the change before it merges. A solo dev has nothing. Mergen's guard cross-references every commit against your incident history,
          asking the question your missing teammate would: <em style={{ color: 'var(--gray-300)' }}>"didn't this file cause the outage last month?"</em> Not a lint check. Encoded institutional memory at commit time.
        </p>
      </div>

      <div style={{
        marginTop: '4rem',
        padding: '3rem',
        border: '1px solid var(--gray-800)',
        borderTop: '1px solid var(--accent)',
        background: 'rgba(255,85,0,0.03)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '4rem',
      }}>
        <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--white)', lineHeight: 1.4, maxWidth: '600px' }}>
          The missing layer is not more code.
          It is operational memory — so the engineer who built it, the agent who touched it, and the solo dev who shipped it at midnight all see the same constraints before they act.
        </p>
        <a href="mailto:hello@mergen.dev" className="btn btn-white" style={{ flexShrink: 0 }}>
          Talk to us
        </a>
      </div>
    </section>
  )
}
