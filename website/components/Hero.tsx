'use client'

export default function Hero() {
  return (
    <section className="hero">
      <span className="hero-eyebrow">
        Claude Code · Cursor · Windsurf · VS Code · MCP
      </span>
      <h1>Your Infrastructure<br />Has a Memory Problem.</h1>
      <p className="hero-sub">
        A local-first, zero-dependency MCP server that indexes your production postmortems, cloud configurations, and topology. Ground your AI coding assistants in real operational memory, stop debugging blind, and never resolve the same incident twice.
      </p>
      <div className="hero-actions">
        <div className="hero-command" onClick={() => navigator.clipboard.writeText('claude mcp add mergen-local -- npx @mergen/mcp index ./docs/postmortems')}>
          <code>claude mcp add mergen-local -- npx @mergen/mcp index ./docs/postmortems</code>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </div>
      </div>
      <div className="hero-badges">
        {['Local-first', '127.0.0.1 stdio bind', 'Read-only by default', 'No cloud account required'].map((b) => (
          <span key={b} className="hero-badge">✓ {b}</span>
        ))}
      </div>
    </section>
  )
}
