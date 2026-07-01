'use client'

import { useState, useEffect } from 'react'

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}



export default function Hero() {
  const [copied, setCopied] = useState(false)
  const [stars, setStars]   = useState<number | null>(null)

  useEffect(() => {
    fetch('https://api.github.com/repos/omertt27/Mergen')
      .then((r) => r.json())
      .then((d) => { if (typeof d.stargazers_count === 'number') setStars(d.stargazers_count) })
      .catch(() => {})
  }, [])

  function handleCopy() {
    navigator.clipboard.writeText('npx mergen-server')
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <section className="hero-section">
      <h1 className="hero-headline">
        Secure every AI agent action
        <br />
        <span className="hero-headline-accent">before it executes.</span>
      </h1>

      <p className="hero-sub">
        Mergen is the Agent Execution Gateway that sits between AI agents and the real world,
        enforcing deterministic policies in under 1ms.
      </p>

      <div className="hero-actions">
        <a
          href="mailto:hello@mergen.dev?subject=Request%20Early%20Access"
          className="btn-primary"
        >
          Get Early Access
        </a>
        <a
          href="https://github.com/omertt27/Mergen"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary"
        >
          {stars !== null ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.7 }}>
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              {formatStars(stars)} on GitHub
            </>
          ) : 'View on GitHub'}
        </a>
      </div>

      <div
        className="hero-install"
        onClick={handleCopy}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCopy() }}
        role="button"
        tabIndex={0}
        aria-label="Copy install command"
      >
        <span className="install-prompt">$</span>
        <code>npx mergen-server</code>
        <span className="install-copy">
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          )}
        </span>
      </div>


    </section>
  )
}
