'use client'

import { useState } from 'react'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'
import CodeBlock from '@/components/CodeBlock'

const sections = [
  { id: 'quickstart', label: 'Quick Start' },
  { id: 'causaljoin', label: 'How It Works' },
  { id: 'integrations', label: 'Stack Integrations' },
  { id: 'corpus', label: 'Override Corpus' },
  { id: 'ide', label: 'AI IDE Setup' },
  { id: 'autopilot', label: 'Trust Architecture' },
  { id: 'cli', label: 'CLI Reference' },
  { id: 'troubleshoot', label: 'Troubleshooting' },
]

export default function GuidePage() {
  const [activeSection, setActiveSection] = useState('quickstart')
  const [searchTerm, setSearchTerm] = useState('')
  const [openTroubleIndex, setOpenTroubleIndex] = useState<number | null>(null)

  const troubleshootingItems = [
    {
      q: '"Command not found: claude"',
      ans: 'This means Anthropic\'s Claude Code is not installed in your global NPM environment. Fix it by running:',
      code: 'npm install -g @anthropic-ai/claude-code',
    },
    {
      q: '"Mergen index failed: no documents found"',
      ans: 'Mergen parser expects markdown (.md) documents representing postmortems or service specs. Check your path format and verify files exist in the target directory:',
      code: 'ls -la ./docs/postmortems',
    },
    {
      q: '"IDE not showing Mergen tools"',
      ans: 'Your IDE caches active MCP configs. Restart your IDE window. If tools still don\'t show up, inspect the configuration file directly depending on your editor:',
      code: '# Cursor:\ncat ~/.cursor/mcp.json\n\n# VS Code:\ncat ~/.vscode/mcp.json',
    },
    {
      q: '"OTLP spans not arriving at port 4318"',
      ans: 'Ensure your server is started and listening. Verify port 4318 or 3000 is bindable on your local network interface:',
      code: 'curl -v http://127.0.0.1:3000/health',
    },
    {
      q: '"Autopilot action rejected by policy"',
      ans: 'By default, Mergen blocks execution if confidence is <85% or if no override playbook is matched. Verify confidence scores in ~/.mergen/audit.log.',
      code: 'tail -n 50 ~/.mergen/audit.log',
    },
  ]

  const filteredTroubleshooting = troubleshootingItems.filter(
    (item) =>
      item.q.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.ans.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <>
      <Nav />
      <div className="notion-page-container">
        {/* Cover Photo */}
        <div className="notion-page-cover" style={{ background: 'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)' }} />
        
        <main className="wrap notion-page-content" style={{ minHeight: '100vh' }}>
          
          {/* ── Header ── */}
          <div style={{ marginBottom: '4rem' }}>
            <span className="section-label">Developer Hub</span>
          <h1 style={{ fontSize: 'clamp(2.5rem, 8vw, 6rem)', marginBottom: '1.5rem', lineHeight: 0.95 }}>
            Mergen<br />Developer Guide
          </h1>
          <p style={{ maxWidth: 700, color: 'var(--gray-400)', fontSize: '1.15rem', lineHeight: 1.7 }}>
            Learn how Mergen converts engineering activity — incidents resolved, overrides made, Slack postmortems written — into machine-readable operational memory that compounds in value with every resolution.
          </p>
        </div>

        {/* ── side-by-side Layout ── */}
        <div className="guide-layout" style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '4rem', alignItems: 'start' }}>
          
          {/* ── Left Navigation Sidebar ── */}
          <aside style={{ position: 'sticky', top: '120px', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--gray-600)', marginBottom: '1rem', fontWeight: 700 }}>
              Sections
            </span>
            {sections.map((sec) => (
              <button
                key={sec.id}
                onClick={() => {
                  setActiveSection(sec.id)
                }}
                className={`guide-nav-btn ${activeSection === sec.id ? 'active' : ''}`}
                style={{
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  padding: '0.75rem 1rem',
                  fontSize: '0.85rem',
                  fontWeight: activeSection === sec.id ? '600' : '400',
                  color: activeSection === sec.id ? 'var(--accent-text)' : 'var(--gray-400)',
                  cursor: 'pointer',
                  borderLeft: activeSection === sec.id ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'all 0.2s',
                  display: 'block',
                  width: '100%',
                }}
              >
                {sec.label}
              </button>
            ))}
            <div style={{ marginTop: '2rem', borderTop: '1px solid var(--gray-800)', paddingTop: '1.5rem' }}>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-600)', marginBottom: '0.5rem' }}>Need support?</p>
              <a href="mailto:hello@mergen.dev" style={{ fontSize: '0.8rem', color: 'var(--accent-text)', textDecoration: 'underline' }}>
                Contact developers →
              </a>
            </div>
          </aside>

          {/* ── Right Content Panel ── */}
          <section className="guide-content-panel" style={{ minWidth: 0 }}>
            
            {/* ── QUICKSTART SECTION ── */}
            {activeSection === 'quickstart' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>Quick Start</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Mergen is designed to be running locally on your workstation in under 2 minutes. 
                  It correlates logs, tracks telemetry streams, and serves as an operational context provider for your AI environment.
                </p>

                <div className="install-card" style={{ marginBottom: '2rem' }}>
                  <div className="install-card-header">
                    <div>
                      <span className="install-num">Step 01</span>
                      <h3 className="install-title">Run Sample Sandbox</h3>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', marginTop: '0.25rem' }}>No configuration required. Instantly see Mergen in action.</p>
                    </div>
                  </div>
                  <div className="install-card-body">
                    <CodeBlock 
                      code="npx mergen-server" 
                      label="Spin up server with public postmortem samples"
                    />
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', marginTop: '1rem', lineHeight: 1.6 }}>
                      This starts a local server on port 3000 and hosts a demo console at{' '}
                      <a href="http://localhost:3000/demo" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)', textDecoration: 'underline' }}>
                        http://localhost:3000/demo
                      </a>.
                      Click <strong>"Trigger P1 Incident"</strong> to see how it automatically maps stack traces.
                    </p>
                  </div>
                </div>

                <div className="install-card" style={{ marginBottom: '2rem' }}>
                  <div className="install-card-header">
                    <div>
                      <span className="install-num">Step 02</span>
                      <h3 className="install-title">IDE Configuration</h3>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', marginTop: '0.25rem' }}>Integrate the MCP server into your AI coding tool.</p>
                    </div>
                  </div>
                  <div className="install-card-body">
                    <CodeBlock 
                      code="npx mergen-server@latest setup" 
                      label="Run interactive assistant"
                    />
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', marginTop: '1rem', lineHeight: 1.6 }}>
                      This scans your workstation, detects available AI clients (Claude Code, Cursor, VS Code, Windsurf) and automatically appends the MCP configuration structure.
                    </p>
                  </div>
                </div>

                <div style={{ background: 'rgba(255, 85, 0, 0.03)', border: '1px solid rgba(255, 85, 0, 0.15)', borderRadius: '4px', padding: '1.5rem', marginTop: '2rem' }}>
                  <h4 style={{ color: 'var(--accent-text)', fontSize: '0.95rem', marginBottom: '0.5rem', fontWeight: 600 }}>Pilot Success Goal</h4>
                  <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                    The primary objective of a trial is <strong>one successful local triage of a real production/staging failure</strong>. Once Mergen maps a real incident inside your system, the verification phase is complete.
                  </p>
                </div>
              </div>
            )}

            {/* ── HOW IT WORKS ── */}
            {activeSection === 'causaljoin' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>How Operational Memory Works</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Traditional observability tools notify humans after a crash. Mergen compounds the knowledge of how your team resolves crashes, feeding it directly into the developer loop to prevent repetition. Every incident, override, and postmortem makes the system smarter about your specific infrastructure.
                </p>

                <h3 style={{ color: 'var(--white)', fontSize: '1.1rem', marginBottom: '1.25rem', fontWeight: 600 }}>Three input sources build the knowledge graph</h3>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.5rem', marginBottom: '3rem' }}>
                  <div style={{ border: '1px solid var(--gray-800)', borderRadius: '4px', padding: '1.5rem', background: 'var(--surface)' }}>
                    <h4 style={{ color: 'var(--white)', marginBottom: '0.5rem' }}>Production Telemetry</h4>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                      OTel traces, Docker logs, PagerDuty webhooks, and CI results stream into the ring buffer. Every event is tagged, fingerprinted, and made queryable by your AI IDE.
                    </p>
                  </div>
                  <div style={{ border: '1px solid var(--gray-800)', borderRadius: '4px', padding: '1.5rem', background: 'var(--surface)' }}>
                    <h4 style={{ color: 'var(--white)', marginBottom: '0.5rem' }}>Slack Postmortems</h4>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                      The Slack override loop scans your incident channel every 6 hours, extracting operational constraints from postmortem threads and converting them into Override Corpus entries automatically.
                    </p>
                  </div>
                  <div style={{ border: '1px solid var(--gray-800)', borderRadius: '4px', padding: '1.5rem', background: 'var(--surface)' }}>
                    <h4 style={{ color: 'var(--white)', marginBottom: '0.5rem' }}>Git History & ADRs</h4>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                      The git ADR sync scans commit history and Architecture Decision Records daily, materialising operational constraints as durable override policies without engineers doing extra work.
                    </p>
                  </div>
                </div>

                <h3 style={{ color: 'var(--white)', fontSize: '1.1rem', marginBottom: '1.25rem', fontWeight: 600 }}>The Three-Layer Trust Architecture</h3>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                  Before any autonomous action executes, Mergen applies three layers in order. Human policy always wins over model confidence.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--gray-800)', borderRadius: '4px', overflow: 'hidden', marginBottom: '2rem' }}>
                  {[
                    { layer: 'Layer 3', label: 'Hard Safety Policies', desc: 'Unconditional, immutable guardrails defined by your platform team — "never restart the database automatically, regardless of confidence." These override any model-derived decision. No amount of high confidence bypasses them.', color: '#ef4444' },
                    { layer: 'Layer 2', label: 'Customer Calibration', desc: 'Platt scaling trained on your team\'s specific incident history. As engineers tag diagnoses (correct / wrong / partial) via the IDE panel, confidence scores calibrate to your infrastructure within 20–50 events.', color: '#f59e0b' },
                    { layer: 'Layer 1', label: 'Global Prior', desc: 'Out-of-the-box heuristic detectors for common failure patterns. Provides immediate value on Day 1 with no historical data required.', color: '#4ade80' },
                  ].map((l, i) => (
                    <div key={i} style={{ padding: '1.5rem', borderBottom: i < 2 ? '1px solid var(--gray-800)' : 'none', background: 'var(--surface)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.7rem', color: l.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{l.layer}</span>
                        <strong style={{ color: 'var(--white)', fontSize: '0.95rem' }}>{l.label}</strong>
                      </div>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.6, margin: 0 }}>{l.desc}</p>
                    </div>
                  ))}
                </div>

                <div style={{ background: 'rgba(255, 85, 0, 0.03)', border: '1px solid rgba(255, 85, 0, 0.15)', borderRadius: '4px', padding: '1.5rem' }}>
                  <h4 style={{ color: 'var(--accent-text)', fontSize: '0.95rem', marginBottom: '0.5rem', fontWeight: 600 }}>The Disappear Test</h4>
                  <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                    When we ask design partners "If Mergen disappeared tomorrow, what would stop working?", the answer we're aiming for: <strong style={{ color: 'var(--white)' }}>"Our AI agents and engineers would lose access to years of operational knowledge."</strong>
                  </p>
                </div>
              </div>
            )}

            {/* ── STACK INTEGRATIONS ── */}
            {activeSection === 'integrations' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>Stack Integrations</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Connect your live application layers to Mergen to feed active telemetry directly to your workspace.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                  
                  {/* Docker */}
                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                      <h3 style={{ color: 'var(--white)', margin: 0 }}>Docker Daemon</h3>
                      <span className="install-tag">Easiest</span>
                    </div>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
                      Register local container environments to capture stderr/stdout lines and translate exceptions instantly:
                    </p>
                    <CodeBlock 
                      code="curl -X POST http://127.0.0.1:3000/watchers/docker" 
                      label="Command (Runs daemon listener)"
                    />
                  </div>

                  {/* OpenTelemetry */}
                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <h3 style={{ color: 'var(--white)', marginBottom: '1.5rem' }}>OpenTelemetry (OTLP)</h3>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
                      Configure standard OTel log exporters in your microservices to transmit traces directly to localhost:
                    </p>
                    <CodeBlock 
                      code="OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js" 
                      label="Launch environment node.js parameter"
                    />
                  </div>

                  {/* PagerDuty */}
                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <h3 style={{ color: 'var(--white)', marginBottom: '1.5rem' }}>PagerDuty Alerts</h3>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
                      To trigger automatic triage whenever a P1 incident fires, configure a webhook inside PagerDuty:
                    </p>
                    <ol style={{ paddingLeft: '1.25rem', color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 2 }}>
                      <li>Open PagerDuty and navigate to your target Service integrations page.</li>
                      <li>Click <strong>Add generic webhook (V3)</strong>.</li>
                      <li>Set Webhook URL: <code>https://YOUR_SERVER:3000/webhooks/pagerduty</code>.</li>
                      <li>Subscribe to <code>incident.triggered</code> events.</li>
                    </ol>
                  </div>

                  {/* Slack Override Loop */}
                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                      <h3 style={{ color: 'var(--white)', margin: 0 }}>Slack Postmortem Loop</h3>
                      <span className="install-tag">Knowledge Compounding</span>
                    </div>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
                      Auto-scan your incident channel every 6 hours. Mergen extracts operational constraints from postmortem threads and adds them to the Override Corpus automatically — no extra work from engineers.
                    </p>
                    <CodeBlock
                      code={`MERGEN_SLACK_BOT_TOKEN=xoxb-...\nMERGEN_SLACK_CHANNEL=#incidents\nMERGEN_SLACK_OVERRIDE_LOOP=true mergen-server start`}
                      label="Environment variables"
                    />
                  </div>

                  {/* Git ADR Sync */}
                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                      <h3 style={{ color: 'var(--white)', margin: 0 }}>Git History & ADR Sync</h3>
                      <span className="install-tag">Knowledge Compounding</span>
                    </div>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
                      Scan git commit history and Architecture Decision Records daily. Your historical engineering decisions become machine-readable policy in the Override Corpus.
                    </p>
                    <CodeBlock
                      code="MERGEN_GIT_ADR_SYNC=true mergen-server start"
                      label="Environment variable"
                    />
                  </div>

                </div>
              </div>
            )}

            {/* ── OVERRIDE CORPUS ── */}
            {activeSection === 'corpus' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>Override Corpus</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  The Override Corpus is your infrastructure's operational DNA — a queryable record of every human override, context-dependent constraint, and system quirk your team has ever encoded. It builds automatically from incidents, Slack postmortems, and git history. After six months: your Friday settlement windows, compliance holds, on-call preferences — structured, queryable, and impossible to replicate from a standing start.
                </p>

                <div className="install-card" style={{ marginBottom: '2rem' }}>
                  <div className="install-card-header">
                    <div>
                      <span className="install-num">Query</span>
                      <h3 className="install-title">Inspect What Mergen Has Learned</h3>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', marginTop: '0.25rem' }}>The corpus grows automatically — no manual entry required.</p>
                    </div>
                  </div>
                  <div className="install-card-body">
                    <CodeBlock
                      code="curl http://127.0.0.1:3000/override-corpus"
                      label="Returns all accumulated override patterns"
                    />
                  </div>
                </div>

                <h3 style={{ color: 'var(--white)', fontSize: '1.1rem', marginBottom: '1.25rem', fontWeight: 600 }}>How the corpus builds</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '2.5rem' }}>
                  {[
                    { src: 'Human override at incident time', detail: "When an engineer changes the suggested fix or adds a constraint (\"don't restart during settlement window\"), it's encoded as policy immediately." },
                    { src: 'Slack postmortem scan (every 6 hours)', detail: 'MERGEN_SLACK_OVERRIDE_LOOP extracts operational constraints from incident channel threads automatically.' },
                    { src: 'Git history + ADR commits (daily)', detail: 'MERGEN_GIT_ADR_SYNC scans commit messages and ADR documents for operational decisions.' },
                    { src: 'CI/CD pipeline results', detail: 'Failed builds and blocked PRs feed back into the corpus as risk signals for future similar changes.' },
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: '1rem', padding: '1rem 1.5rem', border: '1px solid var(--gray-800)', borderRadius: '4px', background: 'var(--surface)' }}>
                      <span style={{ color: 'var(--accent-text)', fontFamily: 'var(--font-geist-mono)', fontSize: '0.75rem', fontWeight: 700, minWidth: '1rem', paddingTop: '0.1rem' }}>{i + 1}</span>
                      <div>
                        <strong style={{ color: 'var(--white)', fontSize: '0.9rem', display: 'block', marginBottom: '0.25rem' }}>{item.src}</strong>
                        <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.5, margin: 0 }}>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="install-card" style={{ marginBottom: '2rem' }}>
                  <div className="install-card-header">
                    <div>
                      <span className="install-num">CI Gate</span>
                      <h3 className="install-title">Block Dangerous PRs Before Merge</h3>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', marginTop: '0.25rem' }}>The GitHub Action checks every PR against the corpus and blocks corpus conflicts before merge.</p>
                    </div>
                  </div>
                  <div className="install-card-body">
                    <pre className="code-block" style={{ fontSize: '0.75rem', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
{`# .github/workflows/mergen-gate.yml
- uses: mergenapp/mergen-server@v1
  with:
    mergen-url: \${{ secrets.MERGEN_URL }}
    mergen-secret: \${{ secrets.MERGEN_SECRET }}
    fail-on-block: 'true'`}
                    </pre>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', marginTop: '1rem', lineHeight: 1.6 }}>
                      Outputs: <code>verdict</code> (pass / warn / block), <code>risk-score</code> (0–100), and <code>reasons</code> — a JSON array of corpus conflicts found in the changed files.
                    </p>
                  </div>
                </div>

                <div style={{ background: 'rgba(255, 85, 0, 0.03)', border: '1px solid rgba(255, 85, 0, 0.15)', borderRadius: '4px', padding: '1.5rem' }}>
                  <h4 style={{ color: 'var(--accent-text)', fontSize: '0.95rem', marginBottom: '0.5rem', fontWeight: 600 }}>Agent Blunder Log</h4>
                  <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                    Every time the corpus blocks an autonomous action, the event is recorded. <code>GET /agent-blunders</code> shows the full intercept history — types: <code>allowlist_block</code>, <code>override_corpus_block</code>, <code>planning_gate_block</code>, and more. This is the audit trail that answers "why would you trust an AI agent with prod?"
                  </p>
                </div>
              </div>
            )}

            {/* ── AI IDE SETUP ── */}
            {activeSection === 'ide' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>AI IDE Setup</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Register Mergen as a Model Context Protocol (MCP) server so your AI agent can query incident telemetry directly when fixing code.
                </p>

                <div className="install-card" style={{ marginBottom: '2rem' }}>
                  <div className="install-card-header">
                    <h3 className="install-title">Anthropic Claude Code</h3>
                  </div>
                  <div className="install-card-body">
                    <CodeBlock
                      code={`# Guided setup — auto-detects your IDE\nmergen-server setup\n\n# Or manually:\nclaude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"`}
                      label="Add MCP server"
                    />
                  </div>
                </div>

                <div className="install-card" style={{ marginBottom: '2rem' }}>
                  <div className="install-card-header">
                    <h3 className="install-title">Cursor / VS Code Configuration</h3>
                  </div>
                  <div className="install-card-body">
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1rem' }}>
                      Open <strong>Settings → Features → MCP</strong> and add a new server with the following specs, or append to your workspace configuration manually:
                    </p>
                    <pre className="code-block" style={{ fontSize: '0.75rem', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
{`{
  "mcpServers": {
    "mergen": {
      "command": "npx",
      "args": ["mergen-server", "start"]
    }
  }
}`}
                    </pre>
                  </div>
                </div>

                <h3 style={{ color: 'var(--white)', fontSize: '1.25rem', marginBottom: '1rem' }}>Available AI Tools</h3>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                  Once registered, the following tools appear automatically in your AI agent\'s toolbox:
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {[
                    { name: 'triage_incident', desc: 'Full autonomous loop on demand — diagnosis, optional fix, validation, and Slack thread reply.' },
                    { name: 'analyze_runtime', desc: 'Causal analysis against the Override Corpus — root cause and fix hint, no execution.' },
                    { name: 'validate_fix', desc: 'Compare error counts before and after a fix. Records verdict to the calibration corpus.' },
                    { name: 'execute_fix', desc: 'Execute a specific hypothesis fix (requires confirm: true and passes Layer 3 safety check).' },
                    { name: 'get_recent_logs', desc: 'Console events from the ring buffer, filterable by severity and service.' },
                    { name: 'get_unified_timeline', desc: 'Browser request joined to backend span — exact causal join across the full stack.' },
                  ].map((tool) => (
                    <div key={tool.name} style={{ border: '1px solid var(--gray-800)', borderRadius: '2px', padding: '1rem 1.5rem', background: '#0a0a0a' }}>
                      <span style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent-text)', fontWeight: 600 }}>{tool.name}()</span>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', marginTop: '0.25rem' }}>{tool.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── TRUST ARCHITECTURE ── */}
            {activeSection === 'autopilot' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>Trust Architecture</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Start in Shadow Mode. It diagnoses incidents, posts recommendations to Slack, and builds the Override Corpus — all without touching production. Autopilot is opt-in once the corpus has established a track record and your Hard Safety Policies are configured.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginBottom: '3rem' }}>
                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                      <h3 style={{ color: 'var(--white)', margin: 0, fontSize: '1.1rem' }}>Shadow Mode</h3>
                    </div>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.6, marginBottom: '1rem' }}>
                      Diagnoses incidents, logs recommendations, and posts outcomes to Slack — without applying fixes. Builds the Override Corpus and calibration history while your team stays in control.
                    </p>
                    <CodeBlock
                      code="MERGEN_SHADOW_MODE=true mergen-server start"
                      label="Recommended starting point"
                    />
                  </div>

                  <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                      <h3 style={{ color: 'var(--white)', margin: 0, fontSize: '1.1rem' }}>Autopilot</h3>
                    </div>
                    <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.6, marginBottom: '1rem' }}>
                      Opt-in autonomous resolution. Hard Safety Policies are checked first — unconditionally. Then confidence must reach ≥85% against the calibrated corpus before any fix executes.
                    </p>
                    <CodeBlock
                      code="MERGEN_AUTOPILOT=true mergen-server start"
                      label="Enable after corpus is established"
                    />
                  </div>
                </div>

                <div style={{ border: '1px solid var(--gray-800)', padding: '2rem', borderRadius: '4px', background: 'var(--surface)', marginBottom: '1.5rem' }}>
                  <h3 style={{ color: 'var(--white)', marginBottom: '1rem' }}>Before any autonomous action runs</h3>
                  <ul style={{ paddingLeft: '1.25rem', color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 2, marginTop: '0.75rem' }}>
                    <li><strong style={{ color: 'var(--white)' }}>Layer 3 check:</strong> Hard Safety Policies are evaluated first. If the action matches a policy block, it stops — no confidence score overrides this.</li>
                    <li><strong style={{ color: 'var(--white)' }}>Override Corpus check:</strong> If a similar action was overridden by a human in the same context, Mergen pauses and surfaces the prior decision.</li>
                    <li><strong style={{ color: 'var(--white)' }}>Confidence gate:</strong> Platt-scaled score must be ≥85%. Below that, a human reviewer is alerted instead.</li>
                    <li><strong style={{ color: 'var(--white)' }}>Audit trail:</strong> Every decision — executed or blocked — is recorded in <code>~/.mergen/audit.log</code>.</li>
                  </ul>
                </div>

                <div style={{ background: 'rgba(255, 85, 0, 0.03)', border: '1px solid rgba(255, 85, 0, 0.15)', borderRadius: '4px', padding: '1.5rem' }}>
                  <h4 style={{ color: 'var(--accent-text)', fontSize: '0.95rem', marginBottom: '0.5rem', fontWeight: 600 }}>Configure Hard Safety Policies</h4>
                  <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                    On first start, Mergen writes a default policy file at <code>~/.mergen/safety-policy.json</code>. Edit it to add unconditional blocks specific to your infrastructure — services that must never be restarted automatically, deployment windows, compliance holds. These are checked before any model output.
                  </p>
                </div>
              </div>
            )}

            {/* ── CLI REFERENCE ── */}
            {activeSection === 'cli' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>CLI Command Reference</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Manage the local Mergen telemetry daemon using the terminal controls.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  {[
                    { cmd: 'mergen-server start', desc: 'Starts the telemetry daemon server on background port 3000.' },
                    { cmd: 'mergen-server stop', desc: 'Terminates active background server instances safely.' },
                    { cmd: 'mergen-server status', desc: 'Queries running daemon, ports bindings, and total events in memory queue.' },
                    { cmd: 'mergen-server test', desc: 'Simulates a mock incident end-to-end to verify integrations and triggers.' },
                    { cmd: 'mergen-server setup', desc: 'Interactive console assistant that writes MCP configs into your IDE folder path.' },
                  ].map((cli) => (
                    <div key={cli.cmd} style={{ borderBottom: '1px solid var(--gray-800)', paddingBottom: '1.5rem' }}>
                      <code style={{ fontSize: '1rem', color: 'var(--white)', display: 'block', marginBottom: '0.5rem', fontFamily: 'var(--font-geist-mono)' }}>
                        $ {cli.cmd}
                      </code>
                      <p style={{ color: 'var(--gray-400)', fontSize: '0.875rem' }}>{cli.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── TROUBLESHOOTING ── */}
            {activeSection === 'troubleshoot' && (
              <div>
                <h2 style={{ fontSize: '2rem', marginBottom: '1.5rem', color: 'var(--white)' }}>Troubleshooting</h2>
                <p style={{ color: 'var(--gray-400)', lineHeight: 1.7, marginBottom: '2rem' }}>
                  Find fixes for common workspace setups, configuration warnings, or integration hiccups.
                </p>

                {/* Search box */}
                <div style={{ position: 'relative', marginBottom: '2rem' }}>
                  <input
                    type="text"
                    placeholder="Search issues (e.g. 'mcp', 'port', 'command')..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'var(--surface)',
                      border: '1px solid var(--gray-800)',
                      borderRadius: '4px',
                      padding: '0.85rem 1.25rem',
                      color: 'var(--white)',
                      fontSize: '0.9rem',
                      outline: 'none',
                    }}
                  />
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      style={{
                        position: 'absolute',
                        right: '1.25rem',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        color: 'var(--gray-600)',
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {filteredTroubleshooting.map((t, idx) => (
                    <div
                      key={idx}
                      className="trouble-item"
                      style={{
                        border: '1px solid var(--gray-800)',
                        borderRadius: '4px',
                        background: '#0d0d0d',
                        overflow: 'hidden',
                      }}
                    >
                      <button
                        onClick={() => setOpenTroubleIndex(openTroubleIndex === idx ? null : idx)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          padding: '1.25rem 1.75rem',
                          color: 'var(--white)',
                          fontSize: '0.9rem',
                          fontWeight: '600',
                          fontFamily: 'var(--font-geist-mono)',
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span>{t.q}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--gray-600)' }}>
                          {openTroubleIndex === idx ? '▲' : '▼'}
                        </span>
                      </button>
                      
                      {openTroubleIndex === idx && (
                        <div style={{ padding: '0 1.75rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.03)', marginTop: '0.5rem' }}>
                          <p style={{ color: 'var(--gray-400)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1rem', marginTop: '1rem' }}>
                            {t.ans}
                          </p>
                          <CodeBlock code={t.code} style={{ margin: '0' }} />
                        </div>
                      )}
                    </div>
                  ))}

                  {filteredTroubleshooting.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '3rem', border: '1px dashed var(--gray-800)', borderRadius: '4px' }}>
                      <p style={{ color: 'var(--gray-600)', fontSize: '0.9rem' }}>No results match "{searchTerm}"</p>
                      <button onClick={() => setSearchTerm('')} style={{ background: 'none', border: 'none', color: 'var(--accent-text)', textDecoration: 'underline', marginTop: '0.5rem', cursor: 'pointer' }}>
                        Reset search filters
                      </button>
                    </div>
                  )}
                </div>

              </div>
            )}

          </section>

        </div>

      </main>
      <Footer />
      </div>
    </>
  )
}
