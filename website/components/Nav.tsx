'use client'

import { useState, useEffect } from 'react'

const navLinks = [
  { href: '#how',          label: 'The Difference' },
  { href: '#arch',         label: 'Architecture Flow' },
  { href: '#eval',         label: 'Evaluation Harness' },
  { href: '#thesis',       label: 'Macro Thesis' },
  { href: '#why',          label: 'Core Features' },
  { href: '#sandbox',      label: 'Interactive Sandbox' },
  { href: '#integrations', label: 'Platform Integrations' },
  { href: '#guide',        label: 'Quick Start Guide' },
  { href: '#access',       label: 'Pricing & License' },
]

export default function Nav() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeHash, setActiveHash] = useState('')

  // Sync initial theme and sidebar state
  useEffect(() => {
    // Theme
    const storedTheme = localStorage.getItem('mergen-theme') as 'light' | 'dark'
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const initialTheme = storedTheme || (systemPrefersDark ? 'dark' : 'light')
    setTheme(initialTheme)
    document.documentElement.classList.remove('notion-light', 'notion-dark')
    document.documentElement.classList.add(`notion-${initialTheme}`)

    // Sidebar
    const isMobile = window.innerWidth < 1000
    if (isMobile) {
      setSidebarOpen(false)
      document.body.classList.add('sidebar-collapsed')
    } else {
      const storedSidebar = localStorage.getItem('mergen-sidebar')
      const open = storedSidebar === null ? true : storedSidebar === 'open'
      setSidebarOpen(open)
      if (open) {
        document.body.classList.remove('sidebar-collapsed')
      } else {
        document.body.classList.add('sidebar-collapsed')
      }
    }

    // Scroll spy
    const sections = document.querySelectorAll<HTMLElement>('section[id]')
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveHash(`#${entry.target.id}`)
          }
        })
      },
      { rootMargin: '-20% 0px -60% 0px' }
    )
    sections.forEach((s) => observer.observe(s))

    return () => {
      observer.disconnect()
    }
  }, [])

  function toggleTheme() {
    const nextTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(nextTheme)
    localStorage.setItem('mergen-theme', nextTheme)
    document.documentElement.classList.remove('notion-light', 'notion-dark')
    document.documentElement.classList.add(`notion-${nextTheme}`)
  }

  function toggleSidebar() {
    const nextOpen = !sidebarOpen
    setSidebarOpen(nextOpen)
    localStorage.setItem('mergen-sidebar', nextOpen ? 'open' : 'collapsed')
    if (nextOpen) {
      document.body.classList.remove('sidebar-collapsed')
    } else {
      document.body.classList.add('sidebar-collapsed')
    }
  }

  const filteredLinks = navLinks.filter((l) =>
    l.label.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleLinkClick = (href: string) => {
    if (window.innerWidth < 1000) {
      toggleSidebar()
    }
    const target = document.getElementById(href.substring(1))
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <>
      {/* Notion Collapsible Sidebar */}
      <aside className={`notion-sidebar ${sidebarOpen ? 'open' : 'collapsed'}`}>
        <div className="sidebar-inner">
          {/* Sidebar Header / Workspace profile */}
          <div className="sidebar-header">
            <div className="workspace-avatar">M</div>
            <div className="workspace-info">
              <span className="workspace-name">Mergen</span>
              <span className="workspace-role">Execution Gateway</span>
            </div>
            <button className="sidebar-close-btn" onClick={toggleSidebar} aria-label="Close sidebar">
              ⟨
            </button>
          </div>

          {/* Quick Find Search */}
          <div className="sidebar-search">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="Quick Find..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Sidebar Pages / Nav Links */}
          <div className="sidebar-nav">
            <span className="nav-group-title">Gateway Policies</span>
            <ul className="nav-group-list">
              {filteredLinks.map((l) => (
                <li key={l.href}>
                  <button
                    onClick={() => handleLinkClick(l.href)}
                    className={`sidebar-nav-item ${activeHash === l.href ? 'active' : ''}`}
                  >
                    <span className="item-bullet">•</span>
                    <span className="item-label">{l.label}</span>
                  </button>
                </li>
              ))}
            </ul>

            <span className="nav-group-title" style={{ marginTop: '1.5rem' }}>Resources</span>
            <ul className="nav-group-list">
              <li>
                <a href="/guide" className="sidebar-nav-item">
                  <span className="item-bullet">•</span>
                  <span className="item-label">Developer Guide</span>
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/omertt27/Mergen"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sidebar-nav-item"
                >
                  <span className="item-bullet">•</span>
                  <span className="item-label">GitHub Repository</span>
                </a>
              </li>
            </ul>
          </div>

          {/* Sidebar Footer */}
          <div className="sidebar-footer">
            <div className="footer-status">
              <span className="status-dot green"></span>
              <span>Local Engine: v1.2.4</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Floating Toggle Sidebar button when collapsed */}
      {!sidebarOpen && (
        <button className="sidebar-trigger" onClick={toggleSidebar} aria-label="Open sidebar">
          ☰
        </button>
      )}

      {/* Notion Top Bar */}
      <header className="notion-topbar">
        <div className="topbar-left">
          {/* Breadcrumbs */}
          <div className="breadcrumbs">
            <span className="breadcrumb-item">Mergen Workspace</span>
            <span className="breadcrumb-separator">/</span>
            <span className="breadcrumb-item">Gateways</span>
            <span className="breadcrumb-separator">/</span>
            <span className="breadcrumb-item active">Security Policy</span>
          </div>
        </div>

        <div className="topbar-right">
          <a
            href="https://github.com/omertt27/Mergen"
            target="_blank"
            rel="noopener noreferrer"
            className="topbar-action-btn github-star"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
            </svg>
            <span>Star</span>
          </a>
          <button className="topbar-action-btn" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? 'Dark' : 'Light'}
          </button>
          <a href="mailto:hello@mergen.dev?subject=Request%20Early%20Access" className="topbar-cta">
            Request Early Access
          </a>
        </div>
      </header>
    </>
  )
}