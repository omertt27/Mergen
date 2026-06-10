const features = [
  {
    num: '01',
    title: 'Semantic Compactor',
    desc: (
      <>
        Raw Datadog traces are too large and noisy for LLMs. Our <span className="highlight">4-stage compaction pipeline</span> strips the noise, compressing 500KB traces into 1KB "Runtime Facts" that agents can actually use.
      </>
    ),
  },
  {
    num: '02',
    title: 'Incident-State Awareness',
    desc: (
      <>
        Mergen tracks active incidents in real-time. By connecting to <span className="highlight">PagerDuty webhooks</span>, we automatically fetch relevant observability context the moment an alert fires, grounding your agent instantly.
      </>
    ),
  },
  {
    num: '03',
    title: 'Context Routing Layer',
    desc: (
      <>
        We sit above your observability stack as a <span className="highlight">dedicated context-routing layer</span>. Mergen ensures your AI assistant always has the right data—from traces to logs to topology—without overwhelming its context window.
      </>
    ),
  },
  {
    num: '04',
    title: 'Datadog-Native Integration',
    desc: (
      <>
        Deeply integrated with <span className="highlight">Datadog APM and Logs</span>. Mergen maps production stack frames to local source code and correlates spans with log events to give your AI a complete picture of the failure.
      </>
    ),
  },
  {
    num: '05',
    title: 'Reduced MTTR for 2 AM',
    desc: (
      <>
        Designed for the <span className="highlight">sleep-deprived on-call engineer</span>. Mergen + Claude Code can resolve complex production incidents in under 5 minutes, replacing 45 minutes of manual dashboard jumping.
      </>
    ),
  },
  {
    num: '06',
    title: 'Local-First Proxy',
    desc: (
      <>
        Run Mergen <span className="highlight">locally or self-hosted in your VPC</span>. No sensitive Datadog API keys or production data ever leave your infrastructure. Zero-trust by design, enterprise-ready from day one.
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">02 // Capabilities</span>
      <h2>
        AI-Native Infrastructure.
        <br />
        Built for the On-Call.
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
