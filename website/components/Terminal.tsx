'use client'

import { useState, useEffect } from 'react'

const lines = [
  { text: 'mergen-node', type: 'system', delay: 0 },
  { text: '  📡 Listening for OTLP on :4318', type: 'log', delay: 500 },
  { text: '  🚀 Nexus dashboard ready on :3000', type: 'log', delay: 200 },
  { text: '', type: 'gap', delay: 400 },
  { text: '[EVENT] Capture triggered: Condition (status === 500)', type: 'event', delay: 800 },
  { text: '  📸 Snapshotting browser state...', type: 'log', delay: 300 },
  { text: '  🔗 Correlating OTel trace [3e1f...9b2]', type: 'log', delay: 400 },
  { text: '  🛡️  PII Shield: Redacted 2 entities (JWT, Email)', type: 'success', delay: 600 },
  { text: '  ✅ 12.4kb bundle streamed to MCP', type: 'success', delay: 200 },
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
