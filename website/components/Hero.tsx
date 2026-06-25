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
    <div className="notion-hero-section">
      {/* Page Title */}
      <h1 className="notion-page-title">Secure Every AI Agent Action Before It Executes</h1>

      {/* Notion Page Properties Table */}
      <div className="notion-properties-panel">
        <div className="property-row">
          <span className="property-name">Status</span>
          <span className="property-value">Active Release</span>
        </div>
        {stars !== null && (
          <div className="property-row">
            <span className="property-name">GitHub Stars</span>
            <span className="property-value">
              <a
                href="https://github.com/omertt27/Mergen"
                target="_blank"
                rel="noopener noreferrer"
                className="property-link"
              >
                {formatStars(stars)} stars
              </a>
            </span>
          </div>
        )}
        <div className="property-row">
          <span className="property-name">License</span>
          <span className="property-value">Apache 2.0</span>
        </div>
        <div className="property-row">
          <span className="property-name">Command</span>
          <span className="property-value code-inline">npx mergen-server</span>
        </div>
      </div>

      {/* Notion Callout Box (Main description) */}
      <div className="notion-callout warning">
        <div className="callout-icon-container">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="callout-svg">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div className="callout-text">
          <strong>The Security Boundary:</strong> Sentry and Datadog tell you <em>after</em> an AI agent has corrupted your database or leaked credentials. Mergen is the inline Execution and Security Gateway that physically blocks hazardous agent actions before they reach your runtime, databases, or cloud infrastructure.
        </div>
      </div>

      {/* Action Buttons & Install Code */}
      <div className="notion-hero-actions-container">
        <div className="notion-actions">
          <a href="mailto:hello@mergen.dev?subject=Request%20Early%20Access" className="btn btn-notion-primary">
            Request Early Access
          </a>
          <a href="mailto:hello@mergen.dev?subject=Join%20Design%20Partner%20Program" className="btn btn-notion-secondary">
            Join Design Partner Program
          </a>
        </div>

        {/* Copy command box */}
        <div 
          className="notion-install-command-box" 
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
          <span className="terminal-prompt">$</span>
          <code>npx mergen-server</code>
          {copied ? (
            <span className="copy-ok-badge">Copied!</span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="copy-icon">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </div>
      </div>

      {/* Checklist / Features list */}
      <div className="notion-checklist">
        {[
          'Deterministic local policy gate (<1ms)',
          'Human-in-the-loop (HITL) approval gates',
          'Every blocked action logged & hash-chained',
          'Override corpus: operational DNA definition',
          'Agent safety validation CI/CD gate',
          'All execution telemetry stays on your hardware',
        ].map((b) => (
          <div key={b} className="checklist-item">
            <span className="check-box">✓</span>
            <span className="check-label">{b}</span>
          </div>
        ))}
      </div>

      {/* Database Board for Stats */}
      <div className="notion-stats-board">
        <span className="board-title">Key Metrics</span>
        <div className="board-cards">
          {heroStats.map((s) => (
            <div key={s.val} className="board-card">
              <span className="card-val">{s.val}</span>
              <span className="card-label">{s.label}</span>
              <span className="card-sub">{s.sub}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
