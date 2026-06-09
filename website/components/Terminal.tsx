'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: 'claude -c "ask mergen to explain_service(\'checkout-api\')"', type: 'system', delay: 0 },
  { text: 'Output Card:', type: 'log', delay: 800 },
  { text: 'Service Profile: checkout-api', type: 'system', delay: 400 },
  { text: 'Mergen corpus · 24 incidents · First: 2026-01-15 · Last: 2026-06-08', type: 'log', delay: 200 },
  { text: '', type: 'gap', delay: 100 },
  { text: '⚠️  1 open incident currently tracked', type: 'event', delay: 600 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Failure Modes', type: 'system', delay: 400 },
  { text: 'Mode                          Freq   Avg MTTR   Auto-resolved   Most Recent Verified Fix', type: 'log', delay: 200 },
  { text: 'db_connection_pool_exhausted  14×    12m        79%             kubectl scale...', type: 'log', delay: 100 },
  { text: 'redis_cache_timeout           4×     6m         100%            redis-cli -h cache.internal flushall', type: 'log', delay: 100 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Verified Fix Commands (ranked by usage)', type: 'system', delay: 400 },
  { text: 'kubectl scale deployment/checkout-db-pool --replicas=5 — applied 14×', type: 'success', delay: 300 },
  { text: '', type: 'gap', delay: 100 },
  { text: 'Co-occurring Services', type: 'system', delay: 400 },
  { text: 'payment-processor (12) · redis-cache (9)', type: 'log', delay: 300 },
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
        <div className="terminal-title">mergen — explain_service</div>
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
