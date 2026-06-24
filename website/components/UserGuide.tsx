'use client'

import { useState } from 'react'

const steps = [
  {
    num: '01',
    title: 'Start the local gate',
    tag: 'zero config · Node.js 18+',
    body: 'Run one command. Mergen starts the local policy gate and binds to 127.0.0.1:3000. Every MCP tool call your AI agent makes now passes through the gate before execution.',
    code: 'npx mergen-server',
    note: 'Verify the gate is live: curl http://127.0.0.1:3000/health → { "ok": true, "gate": "active" }',
  },
  {
    num: '02',
    title: 'Define Safety Policies',
    tag: 'JSON rules · local config',
    body: 'Create a local policy file. Define matching patterns for commands that must be blocked outright, and commands that require human-in-the-loop (HITL) approval.',
    code: `{
  "block_rules": [
    { "pattern": "terraform destroy", "action": "BLOCK" },
    { "pattern": "rm -rf", "action": "BLOCK" }
  ],
  "hitl_rules": [
    { "pattern": "prisma migrate", "action": "HOLD" }
  ]
}`,
    note: 'Safety policies are loaded locally and evaluated deterministically in <1ms.',
  },
  {
    num: '03',
    title: 'Add to Your AI IDE',
    tag: 'Claude Code · Cursor · VS Code',
    body: 'Register Mergen as an MCP gateway server in your AI editor. The gateway wraps stdio transport, intercepting all tool calls before they run.',
    code: `# Add to Claude Code configuration
claude mcp add mergen --transport stdio -- npx mergen-server

# Or register as an execution gate wrapper in Cursor/VS Code`,
    note: 'Ask your agent: "delete the logs folder" — the local gateway intercepts and blocks it.',
  },
  {
    num: '04',
    title: 'Build the Override Corpus',
    tag: 'shadow mode · corpus enforcement',
    body: 'Run in shadow mode to analyze agent requests without active blocking, building your repository\'s specific operational DNA. Switch to active enforcement once verified.',
    code: `# Run in shadow mode (audit actions, no blocking)
MERGEN_SHADOW_MODE=true npx mergen-server

# Retrieve blocked actions from the blunder log
curl http://127.0.0.1:3000/agent-blunders`,
    note: 'Blocked actions are recorded in the blunder log at ~/.mergen/agent-blunders.json with a secure hash chain.',
  },
]

function StepCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block-container">
      <pre className="guide-step-code"><code>{code}</code></pre>
      <button className="copy-btn guide-copy-btn" onClick={handleCopy} aria-label="Copy code">
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
  )
}

export default function UserGuide() {
  return (
    <section id="guide">
      <span className="section-label">06 // Getting Started</span>
      <h2>
        Gate running in 60 seconds.
        <br />
        Pilot success: first blocked action logged.
      </h2>

      <div className="guide-steps mt-lg">
        {steps.map((step) => (
          <div key={step.num} className="guide-step">
            <div className="guide-step-header">
              <span className="guide-step-num">{step.num}</span>
              <div>
                <span className="tag">{step.tag}</span>
                <h3 className="guide-step-title">{step.title}</h3>
              </div>
            </div>
            <p className="guide-step-body">{step.body}</p>
            <StepCode code={step.code} />
            <p className="guide-step-note">{step.note}</p>
          </div>
        ))}
      </div>

      <div className="guide-cta">
        <a href="/guide" className="btn btn-outline">
          Full Install Guide →
        </a>
        <a href="mailto:hello@mergen.dev" className="btn-ghost">
          Define your pilot success criteria →
        </a>
      </div>
    </section>
  )
}