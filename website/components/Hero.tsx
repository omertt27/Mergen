'use client'

import { useState, useEffect } from 'react'

const heroStats = [
  { val: '< 1ms',  label: 'Gate evaluation latency',  sub: 'deterministic, zero network I/O' },
  { val: '94%',    label: 'Root cause accuracy',       sub: '33-incident eval corpus' },
  { val: '≥85%',   label: 'Planning gate threshold',   sub: 'Platt-scaled per environment' },
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
      <span className="hero-eyebrow">
        ⚡️ Agent Security &amp; Governance for AI-native engineering teams
      </span>
      <h1>Secure Every AI Agent Action Before It Executes</h1>
      <p className="hero-sub">
        Mergen sits inline between AI agents and your systems, blocking unsafe actions, enforcing approval workflows, and creating auditable execution trails across development and production environments.
      </p>
      <div className="hero-actions">
        <a href="mailto:hello@mergen.dev?subject=Request%20Early%20Access" className="btn btn-white">Request Early Access</a>
        <a href="mailto:hello@mergen.dev?subject=Join%20Design%20Partner%20Program" className="btn btn-outline">Join Design Partner Program</a>
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
