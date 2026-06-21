'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: '[03:17] PagerDuty → incident.triggered: "api-service HIGH error rate"', type: 'event', delay: 0 },
  { text: 'Fetching trace context...', type: 'log', delay: 700 },
  { text: 'Running causal analysis across 847 telemetry events...', type: 'log', delay: 500 },
  { text: '', type: 'gap', delay: 200 },
  { text: 'Consulting override corpus for api-service...', type: 'system', delay: 400 },
  { text: '  ✓ No matching override pattern — proceeding', type: 'success', delay: 300 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Root cause: JWT middleware rejecting valid tokens (91% confidence)', type: 'system', delay: 600 },
  { text: 'Deploy a3f8c12 · auth/middleware.ts in changed files · 4m before spike', type: 'log', delay: 300 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Autopilot executing fix (remediation confidence: 88%)', type: 'system', delay: 500 },
  { text: '  npm install jsonwebtoken@9.0.0 && pm2 restart api', type: 'success', delay: 300 },
  { text: '', type: 'gap', delay: 1200 },
  { text: 'Validating... error count: 14 → 0', type: 'system', delay: 400 },
  { text: '✅ RESOLVED — MTTR: 5m 23s · resolvedAutonomously=true', type: 'success', delay: 300 },
  { text: 'Agent Blunder Log: 0 blocks this incident', type: 'log', delay: 200 },
  { text: 'Posting audit trail to #incidents thread...', type: 'log', delay: 400 },
]

export default function Terminal() {
  const [visibleLines, setVisibleLines] = useState<typeof lines>([])
  const [index, setIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)

  useEffect(() => {
    if (!isPlaying) return

    if (index >= lines.length) {
      const timer = setTimeout(() => {
        setVisibleLines([])
        setIndex(0)
      }, 8000)
      return () => clearTimeout(timer)
    }

    const timer = setTimeout(() => {
      setVisibleLines(prev => [...prev, lines[index]])
      setIndex(index + 1)
    }, lines[index].delay / speed)

    return () => clearTimeout(timer)
  }, [index, isPlaying, speed])

  function handlePlayPause() {
    setIsPlaying(!isPlaying)
  }

  function handleRestart() {
    setVisibleLines([])
    setIndex(0)
    setIsPlaying(true)
  }

  function handleStep() {
    if (index < lines.length) {
      setVisibleLines(prev => [...prev, lines[index]])
      setIndex(index + 1)
    }
  }

  return (
    <div className="terminal">
      <div className="terminal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <div className="terminal-dots">
            <span /> <span /> <span />
          </div>
          <div className="terminal-title">mergen — autonomous incident loop</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            onClick={handlePlayPause} 
            style={{ 
              background: 'transparent', 
              border: '1px solid #27272a', 
              color: '#a1a1aa', 
              fontSize: '10px', 
              padding: '2px 8px', 
              borderRadius: '2px', 
              cursor: 'pointer',
              fontFamily: 'var(--font-geist-mono), monospace'
            }}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          {!isPlaying && index < lines.length && (
            <button 
              onClick={handleStep} 
              style={{ 
                background: 'transparent', 
                border: '1px solid #27272a', 
                color: '#a1a1aa', 
                fontSize: '10px', 
                padding: '2px 8px', 
                borderRadius: '2px', 
                cursor: 'pointer',
                fontFamily: 'var(--font-geist-mono), monospace'
              }}
            >
              ⏭ Step
            </button>
          )}
          <button 
            onClick={handleRestart} 
            style={{ 
              background: 'transparent', 
              border: '1px solid #27272a', 
              color: '#a1a1aa', 
              fontSize: '10px', 
              padding: '2px 8px', 
              borderRadius: '2px', 
              cursor: 'pointer',
              fontFamily: 'var(--font-geist-mono), monospace'
            }}
          >
            ↺ Restart
          </button>
          <select 
            value={speed} 
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ 
              background: '#18181b', 
              border: '1px solid #27272a', 
              color: '#a1a1aa', 
              fontSize: '10px', 
              padding: '1px 4px', 
              borderRadius: '4px', 
              cursor: 'pointer',
              fontFamily: 'var(--font-geist-mono), monospace',
              outline: 'none'
            }}
          >
            <option value={1}>1x Speed</option>
            <option value={1.5}>1.5x Speed</option>
            <option value={2}>2x Speed</option>
          </select>
        </div>
      </div>
      <div className="terminal-body" style={{ minHeight: '450px' }}>
        {visibleLines.map((line, i) => (
          <div key={i} className={`terminal-line ${line.type}`}>
            {line.text}
            {i === visibleLines.length - 1 && <span className="terminal-cursor">_</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
