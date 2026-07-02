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
    name: 'Incident Re-occurrence Prevention',
    key: 'incident_repeat',
    logic: 'if (sqlite_matches > 0 && has_resolution_playbook === true)',
    remedy: 'inject_previous_fix_postmortem(incident-12)',
  },
]

export default function InteractiveSandbox() {
  const [selected, setSelected] = useState<Scenario>(scenarios[0])
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])

  // Scenario A State
  const [dangerLevel, setDangerLevel] = useState(8)
  const [blastRadius, setBlastRadius] = useState(65)

  // Scenario B State
  const [accessDepth, setAccessDepth] = useState(7)
  const [isCredential, setIsCredential] = useState(true)

  // Scenario C State
  const [sqliteMatches, setSqliteMatches] = useState(3)
  const [hasPlaybook, setHasPlaybook] = useState(true)

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
    isMatched = sqliteMatches > 0 && hasPlaybook
    telemetry = `Target path modified. Found ${sqliteMatches} SQLite outage logs. Playbook active: ${hasPlaybook.toString()}`
    eventText = `Agent encountered build/runtime error in workspace`
    confidence = isMatched ? Math.min(99, Math.round(85 + sqliteMatches * 2)) : 0
  }

  function runDetector() {
    setRunning(true)
    setOutput(['> Initializing local policy engine...', '> Analyzing proposed agent tool call...'])

    setTimeout(() => {
      setOutput(prev => [...prev, `> Action Attempted: "${eventText}"`])
    }, 400)

    setTimeout(() => {
      setOutput(prev => [...prev, `> Telemetry Context: ${telemetry}`])
    }, 800)

    setTimeout(() => {
      if (isMatched) {
        if (selected.key === 'incident_repeat') {
          setOutput(prev => [
            ...prev,
            `> Policy MATCHED: ${selected.logic}`,
            `> BLOCKED: Applied local gate policy: ${selected.remedy} (${confidence}% security confidence)`,
            `> Operational Memory Injection: "Incident #12 previously occurred on this path. Fix: increase pool_size to 20."`
          ])
        } else {
          setOutput(prev => [
            ...prev,
            `> Policy MATCHED: ${selected.logic}`,
            `> BLOCKED: Applied local gate policy: ${selected.remedy} (${confidence}% security confidence)`
          ])
        }
      } else {
        setOutput(prev => [
          ...prev,
          `> Policy NOT MATCHED: ${selected.logic}`,
          `> SUCCESS: Action falls within safe limits. Execution allowed.`
        ])
      }
      setRunning(false)
    }, 1200)
  }

  return (
    <section id="sandbox" style={{ borderBottom: 'none' }}>
      <span className="section-label">INTERACTIVE_SANDBOX</span>
      <h2>
        Verify the inline detection parameters
      </h2>

      <div className="sandbox-grid mt-lg" style={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        gap: '1px',
        background: 'var(--border-color)',
        border: '1px solid var(--border-color)',
      }}>
        {/* Responsive Grid Wrapper */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          width: '100%'
        }}>
          {/* Controls Panel */}
          <div style={{ background: 'var(--bg-card)', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div>
              <p style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: '1rem' }} className="font-mono">
                Select Target Scenario
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
                      background: selected.key === s.key ? 'var(--bg-hover)' : 'transparent',
                      border: '1px solid',
                      borderColor: selected.key === s.key ? 'var(--color-block)' : 'var(--border-color)',
                      color: selected.key === s.key ? 'var(--text-bold)' : 'var(--text-muted)',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      borderRadius: '0px',
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Slider Adjustments Panel */}
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
              <p style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: '1.25rem' }} className="font-mono">
                Adjust Telemetry Inputs
              </p>

              {selected.key === 'destructive_cmd' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--text-main)' }}>Command Danger Level</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: dangerLevel > 7 ? 'var(--color-block)' : 'var(--text-bold)' }}>
                        {dangerLevel}/10 {dangerLevel > 7 && '(Critical)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={dangerLevel}
                      onChange={(e) => { setDangerLevel(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--color-block)' }}
                    />
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--text-main)' }}>Blast Radius</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: blastRadius > 50 ? 'var(--color-block)' : 'var(--text-bold)' }}>
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
                      style={{ width: '100%', accentColor: 'var(--color-block)' }}
                    />
                  </div>
                </div>
              )}

              {selected.key === 'secret_leak' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--text-main)' }}>Directory Depth</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: accessDepth > 5 ? 'var(--color-block)' : 'var(--text-bold)' }}>
                        {accessDepth}/10 {accessDepth > 5 && '(System Dir)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={accessDepth}
                      onChange={(e) => { setAccessDepth(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--color-block)' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                    <span style={{ color: 'var(--text-main)' }}>Credential File (.env, key)</span>
                    <input
                      type="checkbox"
                      checked={isCredential}
                      onChange={(e) => { setIsCredential(e.target.checked); setOutput([]); }}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--color-block)', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}

              {selected.key === 'incident_repeat' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                      <span style={{ color: 'var(--text-main)' }}>SQLite Outage Matches</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: sqliteMatches > 0 ? 'var(--color-block)' : 'var(--text-bold)' }}>
                        {sqliteMatches} {sqliteMatches > 0 && '(Outage Risk)'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="5"
                      value={sqliteMatches}
                      onChange={(e) => { setSqliteMatches(Number(e.target.value)); setOutput([]); }}
                      style={{ width: '100%', accentColor: 'var(--color-block)' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                    <span style={{ color: 'var(--text-main)' }}>Resolution Playbook Found</span>
                    <input
                      type="checkbox"
                      checked={hasPlaybook}
                      onChange={(e) => { setHasPlaybook(e.target.checked); setOutput([]); }}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--color-block)', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div>
              <button
                onClick={runDetector}
                disabled={running}
                className="btn-primary"
                style={{ width: '100%', padding: '12px', opacity: running ? 0.5 : 1, fontFamily: 'var(--font-mono)', cursor: 'pointer' }}
              >
                {running ? 'Evaluating Gateway...' : 'Run Safety Check →'}
              </button>
            </div>
          </div>

          {/* Terminal Output */}
          <div style={{ background: '#090a0c', padding: '2rem', fontFamily: 'var(--font-mono)', display: 'flex', flexDirection: 'column', gap: '1.5rem', minHeight: '320px' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <span>// Intercept telemetry payload:</span>
              <span style={{ color: 'var(--color-block)' }}>{telemetry}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', flex: 1 }}>
              {output.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.85rem' }}>
                  Adjust parameters on the left, then click "Run Safety Check" to trigger the local evaluation loop.
                </div>
              )}
              {output.map((line, i) => {
                const isSuccess = line.startsWith('> SUCCESS')
                const isBlocked = line.startsWith('> BLOCKED')
                const isHeading = line.startsWith('>') && !isSuccess && !isBlocked
                
                let textColor = 'var(--text-muted)'
                if (isSuccess) textColor = 'var(--color-pass)'
                else if (isBlocked) textColor = 'var(--color-block)'
                else if (isHeading) textColor = 'var(--text-bold)'

                return (
                  <div key={i} style={{
                    fontSize: '0.85rem',
                    color: textColor,
                    fontWeight: (isSuccess || isBlocked) ? 700 : 400,
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
              border: '1px solid var(--border-color)',
              background: 'var(--bg-card)',
              fontSize: '0.75rem',
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Gateway Policy Match:</span>
              {isMatched ? (
                <span style={{ color: 'var(--color-block)', fontWeight: 700 }}>✓ MATCHED (Blocked)</span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>✗ UNMATCHED (Allowed)</span>
              )}
            </div>

            {output.length > 0 && !running && isMatched && (
              <div style={{
                border: '1px solid var(--border-color)',
                background: 'var(--bg-card)',
                fontSize: '0.75rem',
              }}>
                <div style={{
                  background: 'var(--bg-hover)',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'var(--color-block)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}>
                  SLACK ALERTS — what your team sees
                </div>
                <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--color-block)', minWidth: '16px' }}>[!]</span>
                    <div>
                      <span style={{ color: 'var(--text-bold)', fontWeight: 700 }}>Security Gateway Block</span>
                      <span style={{ color: 'var(--text-muted)' }}> — {selected.name.toLowerCase().replace(' ', '-')}</span>
                    </div>
                  </div>
                  <div style={{ paddingLeft: '1.5rem', color: 'var(--text-muted)', lineHeight: 1.7 }}>
                    <div><span style={{ color: 'var(--color-block)', fontWeight: 600 }}>Command Intercepted — Local Gate Engine</span></div>
                    <div style={{ color: 'var(--text-muted)' }}>→ Action: <span style={{ color: 'var(--text-main)' }}>{
                      selected.key === 'destructive_cmd' ? `terraform destroy prod (danger=${dangerLevel}/10, blast=${blastRadius}%)` :
                      selected.key === 'secret_leak' ? `Read credential file: .env (depth=${accessDepth}/10, cred=${isCredential.toString()})` :
                      `SQLite match count: ${sqliteMatches} (playbook active: ${hasPlaybook.toString()})`
                    }</span></div>
                    <div style={{ color: 'var(--text-muted)' }}>→ Rule: <code style={{ color: 'var(--color-block)', background: 'var(--bg-hover)', padding: '1px 4px' }}>{selected.remedy}</code></div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
