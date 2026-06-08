'use client'

export default function Hero() {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        Claude Code · Cursor · Windsurf · VS Code · MCP
      </span>
      <h1>Your AI IDE closes incidents.<br />Mergen gives it the tools.</h1>
      <p className="hero-sub">
        Add Mergen to Claude Code (or Cursor, Windsurf, VS Code) via MCP.
        When PagerDuty fires, your AI IDE calls <code>triage_incident</code> — Mergen diagnoses root cause
        from live telemetry, executes the fix at ≥85% confidence, validates the result,
        and posts the full audit trail to your Slack thread.{' '}
        <span className="highlight">No dashboards. No context switching. No 3am pages.</span>
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
        {['PagerDuty', 'Kubernetes', 'Helm', 'Slack', 'Blast Radius', 'Execution Gate', 'Auto-Rollback', 'Incident Replay', 'Adaptive Threshold', 'PII Shield'].map((b) => (
          <span key={b} className="hero-badge">{b}</span>
        ))}
      </div>
    </section>
  )
}
