'use client'

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
        <div className="hero-command" onClick={() => navigator.clipboard.writeText('npx mergen-setup')}>
          <code>npx mergen-setup</code>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </div>
      </div>
      <div className="hero-badges">
        {['Chrome Extension', 'mergen-node', 'mergen-python', 'OTLP :4318', 'MCP Server', 'Snapshot Debugger', 'PII Shield', 'Devcontainers'].map((b) => (
          <span key={b} className="hero-badge">{b}</span>
        ))}
      </div>
    </section>
  )
}
