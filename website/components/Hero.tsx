'use client'

export default function Hero() {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        PagerDuty · Kubernetes · Helm · Slack · Zero Cloud
      </span>
      <h1>Incidents resolved<br />before you wake up.</h1>
      <p className="hero-sub">
        Mergen is an autonomous ops layer that receives your PagerDuty alerts, diagnoses root cause
        from live telemetry, evaluates blast radius, and executes fixes at ≥85% confidence —{' '}
        <span className="highlight">all without human intervention</span>.
        When a fix is too risky to run automatically, it posts a structured Slack approval request
        and waits. Every action is validated; regressions are rolled back instantly.
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
