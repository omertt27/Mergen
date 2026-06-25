import Nav from '@/components/Nav'
import Footer from '@/components/Footer'
import CodeBlock from '@/components/CodeBlock'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Install Mergen — Choose Your Method',
  description: 'Multiple ways to install Mergen depending on your preferences and environment.',
}

interface InstallStep {
  label: string
  code: string
}

interface InstallMethod {
  icon: string
  num: string
  title: string
  tag: string
  best: string
  time: string
  steps: InstallStep[]
}

const methods: InstallMethod[] = [
  {
    icon: '🤖',
    num: '01',
    title: 'Claude Code',
    tag: 'Easiest — Recommended',
    best: 'Direct integration with Claude Code via MCP',
    time: '< 1 minute',
    steps: [
      { label: 'Register with Claude Code', code: 'claude mcp add mergen-local -- npx @mergen/mcp index ./docs/postmortems' },
      { label: 'Verify connection', code: 'claude -c "ask mergen to explain_service(\'your-service\')"' },
    ],
  },
  {
    icon: '🚀',
    num: '02',
    title: 'NPM / NPX',
    tag: 'Universal',
    best: 'Any MCP-compatible IDE (Cursor, Windsurf, VS Code)',
    time: '~2 minutes',
    steps: [
      { label: 'Start indexing local docs', code: 'npx @mergen/mcp index ./docs' },
      { label: 'Run as persistent server', code: 'npx @mergen/mcp start' },
    ],
  },
  {
    icon: '🐳',
    num: '03',
    title: 'Docker',
    tag: 'Zero Dependencies',
    best: 'Containerised environments, consistent deployments',
    time: '~1 minute',
    steps: [
      { label: 'Pull and run', code: 'docker run -v $(pwd)/docs:/docs @mergen/mcp index /docs' },
    ],
  },
  {
    icon: '🔧',
    num: '04',
    title: 'Manual Setup',
    tag: 'Developers',
    best: 'Contributors, local development',
    time: '~5 minutes',
    steps: [
      {
        label: 'Clone and build',
        code: 'git clone https://github.com/omertt27/Mergen.git\ncd Mergen\nnpm install\nnpm run build',
      },
    ],
  },
]

const troubleshooting = [
  {
    q: '"Command not found: claude"',
    steps: ['npm install -g @anthropic-ai/claude-code'],
  },
  {
    q: '"Mergen index failed: no documents found"',
    steps: ['Ensure your postmortems are in .md format', 'Check the directory path provided to the index command'],
  },
  {
    q: '"IDE not showing Mergen tools"',
    steps: [
      '# Restart your IDE after setup',
      '# Verify MCP config file exists:',
      '# Cursor:    ~/.cursor/mcp.json',
      '# VS Code:   ~/.vscode/mcp.json',
    ],
  },
]

