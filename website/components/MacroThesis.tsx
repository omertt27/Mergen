'use client'

const problems = [
  {
    num: '01',
    title: 'Knowledge evaporates after every incident',
    sub: 'Wikis rot. Slack threads become noise. People leave.',
    desc: 'When the incident is over, the hard-won understanding — why it happened, what constraint matters, what not to do next time — evaporates into heads, stale runbooks, and Slack threads nobody reads under pressure. Every repeat incident is a failure of memory, not engineering.',
  },
  {
    num: '02',
    title: 'AI velocity without memory is sabotage',
    sub: 'Agents generate code. They have no institutional knowledge.',
    desc: 'AI coding agents clear backlogs fast and introduce production failures faster. They have no context about your Friday settlement window, your compliance hold, or the connection pool that exhausted twice last quarter. Without an operational memory layer, every agent change is a blind change.',
  },
  {
    num: '03',
    title: 'Observability tells you what broke — not what to do',
    sub: 'Datadog has the logs. The understanding still lives in one engineer.',
    desc: 'PagerDuty pages a human. Datadog shows the trace. The human reconstructs the context — from memory, from a Slack thread, from the last person who touched that service. When they leave, the knowledge leaves. Mergen is the layer that keeps it.',
  },
]

export default function MacroThesis() {
  return (
    <section id="thesis">
      <span className="section-label">02 // The Problem</span>
      <h2>
        Teams ship code faster.
        <br />
        Operational knowledge still evaporates.
      </h2>

      <p style={{ maxWidth: '680px', color: 'var(--gray-400)', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '6rem' }}>
        Every incident teaches your team something. The diagnosis, the override, the constraint that
        mattered — evaporates into heads, stale runbooks, Slack threads nobody reads under pressure.
        AI agents make this worse: they generate changes with no institutional memory at all.
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
          The missing layer is not more observability.
          It is operational intelligence — converting every incident, override, and postmortem into compounding machine-readable policy that engineers and AI agents can query before they act.
        </p>
        <a href="mailto:hello@mergen.dev" className="btn btn-white" style={{ flexShrink: 0 }}>
          Talk to us
        </a>
      </div>
    </section>
  )
}
