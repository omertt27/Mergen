'use client'

import { useState, useEffect } from 'react'

const navLinks = [
  { href: '#how',           label: 'How it Works' },
  { href: '#why',           label: 'Features' },
  { href: '/sandbox',       label: 'Sandbox' },
  { href: '#access',        label: 'Pricing' },
  { href: '/architecture',  label: 'Architecture' },
  { href: '/guide',         label: 'Docs' },
]

export default function Nav() {
  const [scrolled, setScrolled]     = useState(false)
  const [theme, setTheme]           = useState<'light' | 'dark'>('light')
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const storedTheme = localStorage.getItem('mergen-theme') as 'light' | 'dark'
    const prefersDark  = window.matchMedia('(prefers-color-scheme: dark)').matches
    const initial      = storedTheme ?? (prefersDark ? 'dark' : 'light')
    applyTheme(initial)
    setTheme(initial)

    const onScroll = () => setScrolled(window.scrollY > 8)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  function applyTheme(t: 'light' | 'dark') {
    document.documentElement.classList.remove('notion-light', 'notion-dark')
    document.documentElement.classList.add(`notion-${t}`)
  }

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    localStorage.setItem('mergen-theme', next)
    applyTheme(next)
  }

  function handleNavClick(href: string) {
    setMobileOpen(false)
    if (href.startsWith('#')) {
      const el = document.getElementById(href.slice(1))
      el?.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <>
      <header className={`site-nav${scrolled ? ' scrolled' : ''}`}>
        <div className="nav-inner">
          <a href="/" className="nav-logo">
            <span className="nav-logo-text">Mergen</span>
          </a>

          <nav className="nav-links" aria-label="Primary navigation">
            {navLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="nav-link"
                onClick={(e) => {
                  if (l.href.startsWith('#')) {
                    e.preventDefault()
                    handleNavClick(l.href)
                  }
                }}
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="nav-actions">
            <a
              href="https://github.com/omertt27/Mergen"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-github"
              aria-label="GitHub"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
              </svg>
              <span>GitHub</span>
            </a>

            <button
              className="nav-theme-btn"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === 'light' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              )}
            </button>

            <a
              href="mailto:hello@mergen.dev?subject=Request%20Early%20Access"
              className="nav-cta"
            >
              Get Early Access
            </a>

            <button
              className="nav-mobile-btn"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label="Toggle menu"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="6" x2="21" y2="6"/>
                  <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {mobileOpen && (
        <div className="nav-mobile-menu">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="mobile-nav-link"
              onClick={(e) => {
                if (l.href.startsWith('#')) {
                  e.preventDefault()
                  handleNavClick(l.href)
                }
              }}
            >
              {l.label}
            </a>
          ))}
          <a
            href="mailto:hello@mergen.dev?subject=Request%20Early%20Access"
            className="mobile-nav-cta"
          >
            Get Early Access
          </a>
        </div>
      )}
    </>
  )
}
