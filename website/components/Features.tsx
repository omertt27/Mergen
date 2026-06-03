const features = [
  {
    num: '01',
    title: 'Snapshot Debugging',
    desc: (
      <>
        Set a breakpoint condition. When it fires, Mergen captures the complete state in{' '}
        <span className="highlight">under 10ms</span> — last 20 console events, 10 network events,
        localStorage, and component tree. Download the bundle and replay offline in your IDE.
        No live debugger, no paused threads.
      </>
    ),
  },
  {
    num: '02',
    title: 'Dynamic Logpoints',
    desc: (
      <>
        Inject ad-hoc console statements into any running page via MCP —{' '}
        <span className="highlight">no restart, no redeployment</span>. Attach to any DOM element,
        fire on any event, evaluate any JS expression. Results stream back within seconds as
        standard console events.
      </>
    ),
  },
  {
    num: '03',
    title: 'OTLP Native',
    desc: (
      <>
        Point any OpenTelemetry SDK at{' '}
        <span className="highlight">localhost:4318</span> and Mergen ingests spans and logs
        automatically. Go, Java, Ruby, .NET — any language, zero Mergen-specific code.
        Server spans become backend_span events; logs become console events.
      </>
    ),
  },
  {
    num: '04',
    title: 'Deterministic Trace Joins',
    desc: (
      <>
        W3C traceparent links every browser fetch to its exact backend span with{' '}
        <span className="highlight">100% certainty</span>. Your AI calls{' '}
        <code>get_correlated_trace</code> and sees the full round-trip: browser request →
        server route → log lines — no inference, no guessing.
      </>
    ),
  },
  {
    num: '05',
    title: 'PII Shield',
    desc: (
      <>
        Client-side entity detection scans events for JWTs, API keys, emails, and secrets before
        they reach the ring buffer. The popup shows{' '}
        <span className="highlight">per-entity toggle overrides</span> — you decide what gets
        masked. The translation table lives in-memory only, never written to disk.
      </>
    ),
  },
  {
    num: '06',
    title: 'Local Sovereignty',
    desc: (
      <>
        Every byte stays on <span className="highlight">127.0.0.1</span>. No cloud backend, no
        accounts, no data leaving your machine. Devcontainer templates include an attachable
        Traefik proxy so teams can mirror production routing locally — zero port conflicts.
      </>
    ),
  },
]

export default function Features() {
  return (
    <section id="why">
      <span className="section-label">02 // Capabilities</span>
      <h2>
        Enterprise-grade.
        <br />
        Zero config.
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
