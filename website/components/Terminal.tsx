'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: 'claude -c "analyze active incident with mergen"', type: 'system', delay: 0 },
  { text: 'Fetching incident context from PagerDuty...', type: 'log', delay: 800 },
  { text: '⚠️  Detected Incident #1294: "checkout-service latency spike"', type: 'event', delay: 400 },
  { text: 'Pulling Datadog trace for root cause analysis...', type: 'log', delay: 600 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Semantic Compactor: 412KB Trace → 1.2KB Fact Card', type: 'system', delay: 400 },
  { text: 'Root Cause Identified', type: 'system', delay: 400 },
  { text: 'Service: checkout-service', type: 'log', delay: 200 },
  { text: 'Error: Database connection pool exhausted (32/32 connections)', type: 'event', delay: 200 },
  { text: 'Trace Span: pg.connect (latency: 12.4s)', type: 'log', delay: 200 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Suggested Fix (Applied 14× in similar incidents):', type: 'system', delay: 400 },
  { text: 'kubectl scale deployment/checkout-db-pool --replicas=5', type: 'success', delay: 300 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Claude: "I have identified that the checkout service is hitting its DB pool limit. Scaling up the pool now."', type: 'log', delay: 800 },
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
        <div className="terminal-title">mergen — get_incident_context</div>
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
