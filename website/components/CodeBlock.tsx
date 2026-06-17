'use client'

import { useState } from 'react'

interface Props {
  code: string
  label?: string
  preClassName?: string
  style?: React.CSSProperties
}

export default function CodeBlock({ code, label, preClassName = 'code-block', style }: Props) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block-wrap" style={style}>
      {label && <span className="code-block-label">{label}</span>}
      <div className="code-block-container">
        <pre className={preClassName}><code>{code}</code></pre>
        <button className="copy-btn" onClick={handleCopy} aria-label="Copy code">
          {copied ? (
            <span className="copy-ok">✓</span>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}