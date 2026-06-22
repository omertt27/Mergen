'use client'

import { useState, useEffect } from 'react'

const heroStats = [
  { val: '94%',    label: 'Root cause accuracy',    sub: '33-incident eval corpus' },
  { val: '31/33',  label: 'Correct classifications', sub: '2 known false positives' },
  { val: '< 60s',  label: 'Time to first insight',   sub: 'zero config required' },
  { val: '≥85%',   label: 'Calibrated Gate',         sub: 'Platt-scaled safety threshold' },
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
      <span className="hero-eyebrow">
        ⚡️ Operational intelligence for AI-native engineering teams
      </span>
      <h1>AI agents don't know how your systems <span className="font-serif">actually</span> work.</h1>
      <p className="hero-sub">
        Mergen gives AI agents and engineers the operational context, historical decisions, and infrastructure memory
        needed to make safer changes. Every incident, override, and postmortem compounds into
        <b className="highlight-yellow"> queryable policy</b> — specific to your systems, impossible to replicate from a standing start.
      </p>
      <div className="hero-actions">
        <a href="/install" className="btn btn-white">See it in 60 seconds 🚀</a>
        <a href="https://github.com/omertt27/Mergen" target="_blank" rel="noopener noreferrer" className="btn btn-outline" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.815 1.102.815 2.222 0 1.606-.015 2.896-.015 3.286 0 .322.218.694.825.576C20.565 21.795 24 17.298 24 12c0-6.627-5.373-12-12-12z"/></svg>
          Star {stars !== null && <span style={{ opacity: 0.6, fontSize: '0.9em' }}>{formatStars(stars)}</span>}
        </a>
        <div className="hero-command" onClick={handleCopyInstall} role="button" tabIndex={0}>
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
          'Knowledge compounds with every incident',
          'Override corpus: your infrastructure DNA',
          'Pre-commit incident guard',
          'Platt-calibrated per-environment confidence',
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