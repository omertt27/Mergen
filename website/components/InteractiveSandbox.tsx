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
    name: 'Destructive Command Intercept',
    key: 'destructive_cmd',
    logic: 'if (danger_level > 7 && blast_radius > 50%)',
    remedy: 'block_destructive_commands(agent-cli)',
  },
  {
    name: 'Secret Leak Prevention',
    key: 'secret_leak',
    logic: 'if (access_depth > 5 || contains_credentials === true)',
    remedy: 'redact_credentials(file-reader)',
  },
  {
    name: 'Incident Re-occurrence Guard',
    key: 'incident_repeat',
    logic: 'if (touches_auth_middleware === true && stack_depth > 4)',
    remedy: 'block_recursive_stack_depth(git-hook)',
  },
]

export default function InteractiveSandbox() {
  const [selected, setSelected] = useState<Scenario>(scenarios[0])
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])

  // Scenario A State (replaces idleConns and errorRate)
  const [dangerLevel, setDangerLevel] = useState(8)
  const [blastRadius, setBlastRadius] = useState(65)

  // Scenario B State (replaces memoryUsage and oomEvents)
  const [accessDepth, setAccessDepth] = useState(7)
  const [isCredential, setIsCredential] = useState(true)

  // Scenario C State (replaces upstream429 and latency)
  const [stackDepth, setStackDepth] = useState(6)
  const [riskScore, setRiskScore] = useState(1.8)

  // Clear output on scenario selection change
  useEffect(() => {
    setOutput([])
  }, [selected])

  // Compute values dynamically
  let isMatched = false
  let telemetry = ''
  let eventText = ''
  let confidence = 0

  if (selected.key === 'destructive_cmd') {
    isMatched = dangerLevel > 7 && blastRadius > 50
    telemetry = `Command: "terraform destroy prod" (danger=${dangerLevel}/10, blast=${blastRadius}%)`
    eventText = `Agent requested run_command tool execution`
    confidence = isMatched ? Math.min(99, Math.round(75 + (dangerLevel - 7) * 4 + (blastRadius - 50) * 0.3)) : 0
  } else if (selected.key === 'secret_leak') {
    isMatched = accessDepth > 5 || isCredential
    telemetry = `File path: "/Users/omer/Desktop/Mergen/.env" (depth=${accessDepth}/10, cred=${isCredential.toString()})`
    eventText = `Agent requested read_file tool execution`
    confidence = isMatched ? Math.min(99, Math.round(80 + (accessDepth - 5) * 3)) : 0
  } else {
    isMatched = stackDepth > 4 && riskScore > 1.0
    telemetry = `Git diff touches auth_middleware.ts (depth=${stackDepth}/10, risk=${riskScore.toFixed(1)}/3.0)`
    eventText = `Agent requested git_commit tool execution`
    confidence = isMatched ? Math.min(99, Math.round(85 + (riskScore - 1.0) * 4 + (stackDepth > 5 ? 5 : 0))) : 0
  }

  function runDetector() {
    setRunning(true)
    setOutput(['> Initializing local policy engine...', '> Analyzing proposed agent tool call...'])

    setTimeout(() => {
      setOutput(prev => [...prev, `> Action Attempted: "${eventText}"`])
    }, 500)

    setTimeout(() => {
      setOutput(prev => [...prev, `> Telemetry Context: ${telemetry}`])
    }, 1000)

    setTimeout(() => {
      if (isMatched) {
        setOutput(prev => [
          ...prev,
          `> Policy MATCHED: ${selected.logic}`,
          `> BLOCKED: Applied local gate policy: ${selected.remedy} (${confidence}% security confidence)`
        ])
      } else {
        setOutput(prev => [
          ...prev,
          `> Policy NOT MATCHED: ${selected.logic}`,
          `> SUCCESS: Action falls within safe limits. Execution allowed.`
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

              {selected.key === 'destructive_cmd' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Command Danger Level</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: dangerLevel > 7 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {dangerLevel}/10 {dangerLevel > 7 && '(Critical)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={dangerLevel}
                      onChange={(e) => { setDangerLevel(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Blast Radius</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: blastRadius > 50 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {blastRadius}% {blastRadius > 50 && '(High)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      step="5"
                      value={blastRadius}
                      onChange={(e) => { setBlastRadius(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>
                </div>
              )}

              {selected.key === 'secret_leak' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Directory Depth</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: accessDepth > 5 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {accessDepth}/10 {accessDepth > 5 && '(System Dir)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={accessDepth}
                      onChange={(e) => { setAccessDepth(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                    <span style={{ color: 'var(--gray-400)' }}>Credential File (.env, key)</span>
                    <input
                      type="checkbox"
                      checked={isCredential}
                      onChange={(e) => { setIsCredential(e.target.checked); setOutput([]); }}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--accent)', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}

              {selected.key === 'incident_repeat' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Recursion Stack Depth</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: stackDepth > 4 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {stackDepth}/10 {stackDepth > 4 && '(Deep Recursion)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={stackDepth}
                      onChange={(e) => { setStackDepth(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--gray-400)' }}>Change Risk Score</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono), monospace', color: riskScore > 1.0 ? 'var(--accent-text)' : 'var(--white)' }}>
                        {riskScore.toFixed(1)}/3.0 {riskScore > 1.0 && '(High Risk)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="3.0"
                      step="0.1"
                      value={riskScore}
                      onChange={(e) => { setRiskScore(Number(e.target.value)); setOutput([]); }}
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
          <div style={{ background: '#0a0a0a', padding: '2rem', fontFamily: 'var(--font-geist-mono), monospace', display: 'flex', flexDirection: 'column', gap: '1.5rem', minHeight: '320px' }}>
            <div style={{ color: '#777777', fontSize: '0.75rem', borderBottom: '1px solid #2a2a2a', paddingBottom: '1rem', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <span>// Telemetry context pack:</span>
              <span style={{ color: '#ff6600' }}>{telemetry}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', flex: 1 }}>
              {output.length === 0 && (
                <div style={{ color: '#666666', fontStyle: 'italic', fontSize: '0.85rem' }}>
                  Adjust parameters on the left, then click "Run Detector" to see Mergen's diagnostic check in action.
                </div>
              )}
              {output.map((line, i) => {
                const isSuccess = line.startsWith('> SUCCESS')
                const isHalted = line.startsWith('> HALTED')
                const isHeading = line.startsWith('>') && !isSuccess && !isHalted
                
                let textColor = '#777777'
                if (isSuccess) textColor = '#ff6600'
                else if (isHalted) textColor = '#ff6600'
                else if (isHeading) textColor = '#ff8c42'

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
              border: '1px solid #2a2a2a',
              background: '#111111',
              borderRadius: '4px',
              fontSize: '0.75rem',
            }}>
              <span style={{ color: '#888888' }}>Gateway Policy Match:</span>
              {isMatched ? (
                <span style={{ color: '#ff6600', fontWeight: 800 }}>✓ MATCHED (Blocked)</span>
              ) : (
                <span style={{ color: '#777777' }}>✗ UNMATCHED (Allowed)</span>
              )}
            </div>

            {output.length > 0 && !running && isMatched && (
              <div style={{
                border: '1px solid #1a1a0a',
                background: '#0a0a00',
                borderRadius: '4px',
                overflow: 'hidden',
                fontSize: '0.75rem',
              }}>
                <div style={{
                  background: '#2a1a00',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: '#ff8c42',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}>
                  <span>⚡</span> SLACK THREAD — what your team would see
                </div>
                <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ color: '#ff6600', minWidth: '16px' }}>🚨</span>
                    <div>
                      <span style={{ color: '#ffffff', fontWeight: 700 }}>Security Gateway Block</span>
                      <span style={{ color: '#666666' }}> — {selected.name.toLowerCase().replace(' ', '-')}</span>
                    </div>
                  </div>
                  <div style={{ paddingLeft: '1.5rem', color: '#888888', lineHeight: 1.7 }}>
                    <div>🚫 <span style={{ color: '#ff6600', fontWeight: 600 }}>Command Intercepted — Local Gate Engine</span></div>
                    <div style={{ color: '#666666' }}>→ Action: <span style={{ color: '#e2e8f0' }}>{
                      selected.key === 'destructive_cmd' ? `terraform destroy prod (danger=${dangerLevel}/10, blast=${blastRadius}%)` :
                      selected.key === 'secret_leak' ? `Read credential file: .env (depth=${accessDepth}/10, cred=${isCredential.toString()})` :
                      `Prisma schema migration stack depth ${stackDepth}/10 (risk=${riskScore.toFixed(1)}/3.0)`
                    }</span></div>
                    <div style={{ color: '#666666' }}>→ Rule: <code style={{ color: '#ff8c42', background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '2px' }}>{selected.remedy}</code></div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ minWidth: '16px' }}>🔒</span>
                    <span style={{ color: '#888888' }}>Gate intercept executed in <code style={{ color: '#ff6600' }}>&lt; 1ms</code></span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ minWidth: '16px' }}>✅</span>
                    <span style={{ color: '#ff6600', fontWeight: 700 }}>PREVENTED — Production protected. Blunder logged to git.</span>
                  </div>
                  <div style={{ color: '#333333', fontSize: '0.65rem', borderTop: '1px solid #2a2a2a', paddingTop: '0.5rem' }}>
                    actionBlocked=true · executionBlocked=true · logPath=~/.mergen/agent-blunders.json
                  </div>
                </div>
              </div>
            )}

            {output.length > 0 && !running && !isMatched && (
              <div style={{
                padding: '1rem',
                border: '1px solid #2a2a2a',
                background: '#111111',
                borderRadius: '4px',
                fontSize: '0.75rem',
                color: '#888888',
                lineHeight: 1.6,
              }}>
                <span style={{ color: 'var(--accent)' }}>Gate passed:</span>{' '}
                The inputs do not cross the policy threshold rules. The agent action was allowed to execute because it fell within safe boundaries. Raise the sliders above the threshold to see the security gate block the action.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
