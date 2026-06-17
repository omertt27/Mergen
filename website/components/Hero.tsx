'use client'

import { useState } from 'react'

const heroStats = [
  { val: '94%',   label: 'Root cause accuracy',    sub: '33-incident eval corpus' },
  { val: '31/33', label: 'Correct classifications', sub: '2 known false positives' },
  { val: '10/10', label: 'Infra failure classes',   sub: 'detected at 100%' },
  { val: '≥85%',  label: 'Confidence gate',         sub: 'before any autonomous action' },
]

export default function Hero() {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText('npx mergen-server@latest setup')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="hero">
      <span className="hero-eyebrow">
        System Understanding Infrastructure · AI-Native Operations
      </span>
      <h1>Operational Memory<br />for AI Agents.</h1>
      <p className="hero-sub">
        AI made writing code free. The bottleneck is now what happens after it ships —
        connection pools nobody documented, compliance windows your on-call forgot, cascading failures at 3am.
        Mergen is the <b>operational memory and safety layer</b>: it compresses raw production telemetry
        into structured machine context and encodes your team's override decisions as enforceable policy
        that compounds with every incident you resolve.
      </p>
      <div className="hero-actions">
        <a href="/install" className="btn btn-white">Get Started →</a>
        <div className="hero-command" onClick={handleCopy} role="button" tabIndex={0}>
          <code>npx mergen-server@latest setup</code>
          {copied ? (
            <span className="hero-copy-ok">Copied!</span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
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