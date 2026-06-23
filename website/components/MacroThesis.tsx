'use client'

const problems = [
  {
    num: '01',
    title: 'Agents inherit full tool access with zero authorization',
    sub: 'Every MCP tool call is a potential production mutation.',
    desc: 'AI coding agents inherit the permissions of the engineer who started the server — which means they can call any tool, execute any command, and mutate any system state with zero scope, role check, or approval flow. An agent asked to "clean up old records" has the same tool access as one explicitly told to destroy infrastructure.',
  },
  {
    num: '02',
    title: 'Prompts are advisory — they are not enforcement',
    sub: 'System prompts are suggestions. LLMs ignore them under pressure.',
    desc: 'AI agents trained to be helpful will follow a system prompt instruction under normal conditions. Under adversarial prompt injection, jailbreak, or an unexpected context shift, they will not. The only reliable enforcement is a deterministic layer outside the LLM\'s reasoning path — one that physically intercepts the action before the handler runs.',
  },
  {
    num: '03',
    title: 'Monitoring is reactive — the breach already happened',
    sub: 'Datadog fires after the agent destroyed the environment.',
    desc: 'PagerDuty pages a human. Datadog shows what the agent did. By then the schema is migrated, the infrastructure is torn down, or the credentials are in the logs. An alert after the fact is not governance. Mergen is the inline gate that intercepts the tool call before any of that happens.',
  },
]

export default function MacroThesis() {
  return (
    <section id="thesis">
      <span className="section-label">02 // The Problem</span>
      <h2>
        AI agents can execute anything.
        <br />
        Nothing enforces what they&rsquo;re allowed to.
      </h2>

      <p style={{ maxWidth: '680px', color: 'var(--gray-400)', fontSize: '1.1rem', lineHeight: 1.7, marginBottom: '6rem' }}>
        Autonomous agents inherit full tool access with zero authorization checks.
        System prompts are probabilistic — they get ignored under pressure and adversarial injection.
        RAG policies in vector databases are advisory suggestions.
        None of them physically prevent a destructive command from reaching your infrastructure.
        Mergen does.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0', border: '1px solid var(--gray-800)' }}>
        {problems.map((f, i) => (
          <div
            key={f.num}
            style={{
              padding: '3rem',
              borderRight: i < problems.length - 1 ? '1px solid var(--gray-800)' : 'none',
              transition: 'background 0.3s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,85,0,0.02)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{
              fontFamily: 'var(--font-geist-mono), monospace',
              fontSize: '0.65rem',
              color: 'var(--accent-text)',
              letterSpacing: '0.1em',
              display: 'block',
              marginBottom: '1.5rem',
            }}>
              {f.num}
            </span>
            <h3 style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--white)',
              marginBottom: '0.5rem',
              lineHeight: 1.3,
            }}>
              {f.title}
            </h3>
            <p style={{
              fontSize: '0.75rem',
              fontFamily: 'var(--font-geist-mono), monospace',
              color: 'var(--accent-text)',
              marginBottom: '1.5rem',
              letterSpacing: '0.03em',
            }}>
              {f.sub}
            </p>
            <p style={{ color: 'var(--gray-400)', fontSize: '0.95rem', lineHeight: 1.7 }}>
              {f.desc}
            </p>
          </div>
        ))}
      </div>

      <div style={{
        border: '1px solid var(--gray-800)',
        borderTop: 'none',
        borderLeft: '4px solid var(--accent)',
        background: 'rgba(255, 85, 0, 0.02)',
        display: 'grid',
        gridTemplateColumns: '1fr 2fr',
        gap: '4rem',
        alignItems: 'flex-start',
        padding: '3rem',
      }}>
        <div>
          <span style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: '0.65rem',
            color: 'var(--accent-text)',
            letterSpacing: '0.1em',
            display: 'block',
            marginBottom: '1.5rem',
          }}>
            04
          </span>
          <h3 style={{
            fontSize: '1.1rem',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--white)',
            marginBottom: '0.5rem',
            lineHeight: 1.3,
          }}>
            CI pipelines have no agent governance layer
          </h3>
          <p style={{
            fontSize: '0.75rem',
            fontFamily: 'var(--font-geist-mono), monospace',
            color: 'var(--accent-text)',
            letterSpacing: '0.03em',
          }}>
            AI-generated PRs and deployments bypass human review at scale
          </p>
        </div>
        <p style={{ color: 'var(--gray-400)', fontSize: '0.95rem', lineHeight: 1.7, paddingTop: '2.5rem' }}>
          As agents generate pull requests and trigger deployments autonomously, your CI pipeline becomes a production mutation surface with no mandatory human checkpoint. Mergen&rsquo;s CI gate enforces deterministic blast-radius analysis and HITL approval before any autonomous change merges — the governance layer your pipeline is missing.
        </p>
      </div>

      <div style={{
        marginTop: '4rem',
        padding: '3rem',
        border: '1px solid var(--gray-800)',
        borderTop: '1px solid var(--accent)',
        background: 'rgba(255,85,0,0.03)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '4rem',
      }}>
        <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--white)', lineHeight: 1.4, maxWidth: '600px' }}>
          The missing layer is not more observability.
          It is a deterministic execution gate — one that physically intercepts agent actions before they reach your OS, terminal, or cloud provider, and enforces the policy your team has earned through every incident.
        </p>
        <a href="mailto:hello@mergen.dev" className="btn btn-white" style={{ flexShrink: 0 }}>
          Talk to us
        </a>
      </div>
    </section>
  )
}
