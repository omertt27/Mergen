'use client'

import { useState, useEffect } from 'react'

const navLinks = [
  { href: '#how',          label: 'How It Works' },
  { href: '#why',          label: 'Capabilities' },
  { href: '#integrations', label: 'Integrations' },
  { href: '#guide',        label: 'Guide' },
  { href: '#access',       label: 'Pricing' },
  { href: '/install',      label: 'Install' },
  { href: 'https://github.com/omertt27/Mergen', label: 'GitHub', external: true },
]

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export default function Nav() {
  const [active, setActive]     = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [stars, setStars]       = useState<number | null>(null)

  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>('section[id]')
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(`#${entry.target.id}`)
        })
      },
      { rootMargin: '-20% 0px -60% 0px' },
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    fetch('https://api.github.com/repos/omertt27/Mergen')
      .then((r) => r.json())
      .then((d) => { if (typeof d.stargazers_count === 'number') setStars(d.stargazers_count) })
      .catch(() => {})
  }, [])

  return (
    <nav>
      <div className="wrap">
        <div className="nav-inner">
          <a href="/" className="logo">Mergen</a>

          <ul className="nav-links">
            {navLinks.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className={active === l.href ? 'nav-active' : undefined}
                  {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {l.label}
                  {l.external && stars !== null && (
                    <span className="nav-stars">★ {formatStars(stars)}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>

          <a href="/install" className="btn btn-white nav-cta">Get Started</a>

          <button
            className={`nav-hamburger${menuOpen ? ' open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <span /><span /><span />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="nav-mobile-menu">
          <div className="wrap">
            {navLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="nav-mobile-link"
                onClick={() => setMenuOpen(false)}
                {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {l.label}
                {l.external && stars !== null && ` ★ ${formatStars(stars)}`}
              </a>
            ))}
            <a
              href="/install"
              className="btn btn-white"
              style={{ marginTop: '1rem', display: 'block', textAlign: 'center' }}
              onClick={() => setMenuOpen(false)}
            >
              Get Started
            </a>
          </div>
        </div>
      )}
    </nav>
  )
}