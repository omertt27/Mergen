'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: '$ custom-agent --task "refactor connection pool & update auth routing"', type: 'event', delay: 0 },
  { text: 'Initializing workspace context in /Users/omer/Desktop/Mergen...', type: 'log', delay: 600 },
  { text: 'Analyzing database configuration and active dependencies...', type: 'log', delay: 500 },
  { text: '', type: 'gap', delay: 200 },
  { text: '[Tool Call] modify_file { file: "auth_middleware.ts" }', type: 'log', delay: 600 },
  { text: '  → Intercepting file mutation. Checking against repository history...', type: 'system', delay: 400 },
  { text: '  WARNING: This path was modified in incident #12 (auth loop crash).', type: 'error', delay: 300, isError: true },
  { text: '  Suggested remedy: "Ensure token expiration bounds check is included."', type: 'success', delay: 400 },
  { text: '', type: 'gap', delay: 100 },
  { text: '[Tool Call] run_command { command: "npm run build" }', type: 'log', delay: 600 },
  { text: '  → Execution output: Error: Connection pool exhausted (max 10)', type: 'error', delay: 300, isError: true },
  { text: '  → Intercepting runtime error. Querying SQLite incident corpus...', type: 'system', delay: 400 },
  { text: '  MERGEN HISTORY: This error occurred on 2026-05-14. You resolved it by', type: 'success', delay: 300 },
  { text: '  updating pool_size to 20 in /config/database.ts:32. Applying context...', type: 'success', delay: 200 },
  { text: '', type: 'gap', delay: 100 },
  { text: '[Tool Call] run_command { command: "terraform destroy -auto-approve" }', type: 'log', delay: 600 },
  { text: '  → Intercepting command execution gate...', type: 'system', delay: 400 },
  { text: '  BLOCKED: Destructive infrastructure teardown is prohibited by policy.', type: 'error', delay: 300, isError: true },
  { text: '', type: 'gap', delay: 100 },
  { text: 'TASK COMPLETE — 2 incidents prevented, 1 active postmortem context injected', type: 'success', delay: 300 },
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
              border: '1px solid #2a2a2a', 
              color: '#888888', 
              fontSize: '10px', 
              padding: '2px 8px', 
              borderRadius: '2px', 
              cursor: 'pointer',
              fontFamily: 'var(--font-geist-mono), monospace'
            }}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          {!isPlaying && index < lines.length && (
            <button 
              onClick={handleStep} 
              style={{ 
                background: 'transparent', 
                border: '1px solid #2a2a2a', 
                color: '#888888', 
                fontSize: '10px', 
                padding: '2px 8px', 
                borderRadius: '2px', 
                cursor: 'pointer',
                fontFamily: 'var(--font-geist-mono), monospace'
              }}
            >
              Step
            </button>
          )}
          <button 
            onClick={handleRestart} 
            style={{ 
              background: 'transparent', 
              border: '1px solid #2a2a2a', 
              color: '#888888', 
              fontSize: '10px', 
              padding: '2px 8px', 
              borderRadius: '2px', 
              cursor: 'pointer',
              fontFamily: 'var(--font-geist-mono), monospace'
            }}
          >
            Restart
          </button>
          <select 
            value={speed} 
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ 
              background: '#111111',
              border: '1px solid #2a2a2a',
              color: '#888888',
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
          <div key={i} className={`terminal-line ${line.type}`} style={(line as any).isError ? { color: '#ff6600' } : undefined}>
            {line.text}
            {i === visibleLines.length - 1 && <span className="terminal-cursor">_</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
