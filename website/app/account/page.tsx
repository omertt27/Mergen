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

// ─── UI helpers ────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--gray-800)',
  borderRadius: 4,
  padding: '1.5rem',
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.6rem', letterSpacing: '0.4em', textTransform: 'uppercase', color: 'var(--gray-600)', marginBottom: '0.75rem' }}>
      {children}
    </p>
  )
}

function Row({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>{label}</span>
      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: accent ? 'var(--accent-text)' : 'var(--white)', fontFamily: 'var(--font-geist-mono)' }}>
        {value}
      </span>
    </div>
  )
}

function ProgressBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(1, used / total) : 0
  const color = pct > 0.9 ? '#ef4444' : pct > 0.7 ? '#f59e0b' : 'var(--accent)'
  return (
    <div style={{ margin: '1rem 0 0.5rem', height: 4, background: 'var(--gray-800)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct * 100}%`, background: color, borderRadius: 2, transition: 'width 0.6s ease' }} />
    </div>
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
    probeServer().then(setState)
  }, [])

  return (
    <>
      <Nav />
      <div className="notion-page-container">
        {/* Cover Photo */}
        <div className="notion-page-cover" style={{ background: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)' }} />
        
        <main className="wrap notion-page-content">
          <div style={{ maxWidth: 680 }}>

            {/* Header */}
            <p style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.6rem', letterSpacing: '0.5em', textTransform: 'uppercase', color: 'var(--gray-600)', marginBottom: '1.5rem' }}>
              Account
            </p>
            <h1 style={{ fontSize: 'clamp(1.8rem, 4vw, 2.5rem)', fontWeight: 800, lineHeight: 1.1, marginBottom: '2.5rem' }}>
              My Mergen
            </h1>

          {/* Connection status bar */}
          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', padding: '1rem 1.5rem' }}>
            {state === 'loading' ? (
              <>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--gray-600)', flexShrink: 0 }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>Connecting to local server…</span>
              </>
            ) : state ? (
              <>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e', flexShrink: 0 }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--white)' }}>
                  Connected — Mergen v{state.health.version} on port {state.port}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', fontFamily: 'var(--font-geist-mono)', color: 'var(--gray-400)' }}>
                  {state.health.buffered} events buffered
                </span>
              </>
            ) : (
              <>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: '0.8rem', color: 'var(--white)', marginBottom: '0.4rem' }}>Server not running</p>
                  <pre style={{ fontSize: '0.75rem', color: 'var(--accent-text)', fontFamily: 'var(--font-geist-mono)', background: 'none', padding: 0 }}>
                    npx mergen-server@latest start
                  </pre>
                </div>
              </>
            )}
          </div>

          {state && state !== 'loading' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

              {/* Plan + credits */}
              <div style={card}>
                <Label>Plan &amp; Usage</Label>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--white)' }}>
                    {state.license.plan.name}
                  </span>
                  {state.license.license?.status === 'active' && (
                    <span style={{ fontSize: '0.7rem', fontFamily: 'var(--font-geist-mono)', color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '2px 8px', borderRadius: 3 }}>
                      Active
                    </span>
                  )}
                </div>

                {state.usage.included !== null ? (
                  <>
                    <ProgressBar used={state.usage.used} total={state.usage.included} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--gray-400)', fontFamily: 'var(--font-geist-mono)', marginBottom: '1rem' }}>
                      <span>{state.usage.used.toLocaleString()} / {state.usage.included.toLocaleString()} incidents this month</span>
                      <span>resets {new Date(state.usage.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    </div>
                  </>
                ) : (
                  <p style={{ fontSize: '0.8rem', color: 'var(--gray-400)', margin: '0.75rem 0 1rem', fontFamily: 'var(--font-geist-mono)' }}>
                    {state.usage.used.toLocaleString()} analyze calls this month · unlimited
                  </p>
                )}

                {state.usage.overage > 0 && (
                  <p style={{ fontSize: '0.75rem', color: '#f59e0b', fontFamily: 'var(--font-geist-mono)', marginBottom: '1rem' }}>
                    {state.usage.overage} overage calls · est. ${(state.usage.estimatedOverageCents / 100).toFixed(2)}
                  </p>
                )}

                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {state.license.plan.id === 'free' && (
                    <a href="/#access" className="btn btn-white" style={{ fontSize: '0.6rem', padding: '0.7rem 1.5rem' }}>
                      Upgrade plan
                    </a>
                  )}
                  <a href={BILLING_PORTAL} target="_blank" rel="noopener noreferrer" className="btn btn-outline" style={{ fontSize: '0.6rem', padding: '0.7rem 1.5rem' }}>
                    Manage billing
                  </a>
                </div>
              </div>

              {/* License info */}
              {state.license.license && (
                <div style={card}>
                  <Label>License</Label>
                  {state.license.license.email && (
                    <Row label="Email" value={state.license.license.email} />
                  )}
                  {state.license.license.name && (
                    <Row label="Name" value={state.license.license.name} />
                  )}
                  {state.license.license.activatedAt && (
                    <Row label="Activated" value={new Date(state.license.license.activatedAt).toLocaleDateString()} />
                  )}
                  <Row label="Status" value={state.license.license.status} accent />
                </div>
              )}

              {/* Accuracy (only show when there is enough data) */}
              {state.calibration.overallAccuracy !== null && state.calibration.trustedDetectors > 0 && (
                <div style={card}>
                  <Label>Diagnosis Accuracy</Label>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)' }}>
                      {Math.round(state.calibration.overallAccuracy * 100)}%
                    </span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>overall accuracy</span>
                  </div>
                  <Row
                    label="Trusted detectors"
                    value={`${state.calibration.trustedDetectors} / ${state.calibration.totalDetectors}`}
                  />
                  <p style={{ fontSize: '0.75rem', color: 'var(--gray-600)', marginTop: '0.75rem', lineHeight: 1.6 }}>
                    Accuracy improves as you rate diagnoses in the dashboard. Each verdict trains which detectors Mergen trusts for your stack.
                  </p>
                </div>
              )}

              {/* Session stats */}
              <div style={card}>
                <Label>This Session</Label>
                <Row label="Events in buffer" value={state.health.buffered.toLocaleString()} />
                <Row label="Errors" value={state.health.errors} accent={state.health.errors > 0} />
                {state.health.lastEventAt && (
                  <Row
                    label="Last event"
                    value={`${Math.round((Date.now() - state.health.lastEventAt) / 1000)}s ago`}
                  />
                )}
                {Object.entries(state.usage.toolCallCounts).length > 0 && (
                  <Row
                    label="Tool calls this session"
                    value={Object.values(state.usage.toolCallCounts).reduce((a, b) => a + b, 0).toLocaleString()}
                  />
                )}
                <div style={{ marginTop: '1rem' }}>
                  <a
                    href={`http://127.0.0.1:${state.port}/dashboard`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-outline"
                    style={{ fontSize: '0.6rem', padding: '0.7rem 1.5rem' }}
                  >
                    Open local dashboard
                  </a>
                </div>
              </div>

            </div>
          )}

          {/* Offline state — show what they're missing */}
          {state === null && (
            <div style={{ ...card, borderColor: 'rgba(239,68,68,0.2)' }}>
              <Label>Getting started</Label>
              <p style={{ fontSize: '0.875rem', color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '1.5rem' }}>
                Start the Mergen server to see your plan, credit usage, and accuracy data.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {['npx mergen-server@latest setup', 'npx mergen-server@latest start'].map((cmd) => (
                  <pre key={cmd} style={{ padding: '0.6rem 1rem', background: 'var(--gray-800)', borderRadius: 4, fontFamily: 'var(--font-geist-mono)', fontSize: '0.8rem', color: 'var(--accent-text)' }}>
                    {cmd}
                  </pre>
                ))}
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--gray-600)', marginTop: '1rem' }}>
                New here?{' '}
                <a href="https://github.com/omertt27/Mergen/blob/main/QUICKSTART.md" style={{ color: 'var(--accent-text)' }}>
                  Quick start guide →
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
