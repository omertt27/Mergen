export default function Hero() {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        Browser · Node.js · Python · OpenTelemetry · Zero Cloud
      </span>
      <h1>Debug your full stack<br />with AI.</h1>
      <p className="hero-sub">
        Mergen connects your browser, backend services, and any OpenTelemetry-instrumented
        service into one local MCP server. Your AI IDE sees live console errors, backend spans,
        OTLP traces, and source-mapped stacks —{' '}
        <span className="highlight">all correlated end-to-end</span>.
        Snapshot debugging, dynamic logpoints, PII masking. Everything on 127.0.0.1.
      </p>
      <div className="hero-actions">
        <a
          href="https://github.com/omertt27/Mergen/blob/main/INSTALL.md"
          className="btn btn-white"
        >
          Get Started — 2 min
        </a>
        <a href="#how" className="btn btn-outline">See How It Works</a>
      </div>
      <div className="hero-badges">
        {['Chrome Extension', 'mergen-node', 'mergen-python', 'OTLP :4318', 'MCP Server', 'Snapshot Debugger', 'PII Shield', 'Devcontainers'].map((b) => (
          <span key={b} className="hero-badge">{b}</span>
        ))}
      </div>
    </section>
  )
}
