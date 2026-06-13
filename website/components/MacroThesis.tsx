'use client'

const flaws = [
  {
    num: '01',
    title: 'Velocity Trap',
    sub: 'Spaghetti automation at scale',
    desc: 'AI agents produce syntactically perfect code that ignores systemic architecture constraints. The result is high-velocity technical debt shipped at machine speed. When code generation is free, production safety becomes the scarcest resource in the org.',
  },
  {
    num: '02',
    title: 'Destroyed Memory',
    sub: 'No one knows why it was built that way',
    desc: 'When a human spent three days on a complex routing loop, context lived in their head. When an AI generates the same block in four seconds, nobody remembers why it exists. The moment it hits production, it becomes instant, unmaintainable legacy.',
  },
  {
    num: '03',
    title: 'Incident Surge',
    sub: 'Failures that only appear under load',
    desc: 'Autonomous agents shipping code at machine speed introduce distributed failures that escape all static tests — connection pool exhaustion, timeout cascades, silent microservice regressions. These only manifest in production, at 3am.',
  },
]

export default function MacroThesis() {
  return (
    <section id="thesis">
      <span className="section-label">02 // Why Now</span>
      <h2>
        Everyone is building
        <br />
        the accelerator pedal.
      </h2>

      <p style={{ maxWidth: '680px', color: 'var(--gray-400)', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '6rem' }}>
        Every other startup is making AI write code faster. Three structural flaws of AI code generation
        are compounding in parallel — each one making the layer below the IDE more necessary.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0', border: '1px solid var(--gray-800)' }}>
        {flaws.map((f, i) => (
          <div
            key={f.num}
            style={{
              padding: '3rem',
              borderRight: i < flaws.length - 1 ? '1px solid var(--gray-800)' : 'none',
              transition: 'background 0.3s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(165,243,252,0.02)')}
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
              fontSize: '1.25rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '-0.02em',
              color: 'var(--white)',
              marginBottom: '0.5rem',
            }}>
              {f.title}
            </h3>
            <p style={{
              fontSize: '0.75rem',
              fontFamily: 'var(--font-geist-mono), monospace',
              color: 'var(--accent-text)',
              marginBottom: '1.5rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
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
        marginTop: '4rem',
        padding: '3rem',
        border: '1px solid var(--gray-800)',
        borderTop: '1px solid var(--accent)',
        background: 'rgba(165,243,252,0.02)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '4rem',
      }}>
        <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--white)', lineHeight: 1.4, maxWidth: '600px' }}>
          Mergen is the brakes, the steering wheel, and the black-box flight recorder. It scales directly
          in proportion to the failures of AI-generated code.
        </p>
        <a href="mailto:hello@mergen.dev" className="btn btn-white" style={{ flexShrink: 0 }}>
          Talk to us
        </a>
      </div>
    </section>
  )
}
