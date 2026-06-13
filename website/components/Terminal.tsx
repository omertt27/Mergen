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

  useEffect(() => {
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
    }, lines[index].delay)

    return () => clearTimeout(timer)
  }, [index])

  return (
    <div className="terminal">
      <div className="terminal-header">
        <div className="terminal-dots">
          <span /> <span /> <span />
        </div>
        <div className="terminal-title">mergen — autonomous incident loop</div>
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
