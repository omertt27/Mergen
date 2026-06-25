'use client'

import { useState, useEffect } from 'react'

const heroStats = [
  { val: '< 1ms',  label: 'Gate evaluation latency',  sub: 'deterministic, zero network I/O' },
  { val: '94%',    label: 'Threat block rate',        sub: '33-threat validation harness' },
  { val: '99.9%',  label: 'Gate reliability',         sub: 'strict deterministic policy match' },
  { val: '100%',   label: 'Local execution',           sub: 'no cloud credentials exposed' },
]

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export default function Hero() {
  const [copied, setCopied] = useState(false)
  const [stars, setStars] = useState<number | null>(null)

  useEffect(() => {
    fetch('https://api.github.com/repos/omertt27/Mergen')
      .then((r) => r.json())
      .then((d) => { if (typeof d.stargazers_count === 'number') setStars(d.stargazers_count) })
      .catch(() => {})
  }, [])

  function handleCopyInstall() {
    navigator.clipboard.writeText('npx mergen-server')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="hero">
      <span className="hero-eyebrow" style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <span>⚡️ The first Agent Execution Governance (AEG) platform</span>
        {stars !== null && (
          <a
            href="https://github.com/omertt27/Mergen"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '2px 8px',
              borderRadius: '100px',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: 'var(--white)',
              textTransform: 'none',
              letterSpacing: 'normal',
              fontSize: '0.65rem',
              fontWeight: 500,
              verticalAlign: 'middle',
              transition: 'all 0.2s',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--accent-text)' }}>
              <path d="M12 .587l3.668 7.431 8.2 1.192-5.934 5.787 1.4 8.168L12 18.896l-7.334 3.87 1.4-8.168L.132 9.21l8.2-1.192z" />
            </svg>
            <span>Star {formatStars(stars)}</span>
          </a>
        )}
      </span>
      <h1>Secure Every AI Agent Action Before It Executes</h1>
      <p className="hero-sub">
        Sentry and Datadog tell you after an AI agent has corrupted your database or leaked credentials. Mergen is the inline Execution and Security Gateway that physically blocks hazardous agent actions before they reach your runtime, databases, or cloud infrastructure.
      </p>
      <div className="hero-actions">
        <a href="mailto:hello@mergen.dev?subject=Request%20Early%20Access" className="btn btn-white">Request Early Access</a>
        <a href="mailto:hello@mergen.dev?subject=Join%20Design%20Partner%20Program" className="btn btn-outline">Join Design Partner Program</a>
        <div 
          className="hero-command" 
          onClick={handleCopyInstall} 
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              handleCopyInstall();
              e.preventDefault();
            }
          }}
          role="button" 
          tabIndex={0}
        >
          <code>npx mergen-server</code>
          {copied ? (
            <span className="hero-copy-ok">Copied!</span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </div>
      </div>
      <div className="hero-badges">
        {[
          'Deterministic local policy gate',
          'Human-in-the-loop (HITL) approval',
          'Every blocked action logged & hash-chained',
          'Override corpus: your infrastructure DNA',
          'Agent safety CI gate',
          'All data on your infrastructure',
        ].map((b) => (
          <span key={b} className="hero-badge">✓ {b}</span>
        ))}
      </div>
      <div className="hero-stats">
        {heroStats.map((s) => (
          <div key={s.val} className="hero-stat">
            <span className="hero-stat-val">{s.val}</span>
            <span className="hero-stat-label">{s.label}</span>
            <span className="hero-stat-sub">{s.sub}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
