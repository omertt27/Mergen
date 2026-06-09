const features = [
  {
    num: '01',
    title: 'Zero-Trust VPC Deploys',
    desc: (
      <>
        SREs are rightfully paranoid about cloud-hosted AI agents accessing production.
        Mergen runs <span className="highlight">fully locally or self-hosted in your VPC</span>.
        Sensitive source code, database credentials, and production log streams never leave your secure perimeter.
      </>
    ),
  },
  {
    num: '02',
    title: 'Credential Leak Protection',
    desc: (
      <>
        Generative coding tools routinely read and pass .env files in memory. Mergen’s{' '}
        <span className="highlight">runtime proxy interceptor</span> monitors agent tool-calls,
        sanitizing cloud secrets and API keys before they are sent to external LLMs.
      </>
    ),
  },
  {
    num: '03',
    title: 'Standardized OTel Observability',
    desc: (
      <>
        Mergen is natively instrumented with{' '}
        <span className="highlight">OpenTelemetry GenAI semantic conventions</span>.
        Track MCP tool latencies, token consumption, and agent runtimes directly inside
        your existing Datadog, Prometheus, or Grafana dashboards.
      </>
    ),
  },
  {
    num: '04',
    title: 'Hybrid Retrieval Engine',
    desc: (
      <>
        Mergen uses an offline engine combining{' '}
        <span className="highlight">SQLite FTS5 BM25 keyword matching</span> with Porter stemming
        and TF-IDF sparse vector similarity. Ensures exact-match precision on technical error codes
        and semantic understanding of symptoms.
      </>
    ),
  },
  {
    num: '05',
    title: 'Context Engineering',
    desc: (
      <>
        Stop brute-forcing context windows. Mergen retrieves only the{' '}
        <span className="highlight">most relevant 160-token cards</span> for active debugging.
        Reduces token costs, eliminates hallucinations, and provides instant grounding for sleep-deprived engineers.
      </>
    ),
  },
  {
    num: '06',
    title: 'Auto-Writeback Resolution',
    desc: (
      <>
        Once the incident is mitigated, Mergen automatically captures your{' '}
        <span className="highlight">local shell execution log</span>, correlated telemetry anomalies,
        and Slack event timelines. It auto-drafts a high-fidelity Markdown postmortem in seconds.
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
        Zero-trust security.
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
