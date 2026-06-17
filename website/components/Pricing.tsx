const plans = [
  {
    name: 'Solo / Open Source',
    price: '$0',
    period: '/forever',
    pitch: 'Full autonomous loop on a single machine. No Datadog, no cloud, no card.',
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md',
    featured: false,
  },
  {
    name: 'Team',
    price: '$49',
    period: '/mo',
    pitch: 'Shared override corpus, MTTR dashboard, and per-service Slack routing for your whole team.',
    cta: 'Start Free Trial',
    ctaClass: 'btn btn-outline',
    href: 'mailto:hello@mergen.dev',
    featured: false,
  },
  {
    name: 'Enterprise',
    price: 'Contact',
    period: '',
    pitch: 'Self-hosted VPC, SSO + RBAC, SOC 2 exports, and a dedicated SLA.',
    cta: 'Contact Sales',
    ctaClass: 'btn btn-white',
    href: 'mailto:hello@mergen.dev',
    featured: true,
  },
]

type Cell = boolean | string

const matrix: { name: string; solo: Cell; team: Cell; enterprise: Cell }[] = [
  { name: 'All MCP tools (triage, analyze, validate)',  solo: true,     team: true,     enterprise: true },
  { name: 'Override corpus',                            solo: 'Local',  team: 'Shared', enterprise: 'Shared' },
  { name: 'Agent Blunder Log + audit trail',            solo: true,     team: true,     enterprise: true },
  { name: 'Shadow mode (30-day track record)',          solo: true,     team: true,     enterprise: true },
  { name: 'Shadow mode analytics PDF',                  solo: false,    team: true,     enterprise: true },
  { name: 'Per-service Slack routing',                  solo: false,    team: true,     enterprise: true },
  { name: 'Context-assisted MTTR dashboard',            solo: false,    team: true,     enterprise: true },
  { name: 'Self-hosted VPC deployment (TLS)',           solo: false,    team: false,    enterprise: true },
  { name: 'SSO + RBAC',                                solo: false,    team: false,    enterprise: true },
  { name: 'SOC 2 compliance exports',                   solo: false,    team: false,    enterprise: true },
  { name: 'Dedicated onboarding + SLA',                 solo: false,    team: false,    enterprise: true },
]

function Cell({ val }: { val: Cell }) {
  if (val === true)  return <span className="pm-check">✓</span>
  if (val === false) return <span className="pm-no">—</span>
  return <span className="pm-val">{val}</span>
}

export default function Pricing() {
  return (
    <section id="access">
      <span className="section-label">06 // Pricing</span>
      <h2>Start free.<br />Scale when the corpus does.</h2>

      {/* ── Price cards ── */}
      <div className="price-row mt-lg" style={{ maxWidth: '1100px', margin: '8rem auto 0' }}>
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`price-col${plan.featured ? ' price-col-featured' : ''}`}
          >
            <span className={`price-name${plan.featured ? ' price-name-featured' : ''}`}>
              {plan.name}
            </span>
            <div className="price-val">
              {plan.price}
              {plan.period && <span style={{ fontSize: '0.8rem' }}>{plan.period}</span>}
            </div>
            <p className="price-pitch">{plan.pitch}</p>
            <a href={plan.href} className={plan.ctaClass} style={{ display: 'block', textAlign: 'center' }}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>

      {/* ── Feature matrix ── */}
      <div style={{ maxWidth: '1100px', margin: '4rem auto 0', overflowX: 'auto' }}>
        <table className="pricing-matrix">
          <thead>
            <tr>
              <th style={{ width: '48%' }}>Feature</th>
              <th>Solo</th>
              <th>Team</th>
              <th>Enterprise</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map((row) => (
              <tr key={row.name}>
                <td style={{ color: 'var(--gray-400)' }}>{row.name}</td>
                <td><Cell val={row.solo} /></td>
                <td><Cell val={row.team} /></td>
                <td><Cell val={row.enterprise} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}