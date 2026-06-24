'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: '$ custom-agent --task "refactor connection pool & cleanup obsolete log files"', type: 'event', delay: 0 },
  { text: 'Initializing workspace context in /Users/omer/Desktop/Mergen...', type: 'log', delay: 600 },
  { text: 'Analyzing database configuration and active dependencies...', type: 'log', delay: 500 },
  { text: '', type: 'gap', delay: 200 },
  { text: '[Tool Call] run_command { command: "rm -rf /var/log/nginx/*" }', type: 'log', delay: 600 },
  { text: '  → Intercepting run_command tool execution...', type: 'system', delay: 400 },
  { text: '  🚫 BLOCKED: Destructive wildcard deletion outside workspace path is prohibited.', type: 'error', delay: 300, isError: true },
  { text: '', type: 'gap', delay: 100 },
  { text: '[Tool Call] read_file { path: "/Users/omer/Desktop/Mergen/.env" }', type: 'log', delay: 600 },
  { text: '  → Intercepting read_file tool execution...', type: 'system', delay: 400 },
  { text: '  🚫 BLOCKED: Access to credential files (.env) restricted by security policy.', type: 'error', delay: 300, isError: true },
  { text: '', type: 'gap', delay: 100 },
  { text: '[Tool Call] run_command { command: "npx prisma migrate dev" }', type: 'log', delay: 600 },
  { text: '  → Intercepting schema mutation command...', type: 'system', delay: 400 },
  { text: '  ⚠️ HOLD: Schema migration command requires manual HITL confirmation.', type: 'system', delay: 300 },
  { text: '  Fired Slack webhook. Issuing approval token: mrg-984f. Waiting for operator...', type: 'log', delay: 200 },
  { text: '  [Operator clicked APPROVE in Slack #alerts]', type: 'success', delay: 1200 },
  { text: '  ✅ APPROVED: Resuming execution gate...', type: 'success', delay: 400 },
  { text: 'Executing schema migration in isolated sandbox...', type: 'log', delay: 500 },
  { text: '✅ TASK COMPLETE — 0 security leaks, 2 blocked commands prevented', type: 'success', delay: 300 },
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
          <div key={i} className={`terminal-line ${line.type}`} style={(line as any).isError ? { color: '#ef4444' } : undefined}>
            {line.text}
            {i === visibleLines.length - 1 && <span className="terminal-cursor">_</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
