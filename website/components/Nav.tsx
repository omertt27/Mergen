'use client'

import { useState, useEffect } from 'react'

const navLinks = [
  { href: '/#how',          label: 'How It Works' },
  { href: '/#why',          label: 'Capabilities' },
  { href: '/#sandbox',      label: 'Sandbox' },
  { href: '/#access',       label: 'Pricing' },
  { href: '/guide',         label: 'Guide' },
  { href: 'https://github.com/omertt27/Mergen', label: 'GitHub', external: true },
]

export default function Nav() {
  const [active, setActive]     = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

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

  return (
    <nav>
      <div className="wrap">
        <div className="nav-inner">
          <a href="/" className="logo">⚡ Mergen</a>

          <ul className="nav-links">
            {navLinks.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  className={(active === l.href || (active && l.href.endsWith(active))) ? 'nav-active' : undefined}
                  {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>

          <a href="/install" className="btn btn-white nav-cta">Start Free →</a>

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
              </a>
            ))}
            <a
              href="/install"
              className="btn btn-white"
              style={{ marginTop: '1rem', display: 'block', textAlign: 'center' }}
              onClick={() => setMenuOpen(false)}
            >
              Start Free →
            </a>
          </div>
        </div>
      )}
    </nav>
  )
}