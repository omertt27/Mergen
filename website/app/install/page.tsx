import Nav from '@/components/Nav'
import Footer from '@/components/Footer'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Install Mergen — Choose Your Method',
  description: 'Multiple ways to install Mergen depending on your preferences and environment.',
}

const methods = [
  {
    icon: '🚀',
    num: '01',
    title: 'NPM',
    tag: 'Easiest — Recommended',
    best: 'Quick setup, always latest version',
    time: '~2 minutes',
    steps: [
      { label: 'One command setup', code: 'npx mergen-server@latest setup' },
      { label: 'Or install globally', code: 'npm install -g mergen-server\nmergen-server setup' },
    ],
  },
  {
    icon: '🐳',
    num: '02',
    title: 'Docker',
    tag: 'Zero Dependencies',
    best: 'Containerised environments, consistent deployments',
    time: '~1 minute',
    steps: [
      { label: 'Pull and run', code: 'docker run -p 3000:3000 mergen/server:latest' },
      { label: 'Or with docker-compose', code: 'curl -O https://raw.githubusercontent.com/omertt27/Mergen/main/docker-compose.yml\ndocker-compose up' },
    ],
  },
  {
    icon: '🍺',
    num: '03',
    title: 'Homebrew',
    tag: 'macOS',
    best: 'Mac users who prefer native packages',
    time: '~3 minutes',
    steps: [
      { label: 'Add tap and install', code: 'brew tap omertt27/mergen\nbrew install mergen' },
      { label: 'Run setup', code: 'mergen-server setup' },
    ],
  },
  {
    icon: '📦',
    num: '04',
    title: 'Pre-Built Binary',
    tag: 'No Node.js Required',
    best: 'No Node.js, offline environments',
    time: '~2 minutes',
    downloads: [
      { label: 'macOS (Apple Silicon)', file: 'mergen-macos-arm64' },
      { label: 'macOS (Intel)', file: 'mergen-macos-x64' },
      { label: 'Linux', file: 'mergen-linux-x64' },
      { label: 'Windows', file: 'mergen-win-x64.exe' },
    ],
    steps: [
      { label: 'Make executable (Mac/Linux)', code: 'chmod +x mergen-macos-arm64' },
      { label: 'Run setup', code: './mergen-macos-arm64 setup' },
    ],
  },
  {
    icon: '🔧',
    num: '05',
    title: 'From Source',
    tag: 'Developers',
    best: 'Contributors, local development',
    time: '~5 minutes',
    steps: [
      {
        label: 'Clone and build',
        code: 'git clone https://github.com/omertt27/Mergen.git\ncd Mergen/server\nnpm install\nnpm run build',
      },
      { label: 'Run setup', code: 'node ../scripts/setup.mjs' },
    ],
  },
  {
    icon: '🌐',
    num: '06',
    title: 'One-Line Installer',
    tag: 'Quick Automated Setup',
    best: 'Quick automated setup',
    time: '~2 minutes',
    steps: [
      {
        label: 'Run in terminal',
        code: "curl -fsSL https://raw.githubusercontent.com/omertt27/Mergen/main/install.sh | bash",
      },
    ],
  },
]

const troubleshooting = [
  {
    q: '"Command not found: mergen-server"',
    steps: ['npx mergen-server@latest setup', './mergen-macos-arm64 setup  # binary path'],
  },
  {
    q: '"Port 3000 already in use"',
    steps: ['lsof -ti:3000 | xargs kill -9'],
  },
  {
    q: '"Server not responding"',
    steps: ['curl http://127.0.0.1:3000/health', 'mergen-server start'],
  },
  {
    q: '"IDE not showing Mergen tools"',
    steps: [
      '# Restart your IDE after setup',
      'mergen-server test',
      '# Cursor:    ~/.cursor/mcp.json',
      '# VS Code:   ~/.vscode/mcp.json',
      '# Windsurf:  ~/.codeium/windsurf/mcp_config.json',
    ],
  },
]

export default function InstallPage() {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: '8rem', paddingBottom: '8rem' }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: '6rem' }}>
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
                {'downloads' in m && m.downloads && (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--gray-600)', marginBottom: '0.75rem' }}>Download for your OS</p>
                    <div className="download-grid">
                      {m.downloads.map((d) => (
                        <a
                          key={d.file}
                          href={`https://github.com/omertt27/Mergen/releases/latest/download/${d.file}`}
                          className="download-btn"
                        >
                          {d.label}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {m.steps.map((s, i) => (
                  <div key={i} className="code-block-wrap">
                    <span className="code-block-label">{s.label}</span>
                    <pre className="code-block"><code>{s.code}</code></pre>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* ── Browser Extension ── */}
        <div style={{ marginBottom: '8rem' }}>
          <span className="section-label">Browser Extension</span>
          <h2 style={{ marginBottom: '3rem' }}>After Installing<br />the Server</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
            <div className="install-card">
              <div className="install-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <span style={{ fontSize: '1.3rem' }}>🏪</span>
                  <div>
                    <h3 className="install-title" style={{ marginBottom: '0.2rem' }}>Chrome Web Store</h3>
                    <p style={{ color: 'var(--accent-text)', fontSize: '0.8rem' }}>Recommended</p>
                  </div>
                </div>
              </div>
              <div className="install-card-body">
                <a
                  href="https://chrome.google.com/webstore/detail/mergen/xxx"
                  className="btn btn-white"
                  style={{ display: 'inline-block', marginBottom: '0.5rem' }}
                >
                  Add to Chrome
                </a>
              </div>
            </div>

            <div className="install-card">
              <div className="install-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <span style={{ fontSize: '1.3rem' }}>🔧</span>
                  <div>
                    <h3 className="install-title" style={{ marginBottom: '0.2rem' }}>Manual Install</h3>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.8rem' }}>Developer mode required</p>
                  </div>
                </div>
              </div>
              <div className="install-card-body">
                <ol style={{ paddingLeft: '1.25rem', color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 2 }}>
                  <li>Open <code>chrome://extensions</code></li>
                  <li>Enable <strong style={{ color: 'var(--white)' }}>Developer mode</strong> (top right)</li>
                  <li>Click <strong style={{ color: 'var(--white)' }}>Load unpacked</strong></li>
                  <li>Select the <code>extension/</code> folder</li>
                </ol>
              </div>
            </div>
          </div>
        </div>

        {/* ── Verify ── */}
        <div style={{ marginBottom: '8rem' }}>
          <span className="section-label">Verify</span>
          <h2 style={{ marginBottom: '3rem' }}>Check Your<br />Installation</h2>
          <div className="code-block-wrap" style={{ maxWidth: 700 }}>
            <span className="code-block-label">Run after any install method</span>
            <pre className="code-block"><code>{`mergen-server --version
mergen-server test
mergen-server start`}</code></pre>
          </div>
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
                <div className="code-block-wrap" style={{ margin: '1rem 0 0' }}>
                  <pre className="code-block"><code>{t.steps.join('\n')}</code></pre>
                </div>
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
    </>
  )
}
