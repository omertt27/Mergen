'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: 'mergen-server start', type: 'system', delay: 0 },
  { text: '  autopilot enabled · threshold 0.87 (ROC-optimized)', type: 'log', delay: 600 },
  { text: '', type: 'gap', delay: 300 },
  { text: '[INCIDENT] api-gateway · P1 · incident.triggered', type: 'event', delay: 900 },
  { text: '  causal analysis: OOMKilled · confidence 0.91', type: 'log', delay: 700 },
  { text: '  blast radius: deployment/api-gateway · downtime ~40s · reversible', type: 'log', delay: 500 },
  { text: '  tier: restart — executing automatically', type: 'log', delay: 400 },
  { text: '  kubectl rollout restart deployment/api-gateway', type: 'log', delay: 300 },
  { text: '  validating... error rate 4.2% → 0.1%', type: 'log', delay: 1200 },
  { text: '  verdict: RESOLVED · MTTR 38s', type: 'success', delay: 400 },
  { text: '  Slack thread updated · snapshot saved for replay', type: 'success', delay: 300 },
]

export default function Terminal() {
  const [visibleLines, setVisibleLines] = useState<typeof lines>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (index >= lines.length) {
      const timer = setTimeout(() => {
        setVisibleLines([])
        setIndex(0)
      }, 5000)
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
        <div className="terminal-title">mergen — status</div>
      </div>
      <div className="terminal-body">
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
