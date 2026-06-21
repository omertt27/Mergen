'use client'

import { useState, useEffect } from 'react'

interface Scenario {
  name: string
  key: string
  logic: string
  remedy: string
}

const scenarios: Scenario[] = [
  {
    name: 'DB Connection Leak',
    key: 'db_leak',
    logic: 'if (idle_connections > 80% && error_rate > 5%)',
    remedy: 'flush_idle_pools(api-service)',
  },
  {
    name: 'OOM Kill',
    key: 'oom_kill',
    logic: 'if (memory_usage > 95% && oom_events === true)',
    remedy: 'restart_with_profile(worker-node)',
  },
  {
    name: 'Rate Limit Cascade',
    key: 'rate_limit',
    logic: 'if (upstream_429_errors > 0 && p99_latency > 1.0s)',
    remedy: 'enable_circuit_breaker(auth-service)',
  },
]

export default function InteractiveSandbox() {
  const [selected, setSelected] = useState<Scenario>(scenarios[0])
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])

  // DB Leak State
  const [idleConns, setIdleConns] = useState(85)
  const [errorRate, setErrorRate] = useState(14.2)

  // OOM Kill State
  const [memoryUsage, setMemoryUsage] = useState(97)
  const [oomEvents, setOomEvents] = useState(true)

  // Rate Limit State
  const [upstream429, setUpstream429] = useState(12)
  const [latency, setLatency] = useState(1.2)

  // Clear output on scenario selection change
  useEffect(() => {
    setOutput([])
  }, [selected])

  // Compute values dynamically
  let isMatched = false
  let telemetry = ''
  let eventText = ''
  let confidence = 0

  if (selected.key === 'db_leak') {
    isMatched = idleConns > 80 && errorRate > 5
    telemetry = `pg_stat_activity count=${idleConns}/100, wait_event=ClientRead`
    eventText = `api-service error rate spike (${errorRate.toFixed(1)}%)`
    confidence = isMatched ? Math.min(99, Math.round(75 + (idleConns - 80) * 0.8 + (errorRate - 5) * 0.5)) : 0
  } else if (selected.key === 'oom_kill') {
    isMatched = memoryUsage > 95 && oomEvents
    telemetry = `container_memory_usage_bytes > limit (${memoryUsage}%), oom_score_adj=1000`
    eventText = `worker-node status=Ready, MemoryPressure=${memoryUsage > 80 ? 'True' : 'False'}`
    confidence = isMatched ? Math.min(99, Math.round(80 + (memoryUsage - 95) * 2.0)) : 0
  } else {
    isMatched = upstream429 > 0 && latency > 1.0
    telemetry = `${upstream429} errors from upstream-api, retry-after=60s`
    eventText = `auth-service latency=${latency.toFixed(1)}s (p99)`
    confidence = isMatched ? Math.min(99, Math.round(85 + (latency - 1.0) * 4 + (upstream429 > 10 ? 5 : 0))) : 0
  }

  function runDetector() {
    setRunning(true)
    setOutput(['> Initializing causal detector...', '> Fetching live telemetry...'])

    setTimeout(() => {
      setOutput(prev => [...prev, `> Event: "${eventText}"`])
    }, 500)

    setTimeout(() => {
      setOutput(prev => [...prev, `> Telemetry: ${telemetry}`])
    }, 1000)

    setTimeout(() => {
      if (isMatched) {
        setOutput(prev => [
          ...prev,
          `> Pattern MATCHED: ${selected.logic}`,
          `> SUCCESS: Executing remedy: ${selected.remedy} (${confidence}% Platt-scaled confidence)`
        ])
      } else {
        setOutput(prev => [
          ...prev,
          `> Pattern NOT MATCHED: ${selected.logic}`,
          `> HALTED: Input metrics are below threshold limits. Safe state maintained.`
        ])
      }
      setRunning(false)
    }, 1600)
  }

  return (
    <section id="sandbox">
      <span className="section-label">04 // Interactive Sandbox</span>
      <h2>
        Test the detector
        <br />
        logic.
      </h2>

      <div className="sandbox-grid mt-lg" style={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        gap: '4px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
      }}>
        {/* Responsive Grid Wrapper */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          width: '100%'
        }}>
          {/* Controls Panel */}
          <div style={{ background: 'var(--bg)', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div>
              <p style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gray-600)', marginBottom: '1rem' }}>
                Select Scenario
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {scenarios.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => { setSelected(s); setOutput([]); }}
                    style={{
                      flex: '1 1 120px',
                      padding: '0.75rem',
                      textAlign: 'left',
                      background: selected.key === s.key ? 'rgba(255, 85, 0, 0.08)' : 'transparent',
                      border: '1px solid',
                      borderColor: selected.key === s.key ? 'var(--accent)' : 'var(--gray-800)',
                      color: selected.key === s.key ? 'var(--accent-text)' : 'var(--gray-600)',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      transition: 'all 0.2s',
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Slider Adjustments Panel */}
            <div style={{ borderTop: '1px solid var(--gray-800)', paddingTop: '1.5rem' }}>
              <p style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gray-600)', marginBottom: '1.25rem' }}>
                Adjust Telemetry Inputs
              </p>

              {selected.key === 'db_leak' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Idle Connections</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: idleConns > 80 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {idleConns}% {idleConns > 80 && '(Critical)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      value={idleConns}
                      onChange={(e) => { setIdleConns(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Error Rate Spike</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: errorRate > 5 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {errorRate.toFixed(1)}% {errorRate > 5 && '(High)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="30"
                      step="0.5"
                      value={errorRate}
                      onChange={(e) => { setErrorRate(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>
                </div>
              )}

              {selected.key === 'oom_kill' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Memory Usage</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: memoryUsage > 95 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {memoryUsage}% {memoryUsage > 95 && '(OOM Risk)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="50"
                      max="100"
                      value={memoryUsage}
                      onChange={(e) => { setMemoryUsage(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                    <span style={{ color: 'var(--gray-400)' }}>OOM Incident Triggered</span>
                    <input
                      type="checkbox"
                      checked={oomEvents}
                      onChange={(e) => { setOomEvents(e.target.checked); setOutput([]); }}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--accent)', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}

              {selected.key === 'rate_limit' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Upstream 429 Errors</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: upstream429 > 0 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {upstream429} events
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="50"
                      value={upstream429}
                      onChange={(e) => { setUpstream429(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Latency p99</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: latency > 1.0 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {latency.toFixed(1)}s {latency > 1.0 && '(Slow)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="3.0"
                      step="0.1"
                      value={latency}
                      onChange={(e) => { setLatency(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div>
              <button
                onClick={runDetector}
                disabled={running}
                className="btn btn-white"
                style={{ width: '100%', padding: '1rem', opacity: running ? 0.5 : 1 }}
              >
                {running ? 'Analyzing Telemetry...' : 'Run Detector →'}
              </button>
            </div>
          </div>

          {/* Terminal Output */}
          <div style={{ background: '#09090b', padding: '2rem', fontFamily: 'var(--font-geist-mono), monospace', display: 'flex', flexDirection: 'column', gap: '1.5rem', minHeight: '320px' }}>
            <div style={{ color: '#71717a', fontSize: '0.75rem', borderBottom: '1px solid #27272a', paddingBottom: '1rem', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <span>// Telemetry context pack:</span>
              <span style={{ color: '#4ade80' }}>{telemetry}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', flex: 1 }}>
              {output.length === 0 && (
                <div style={{ color: '#52525b', fontStyle: 'italic', fontSize: '0.85rem' }}>
                  Adjust parameters on the left, then click "Run Detector" to see Mergen's diagnostic check in action.
                </div>
              )}
              {output.map((line, i) => {
                const isSuccess = line.startsWith('> SUCCESS')
                const isHalted = line.startsWith('> HALTED')
                const isHeading = line.startsWith('>') && !isSuccess && !isHalted
                
                let textColor = '#71717a'
                if (isSuccess) textColor = '#4ade80'
                else if (isHalted) textColor = '#ef4444'
                else if (isHeading) textColor = '#38bdf8'

                return (
                  <div key={i} style={{
                    fontSize: '0.85rem',
                    color: textColor,
                    fontWeight: (isSuccess || isHalted) ? 800 : 400,
                  }}>
                    {line}
                  </div>
                )
              })}
              {running && <span className="terminal-cursor">_</span>}
            </div>

            {/* Condition Status Badge */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.75rem 1rem',
              border: '1px solid #27272a',
              background: '#18181b',
              borderRadius: '4px',
              fontSize: '0.75rem',
            }}>
              <span style={{ color: '#a1a1aa' }}>Causal Rule Match:</span>
              {isMatched ? (
                <span style={{ color: '#4ade80', fontWeight: 800 }}>✓ MATCHED (Armed)</span>
              ) : (
                <span style={{ color: '#71717a' }}>✗ UNMATCHED (Inactive)</span>
              )}
            </div>

            {output.length > 0 && !running && isMatched && (
              <div style={{
                border: '1px solid #1a3a1a',
                background: '#0a1a0a',
                borderRadius: '4px',
                overflow: 'hidden',
                fontSize: '0.75rem',
              }}>
                <div style={{
                  background: '#4a1d96',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: '#c4b5fd',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}>
                  <span>⚡</span> SLACK THREAD — what your team would see
                </div>
                <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ color: '#f87171', minWidth: '16px' }}>🚨</span>
                    <div>
                      <span style={{ color: '#f1f5f9', fontWeight: 700 }}>Production Incident</span>
                      <span style={{ color: '#64748b' }}> — {selected.name.toLowerCase().replace(' ', '-')}</span>
                    </div>
                  </div>
                  <div style={{ paddingLeft: '1.5rem', color: '#94a3b8', lineHeight: 1.7 }}>
                    <div>✅ <span style={{ color: '#4ade80', fontWeight: 600 }}>Causal Attribution — {confidence}% [HIGH]</span></div>
                    <div style={{ color: '#64748b' }}>→ Root Cause: <span style={{ color: '#e2e8f0' }}>{
                      selected.key === 'db_leak' ? `pg_stat_activity exhausted (${idleConns}/100 idle, ClientRead wait)` :
                      selected.key === 'oom_kill' ? `Container OOM kill — memory at ${memoryUsage}%, oom_score_adj=1000` :
                      `Upstream 429 cascade — ${upstream429} errors, p99 latency ${latency.toFixed(1)}s`
                    }</span></div>
                    <div style={{ color: '#64748b' }}>→ Fix: <code style={{ color: '#38bdf8', background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '2px' }}>{selected.remedy}</code></div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ minWidth: '16px' }}>⚙️</span>
                    <span style={{ color: '#94a3b8' }}>Autopilot executing fix <code style={{ color: '#38bdf8' }}>{selected.remedy}</code></span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ minWidth: '16px' }}>✅</span>
                    <span style={{ color: '#4ade80', fontWeight: 700 }}>RESOLVED — 0 errors after fix (was {
                      selected.key === 'db_leak' ? `${errorRate.toFixed(1)}%` :
                      selected.key === 'oom_kill' ? 'OOM' : `${upstream429} upstream errors`
                    })</span>
                  </div>
                  <div style={{ color: '#334155', fontSize: '0.65rem', borderTop: '1px solid #1e293b', paddingTop: '0.5rem' }}>
                    resolvedAutonomously=true · MTTR=47s · audit trail at ~/.mergen/audit.log
                  </div>
                </div>
              </div>
            )}

            {output.length > 0 && !running && !isMatched && (
              <div style={{
                padding: '1rem',
                border: '1px solid #27272a',
                background: '#18181b',
                borderRadius: '4px',
                fontSize: '0.75rem',
                color: '#a1a1aa',
                lineHeight: 1.6,
              }}>
                <span style={{ color: 'var(--accent)' }}>Safety gate held:</span>{' '}
                Metrics do not cross the threshold boundary. Action was blocked at the planning layer. Raise the sliders above the threshold to see autopilot arm.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