export default function InstallPage() {
  return (
    <>
      <Nav />
      <div className="notion-page-container">
        {/* Cover Photo */}
        <div className="notion-page-cover" style={{ background: 'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)' }} />
        
        {/* Emoji overlay */}
        <div className="notion-page-emoji-container">
          <span className="notion-page-emoji">🏁</span>
        </div>

        <main className="wrap notion-page-content">
          
          {/* ── Header ── */}
          <div style={{ marginBottom: '4rem' }}>
            <span className="section-label">Install</span>
            <h1 style={{ fontSize: 'clamp(2.5rem, 8vw, 6rem)', marginBottom: '2rem' }}>
              Choose Your<br />Method
            </h1>
            <p style={{ maxWidth: 600, color: 'var(--gray-400)', fontSize: '1.15rem', lineHeight: 1.7 }}>
              Multiple ways to install Mergen depending on your preferences and environment.
              Start with Method 1 for the smoothest experience.
            </p>
          </div>

        {/* ── Method cards ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginBottom: '8rem' }}>
          {methods.map((m) => (
            <div key={m.num} className="install-card">
              <div className="install-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                  <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>{m.icon}</span>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                      <span className="install-num">{m.num}</span>
                      <h3 className="install-title">{m.title}</h3>
                      <span className="install-tag">{m.tag}</span>
                    </div>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Best for: {m.best}</p>
                  </div>
                </div>
                <div className="install-time">
                  <span style={{ color: 'var(--gray-600)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Time</span>
                  <span style={{ color: 'var(--accent-text)', fontFamily: 'var(--font-geist-mono)', fontSize: '0.85rem' }}>{m.time}</span>
                </div>
              </div>

              <div className="install-card-body">
                {m.steps.map((s, i) => (
                  <CodeBlock key={i} code={s.code} label={s.label} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* ── Verify ── */}
        <div style={{ marginBottom: '8rem' }}>
          <span className="section-label">Verify</span>
          <h2 style={{ marginBottom: '3rem' }}>Check Your<br />Installation</h2>
          <CodeBlock
            code={`mergen-server --version\nmergen-server test\nmergen-server start`}
            label="Run after any install method"
            style={{ maxWidth: 700 }}
          />
          <div className="terminal" style={{ maxWidth: 700, marginTop: '2rem', transform: 'none' }}>
            <div className="terminal-header">
              <div className="terminal-dots">
                <span /><span /><span />
              </div>
              <span className="terminal-title">Expected output</span>
            </div>
            <div className="terminal-body" style={{ minHeight: 'auto', padding: '1.5rem 2rem' }}>
              {[
                { cls: 'success', text: '✓ Server binary exists' },
                { cls: 'success', text: '✓ Server starts successfully' },
                { cls: 'success', text: '✓ Health endpoint responds' },
                { cls: 'success', text: '✓ Event ingestion works' },
                { cls: 'success', text: '✓ IDE configured correctly' },
                { cls: 'system', text: '' },
                { cls: 'system', text: '✨ Mergen is ready to use!' },
              ].map((l, i) => (
                <div key={i} className={`terminal-line ${l.cls}`}>{l.text}</div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Comparison table ── */}
        <div style={{ marginBottom: '8rem' }}>
          <span className="section-label">Compare</span>
          <h2 style={{ marginBottom: '3rem' }}>Methods at<br />a Glance</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="compare-table">
              <thead>
                <tr>
                  {['Method', 'Time', 'Dependencies', 'Updates', 'Best For'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['NPM', '2 min', 'Node.js', 'Auto', 'Most users'],
                  ['Docker', '1 min', 'Docker', 'Manual', 'Containers'],
                  ['Homebrew', '3 min', 'None', 'brew upgrade', 'Mac users'],
                  ['Binary', '2 min', 'None', 'Manual download', 'No Node.js'],
                  ['Source', '5 min', 'Node.js, Git', 'git pull', 'Developers'],
                  ['One-liner', '2 min', 'curl + bash', 'Re-run script', 'Automation'],
                ].map(([method, ...rest], i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--white)', fontWeight: 600 }}>{method}</td>
                    {rest.map((v, j) => <td key={j}>{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Troubleshooting ── */}
        <div style={{ marginBottom: '8rem' }}>
          <span className="section-label">Troubleshooting</span>
          <h2 style={{ marginBottom: '3rem' }}>Common<br />Issues</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {troubleshooting.map((t, i) => (
              <details key={i} className="trouble-item">
                <summary className="trouble-q">{t.q}</summary>
                <CodeBlock code={t.steps.join('\n')} style={{ margin: '1rem 0 0' }} />
              </details>
            ))}
          </div>
        </div>

        {/* ── Next steps ── */}
        <div>
          <span className="section-label">Next Steps</span>
          <h2 style={{ marginBottom: '3rem' }}>You&apos;re Ready.<br />Start Debugging.</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '3rem' }}>
            {[
              { step: '01', title: 'Start server', cmd: 'mergen-server start' },
              { step: '02', title: 'Open your AI IDE', cmd: 'Cursor / Claude Code / VS Code' },
              { step: '03', title: 'Ask your AI', cmd: '"Get recent logs"' },
              { step: '04', title: 'Web UI (optional)', cmd: 'http://127.0.0.1:3000/setup' },
            ].map((s) => (
              <div key={s.step} className="feature-card" style={{ gridColumn: 'unset', padding: '2rem' }}>
                <span className="feature-num">{s.step}</span>
                <div className="feature-title" style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>{s.title}</div>
                <code style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>{s.cmd}</code>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <a href="https://github.com/omertt27/Mergen" className="btn btn-white">GitHub</a>
            <a href="https://github.com/omertt27/Mergen/issues" className="btn btn-outline">Report an Issue</a>
          </div>

          <div style={{ marginTop: '3rem', paddingTop: '3rem', borderTop: '1px solid var(--gray-800)' }}>
            <p style={{ fontSize: '0.75rem', color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: '1rem' }}>Security</p>
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
              {[
                'No data leaves your machine',
                'Server runs on localhost only (127.0.0.1)',
                'Open source (MIT license)',
                'No cloud services, no analytics',
              ].map((note) => (
                <span key={note} style={{ color: 'var(--gray-400)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: '#4ade80' }}>✓</span> {note}
                </span>
              ))}
            </div>
          </div>
        </div>

      </main>
      <Footer />
      </div>
    </>
  )
}
