'use client'

import { useEffect, useState } from 'react'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'

const LOCAL_PORTS = [3000, 3001, 3002, 3003]
const BILLING_PORTAL = 'https://app.lemonsqueezy.com/my-orders/'

interface UsageData {
  used: number
  included: number | null
  overage: number
  estimatedOverageCents: number
  resetsAt: number
  toolCallCounts: Record<string, number>
}

interface LicenseData {
  plan: {
    id: string
    name: string
    analyzeCreditsPerMonth: number | null
  }
  license: {
    status: string
    email: string | null
    name: string | null
    activatedAt: number | null
  } | null
}

interface CalibrationData {
  overallAccuracy: number | null
  trustedDetectors: number
  totalDetectors: number
  corpusSeeded?: boolean
}

interface HealthData {
  version: string
  buffered: number
  errors: number
  lastEventAt: number | null
}

interface ServerState {
  port: number
  usage: UsageData
  license: LicenseData
  calibration: CalibrationData
  health: HealthData
}

// ─── Custom SVG Icons ──────────────────────────────────────────────────────────

function ShieldIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function CopyIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function TerminalIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function AccuracyIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  )
}

// ─── UI helpers ────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'rgba(17, 18, 25, 0.75)',
  border: '1px solid rgba(255, 255, 255, 0.07)',
  borderRadius: '8px',
  padding: '1.75rem',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
  transition: 'transform 0.2s ease, border-color 0.2s ease',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.25em', textTransform: 'uppercase', color: 'var(--gray-500)', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      {children}
    </h2>
  )
}

function Row({ label, value, accent, subtext }: { label: string; value: React.ReactNode; accent?: boolean; subtext?: string }) {
  return (
    <div style={{ padding: '0.85rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--gray-400)' }}>{label}</span>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: accent ? '#f59e0b' : 'var(--white)', fontFamily: 'var(--font-geist-mono)' }}>
          {value}
        </span>
      </div>
      {subtext && <p style={{ fontSize: '0.75rem', color: 'var(--gray-600)', marginTop: '0.25rem' }}>{subtext}</p>}
    </div>
  )
}

function ProgressBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(1, used / total) : 0
  const color = pct > 0.9 ? '#ef4444' : pct > 0.7 ? '#f59e0b' : '#3b82f6'
  return (
    <div style={{ margin: '1.25rem 0 0.5rem', height: 6, background: '#1c1e26', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
      <div style={{ height: '100%', width: `${pct * 100}%`, background: `linear-gradient(90deg, ${color} 0%, #a855f7 100%)`, borderRadius: 3, transition: 'width 0.6s cubic-bezier(0.16, 1, 0.3, 1)', boxShadow: `0 0 8px ${color}` }} />
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  return (
    <button 
      onClick={handleCopy}
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '4px',
        padding: '0.35rem 0.6rem',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        color: copied ? '#22c55e' : 'var(--gray-400)',
        fontSize: '0.7rem',
        fontFamily: 'var(--font-geist-mono)',
        transition: 'all 0.15s ease'
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json() as Promise<T>
}

async function probeServer(): Promise<ServerState | null> {
  for (const port of LOCAL_PORTS) {
    try {
      const base = `http://127.0.0.1:${port}`
      const [usage, license, calibration, health] = await Promise.all([
        fetchJson<UsageData>(`${base}/usage`),
        fetchJson<LicenseData>(`${base}/license`),
        fetchJson<CalibrationData>(`${base}/calibration`),
        fetchJson<HealthData>(`${base}/health`),
      ])
      return { port, usage, license, calibration, health }
    } catch {
      continue
    }
  }
  return null
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function AccountPage() {
  const [state, setState] = useState<ServerState | null | 'loading'>('loading')

  useEffect(() => {
    let active = true
    const tick = () => {
      probeServer().then(res => {
        if (active) setState(res)
      })
    }
    tick()
    const timer = setInterval(tick, 10000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  return (
    <>
      {/* Stylesheet injector for premium glows and breathing animations */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes breatheGreen {
          0% { box-shadow: 0 0 0 0 rgba(34, 197, 150, 0.4); transform: scale(0.96); }
          50% { box-shadow: 0 0 10px 4px rgba(34, 197, 150, 0.2); transform: scale(1.04); }
          100% { box-shadow: 0 0 0 0 rgba(34, 197, 150, 0.4); transform: scale(0.96); }
        }
        @keyframes breatheRed {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); transform: scale(0.96); }
          50% { box-shadow: 0 0 10px 4px rgba(239, 68, 68, 0.2); transform: scale(1.04); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); transform: scale(0.96); }
        }
        .pulse-green {
          animation: breatheGreen 2s infinite ease-in-out;
        }
        .pulse-red {
          animation: breatheRed 2s infinite ease-in-out;
        }
        .premium-card:hover {
          border-color: rgba(99, 102, 241, 0.2) !important;
          transform: translateY(-2px);
        }
      ` }} />

      <Nav />
      <div className="notion-page-container" style={{ position: 'relative', overflow: 'hidden', minHeight: '100vh', background: '#07080e' }}>
        
        {/* Sleek Mesh Gradient cover */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: '420px',
          background: 'radial-gradient(circle at 80% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 60%), radial-gradient(circle at 10% 40%, rgba(168, 85, 247, 0.08) 0%, transparent 50%)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
          pointerEvents: 'none',
          zIndex: 0
        }} />
        
        <main className="wrap notion-page-content" style={{ position: 'relative', zIndex: 1, paddingTop: '4rem', paddingBottom: '6rem' }}>
          <div style={{ maxWidth: 840, margin: '0 auto' }}>

            {/* Header */}
            <div style={{ marginBottom: '3rem' }}>
              <p style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.3em', textTransform: 'uppercase', color: '#6366f1', marginBottom: '0.75rem' }}>
                Gateway Terminal
              </p>
              <h1 style={{ fontSize: 'clamp(2.2rem, 5vw, 3rem)', fontWeight: 850, letterSpacing: '-0.02em', lineHeight: 1.05, marginBottom: '0.5rem', color: 'var(--white)' }}>
                My Mergen
              </h1>
              <p style={{ color: 'var(--gray-500)', fontSize: '0.95rem' }}>Monitor your local security gateway policies, incident context credits, and system health.</p>
            </div>

            {/* Connection status bar */}
            <div style={{ 
              ...cardStyle, 
              display: 'flex', 
              alignItems: 'center', 
              gap: '1rem', 
              marginBottom: '2.5rem', 
              padding: '1.25rem 1.75rem',
              borderColor: state === 'loading' ? 'rgba(255,255,255,0.05)' : state ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
              background: state === 'loading' ? 'rgba(17, 18, 25, 0.6)' : state ? 'rgba(10, 25, 18, 0.5)' : 'rgba(25, 10, 10, 0.5)',
            }}>
              {state === 'loading' ? (
                <>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--gray-600)', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.85rem', color: 'var(--gray-400)', fontFamily: 'var(--font-geist-mono)' }}>Scanning local ports for Mergen Gateway…</span>
                </>
              ) : state ? (
                <>
                  <span className="pulse-green" style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.85rem', color: 'var(--white)', fontWeight: 500 }}>
                    Connected — Gateway v{state.health.version} active on port {state.port}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.75rem', fontFamily: 'var(--font-geist-mono)', color: 'var(--gray-400)', background: 'rgba(255,255,255,0.04)', padding: '0.2rem 0.5rem', borderRadius: 4 }}>
                    {state.health.buffered} logs resolved
                  </span>
                </>
              ) : (
                <>
                  <span className="pulse-red" style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                    <p style={{ fontSize: '0.85rem', color: 'var(--white)', fontWeight: 500 }}>Local security gateway is offline</p>
                    <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-geist-mono)', color: '#ef4444', background: 'rgba(239,68,68,0.08)', padding: '0.2rem 0.5rem', borderRadius: 4 }}>
                      Not Intercepting
                    </span>
                  </div>
                </>
              )}
            </div>

            {state && state !== 'loading' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>

                {/* Plan + credits */}
                <div className="premium-card" style={{ ...cardStyle, gridColumn: 'span 2' }}>
                  <Label>
                    <ShieldIcon style={{ color: '#6366f1' }} />
                    Plan &amp; Usage
                  </Label>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--white)', letterSpacing: '-0.01em' }}>
                      {state.license.plan.name}
                    </span>
                    {state.license.license?.status === 'active' && (
                      <span style={{ fontSize: '0.65rem', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#10b981', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)', padding: '3px 8px', borderRadius: 4 }}>
                        Secure Gate Enforcing
                      </span>
                    )}
                  </div>

                  {state.usage.included !== null ? (
                    <>
                      <ProgressBar used={state.usage.used} total={state.usage.included} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--gray-400)', fontFamily: 'var(--font-geist-mono)', marginBottom: '1.5rem' }}>
                        <span>{state.usage.used.toLocaleString()} / {state.usage.included.toLocaleString()} active blocks/overrides</span>
                        <span>Resets {new Date(state.usage.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      </div>
                    </>
                  ) : (
                    <p style={{ fontSize: '0.8rem', color: 'var(--gray-400)', margin: '1rem 0 1.5rem', fontFamily: 'var(--font-geist-mono)' }}>
                      {state.usage.used.toLocaleString()} active gate checks evaluated · Unlimited Enforcements
                    </p>
                  )}

                  {state.usage.overage > 0 && (
                    <div style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '1.5rem' }}>
                      <p style={{ fontSize: '0.8rem', color: '#f59e0b', fontFamily: 'var(--font-geist-mono)', margin: 0 }}>
                        ⚠️ {state.usage.overage} overage calls evaluated · Estimated overage: ${(state.usage.estimatedOverageCents / 100).toFixed(2)} USD
                      </p>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
                    {state.license.plan.id === 'free' && (
                      <a href="/#access" className="btn btn-white" style={{ fontSize: '0.7rem', padding: '0.75rem 1.75rem', fontWeight: 600 }}>
                        Upgrade gateway
                      </a>
                    )}
                    <a href={BILLING_PORTAL} target="_blank" rel="noopener noreferrer" className="btn btn-outline" style={{ fontSize: '0.7rem', padding: '0.75rem 1.75rem', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent' }}>
                      Manage billing portal
                    </a>
                  </div>
                </div>

                {/* License info */}
                {state.license.license && (
                  <div className="premium-card" style={cardStyle}>
                    <Label>License Cryptography</Label>
                    {state.license.license.email && (
                      <Row label="Email owner" value={state.license.license.email} />
                    )}
                    {state.license.license.name && (
                      <Row label="Licensed name" value={state.license.license.name} />
                    )}
                    {state.license.license.activatedAt && (
                      <Row label="Activated date" value={new Date(state.license.license.activatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} />
                    )}
                    <Row label="Gateway status" value={state.license.license.status.toUpperCase()} accent />
                  </div>
                )}

                {/* Accuracy */}
                {state.calibration.overallAccuracy !== null && state.calibration.trustedDetectors > 0 && !state.calibration.corpusSeeded && (
                  <div className="premium-card" style={cardStyle}>
                    <Label>
                      <AccuracyIcon style={{ color: '#10b981' }} />
                      Diagnosis Accuracy
                    </Label>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '2.5rem', fontWeight: 900, color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)', letterSpacing: '-0.02em', background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                        {Math.round(state.calibration.overallAccuracy * 100)}%
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>empirical rating</span>
                    </div>
                    <Row
                      label="Trusted active detectors"
                      value={`${state.calibration.trustedDetectors} / ${state.calibration.totalDetectors}`}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginTop: '0.85rem', lineHeight: 1.6 }}>
                      Mergen re-trains model thresholds based on local override corrections. Every manual verdict updates your workspace policy matrix.
                    </p>
                  </div>
                )}

                {/* Session stats */}
                <div className="premium-card" style={{ ...cardStyle, gridColumn: state.license.license ? 'auto' : 'span 2' }}>
                  <Label>Runtime telemetry</Label>
                  <Row label="Console events in ring" value={state.health.buffered.toLocaleString()} />
                  <Row label="Intercepted errors" value={state.health.errors} accent={state.health.errors > 0} />
                  {state.health.lastEventAt && (
                    <Row
                      label="Last event received"
                      value={`${Math.round((Date.now() - state.health.lastEventAt) / 1000)}s ago`}
                    />
                  )}
                  {Object.entries(state.usage.toolCallCounts).length > 0 && (
                    <Row
                      label="Total tool executions"
                      value={Object.values(state.usage.toolCallCounts).reduce((a, b) => a + b, 0).toLocaleString()}
                    />
                  )}
                  <div style={{ marginTop: '1.25rem' }}>
                    <a
                      href={`http://127.0.0.1:${state.port}/dashboard`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-outline"
                      style={{ fontSize: '0.7rem', padding: '0.7rem 1.5rem', width: '100%', textAlign: 'center', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      Open local dashboard ↗
                    </a>
                  </div>
                </div>

              </div>
            )}

            {/* Offline state — show what they're missing */}
            {state === null && (
              <div style={{ ...cardStyle, borderColor: 'rgba(239,68,68,0.25)', background: 'rgba(15, 10, 10, 0.4)' }}>
                <Label>
                  <TerminalIcon style={{ color: '#ef4444' }} />
                  Gateway setup instructions
                </Label>
                <p style={{ fontSize: '0.9rem', color: 'var(--gray-400)', lineHeight: 1.65, marginBottom: '1.75rem' }}>
                  Start your local proxy server to enforce security policies and view real-time incident reports.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  {[
                    { cmd: 'npx mergen-server@latest setup', label: '1. Initialize gateway policy configuration' },
                    { cmd: 'npx mergen-server@latest start', label: '2. Spin up localhost gateway server' }
                  ].map((item) => (
                    <div key={item.cmd} style={{ 
                      background: '#0d0e14', 
                      border: '1px solid rgba(255,255,255,0.04)', 
                      borderRadius: 6, 
                      padding: '0.85rem 1.25rem' 
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--gray-500)' }}>{item.label}</span>
                        <CopyButton text={item.cmd} />
                      </div>
                      <pre style={{ 
                        margin: 0, 
                        fontFamily: 'var(--font-geist-mono)', 
                        fontSize: '0.85rem', 
                        color: 'var(--accent-text)', 
                        background: 'none', 
                        padding: 0,
                        overflowX: 'auto'
                      }}>
                        {item.cmd}
                      </pre>
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--gray-500)', marginTop: '1.5rem' }}>
                  Need more help?{' '}
                  <a href="https://github.com/omertt27/Mergen/blob/main/QUICKSTART.md" style={{ color: 'var(--accent-text)', textDecoration: 'underline' }}>
                    Read the installation guide →
                  </a>
                </p>
              </div>
            )}

          </div>
        </main>
        <Footer />
      </div>
    </>
  )
}
