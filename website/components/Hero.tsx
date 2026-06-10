'use client'

export default function Hero() {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        Datadog · PagerDuty · Claude Code · Cursor · MCP
      </span>
      <h1>Infrastructure Intelligence<br />for AI Agents.</h1>
      <p className="hero-sub">
        Mergen is the <b>AI Agent Infrastructure Layer</b>. We compress raw Datadog traces into high-signal "Runtime Facts," feeding live production context into Claude Code and Cursor to resolve incidents in minutes, not hours.
      </p>
      <div className="hero-actions">
        <div className="hero-command" onClick={() => navigator.clipboard.writeText('npx mergen-server@latest setup')}>
          <code>npx mergen-server@latest setup</code>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </div>
      </div>
      <div className="hero-badges">
        {['Datadog-native', 'Semantic Compactor', 'PagerDuty Trigger', 'MCP-native stdio'].map((b) => (
          <span key={b} className="hero-badge">✓ {b}</span>
        ))}
      </div>
    </section>
  )
}
