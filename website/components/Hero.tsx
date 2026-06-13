'use client'

export default function Hero() {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        PagerDuty · OpenTelemetry · Docker · Claude Code · Cursor · MCP
      </span>
      <h1>Operational Memory<br />for AI Agents.</h1>
      <p className="hero-sub">
        AI coding agents have made writing code free. The bottleneck is what happens after it ships.
        Mergen is the <b>operational memory and safety layer</b> — compressing raw production telemetry
        into structured machine context, encoding your team's override decisions as enforceable policy,
        and giving autonomous agents the production facts they need to act safely.
      </p>
      <div className="hero-actions">
        <div className="hero-command" onClick={() => navigator.clipboard.writeText('npx mergen-server@latest setup')}>
          <code>npx mergen-server@latest setup</code>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </div>
        <a href="mailto:hello@mergen.dev" className="btn btn-outline">Talk to us</a>
      </div>
      <div className="hero-badges">
        {[
          'Override Corpus',
          'Agent Blunder Log',
          'No Datadog Required',
          'MCP-native stdio',
          'Local-first · VPC-ready',
          '≥85% confidence gate',
        ].map((b) => (
          <span key={b} className="hero-badge">✓ {b}</span>
        ))}
      </div>
    </section>
  )
}
