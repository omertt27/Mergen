'use client'

import { useState } from 'react'

const scenarios = [
  {
    name: 'DB Connection Leak',
    event: 'api-service error rate spike (14.2%)',
    telemetry: 'pg_stat_activity count=98/100, wait_event=ClientRead',
    logic: 'if (idle_conns > 80% && errors > 5%) => stuck_idle_connections',
    result: 'REMEDY: flush_idle_pools(api-service)',
    confidence: '92%',
  },
  {
    name: 'OOM Kill',
    event: 'worker-node status=Ready, MemoryPressure=True',
    telemetry: 'container_memory_usage_bytes > limit, oom_score_adj=1000',
    logic: 'if (mem_usage > 95% && oom_events > 0) => memory_leak_detected',
    result: 'REMEDY: restart_with_profile(worker-node)',
    confidence: '88%',
  },
  {
    name: 'Rate Limit Cascade',
    event: 'auth-service latency=1.2s (p99)',
    telemetry: '429 errors from upstream-api, retry-after=60s',
    logic: 'if (upstream_429 > 0 && p99 > 1s) => external_rate_limit',
    result: 'REMEDY: enable_circuit_breaker(auth-service)',
    confidence: '94%',
  },
]

export default function InteractiveSandbox() {
  const [selected, setSelected] = useState(scenarios[0])
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])

  function runDetector() {
    setRunning(true)
    setOutput(['> Initializing causal detector...', '> Fetching telemetry context...'])
    
    setTimeout(() => {
      setOutput(prev => [...prev, `> Analyzing: "${selected.event}"`])
    }, 600)

    setTimeout(() => {
      setOutput(prev => [...prev, `> Pattern Match: ${selected.logic}`])
    }, 1200)

    setTimeout(() => {
      setOutput(prev => [...prev, `> SUCCESS: ${selected.result} (${selected.confidence} confidence)`])
      setRunning(false)
    }, 2000)
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
        gridTemplateColumns: '300px 1fr',
        gap: '4px',
        background: 'var(--gray-800)',
        border: '1px solid var(--gray-800)',
      }}>
        <div style={{ background: 'var(--bg)', padding: '2rem' }}>
          <p style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--gray-600)', marginBottom: '1.5rem' }}>
            Select Scenario
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {scenarios.map((s) => (
              <button
                key={s.name}
                onClick={() => { setSelected(s); setOutput([]); }}
                style={{
                  padding: '1rem',
                  textAlign: 'left',
                  background: selected.name === s.name ? 'rgba(8, 145, 178, 0.1)' : 'transparent',
                  border: '1px solid',
                  borderColor: selected.name === s.name ? 'var(--accent)' : 'var(--gray-800)',
                  color: selected.name === s.name ? 'var(--white)' : 'var(--gray-600)',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  borderRadius: '2px',
                }}
              >
                {s.name}
              </button>
            ))}
          </div>

          <div style={{ marginTop: '3rem' }}>
            <button
              onClick={runDetector}
              disabled={running}
              className="btn btn-white"
              style={{ width: '100%', padding: '1rem', opacity: running ? 0.5 : 1 }}
            >
              {running ? 'Analyzing...' : 'Run Detector →'}
            </button>
          </div>
        </div>

        <div style={{ background: '#000', padding: '2rem', fontFamily: 'var(--font-geist-mono), monospace', position: 'relative' }}>
          <div style={{ color: 'var(--gray-600)', fontSize: '0.75rem', marginBottom: '1.5rem', borderBottom: '1px solid #222', paddingBottom: '1rem' }}>
            // Telemetry Input: <span style={{ color: '#4ade80' }}>{selected.telemetry}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {output.length === 0 && (
              <div style={{ color: '#444', fontStyle: 'italic', fontSize: '0.85rem' }}>
                Select a scenario and click "Run Detector" to see Mergen's causal logic in action.
              </div>
            )}
            {output.map((line, i) => (
              <div key={i} style={{
                fontSize: '0.85rem',
                color: line.startsWith('>') ? '#67e8f9' : line.startsWith('> SUCCESS') ? '#4ade80' : '#888',
                fontWeight: line.startsWith('> SUCCESS') ? 800 : 400,
              }}>
                {line}
              </div>
            ))}
            {running && <span className="terminal-cursor">_</span>}
          </div>
          
          {output.length > 0 && !running && (
            <div style={{
              marginTop: '3rem',
              padding: '1rem',
              border: '1px solid #333',
              background: '#0d0d0d',
              fontSize: '0.75rem',
              color: 'var(--gray-400)',
              lineHeight: 1.6,
            }}>
              <span style={{ color: 'var(--accent)' }}>Note:</span> This logic is part of the <code>stuck_idle_connections</code> detector in <code>@mergen/detectors-v1</code>. 
              In production, this would trigger an autonomous remediation or a Slack alert based on your policy.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
