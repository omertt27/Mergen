const features = [
  {
    num: '01.01',
    title: 'Deterministic Joins',
    desc: (
      <>
        Extracts standard <span className="highlight">W3C traceparent headers</span> from raw
        logs to match OpenTelemetry-compliant backend service layers with 100% certainty. No
        inference, just ground truth.
      </>
    ),
  },
  {
    num: '01.02',
    title: 'Source-Mapped Context',
    desc: (
      <>
        Automatically resolves production stack traces back to original{' '}
        <span className="highlight">TypeScript source files</span> using local source-map
        decoupling. Your AI reads the code you actually wrote.
      </>
    ),
  },
  {
    num: '01.03',
    title: 'Zero-Config SDK',
    desc: (
      <>
        Attach to any Node, Python, or Go process via a simple <code>--require</code> proxy.
        Instrument massive repositories without writing a single line of boilerplate code.
      </>
    ),
  },
  {
    num: '01.04',
    title: 'Local Sovereignty',
    desc: (
      <>
        All telemetry stays on your loopback. <span className="highlight">127.0.0.1</span> is
        the only destination. Absolute data protection for enterprise PII and environmental
        variables.
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="how">
      <span className="section-label">01 // The Thesis</span>
      <h2>
        Observability for machines,
        <br />
        not human dashboards.
      </h2>
      <div className="feature-grid">
        {features.map((f) => (
          <div key={f.num} className="feature-card">
            <span className="feature-num">{f.num}</span>
            <h3 className="feature-title">{f.title}</h3>
            <p className="feature-desc">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
