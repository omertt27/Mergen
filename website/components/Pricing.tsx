const plans = [
  {
    name: 'Solo / Open Source',
    price: '$0',
    period: '/forever',
    pitch: 'Full autonomous loop on a single machine. No Datadog, no cloud, no card.',
    pilotCondition: null,
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md',
    featured: false,
  },
  {
    name: 'Team',
    price: '$299',
    period: '/mo',
    pitch: 'Shared operational memory, incident replay, and Slack ownership routing across up to 10 services.',
    pilotCondition: 'Pilot succeeds when Mergen correctly analyzes 1 real incident in your environment.',
    cta: 'Start Team Pilot →',
    ctaClass: 'btn btn-outline',
    href: 'mailto:hello@mergen.dev?subject=Team%20Pilot%20Request',
    featured: false,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    pitch: 'Policy-enforced autonomous remediation, compliance controls, VPC deployment, and audit exports — with a 30-day shadow pilot before any commitment.',
    pilotCondition: null,
    cta: 'Schedule a Pilot Call →',
    ctaClass: 'btn btn-white',
    href: 'mailto:hello@mergen.dev?subject=Enterprise%20Pilot%20Request',
    featured: true,
  },
]

type Cell = boolean | string

const matrix: { name: string; solo: Cell; team: Cell; enterprise: Cell }[] = [
  { name: 'Autonomous incident triage + fix',           solo: true,     team: true,     enterprise: true },
  { name: 'Operational memory (override corpus)',       solo: 'Local',  team: 'Shared', enterprise: 'Shared' },
  { name: 'Agent Blunder Log + audit trail',            solo: true,     team: true,     enterprise: true },
  { name: 'Shadow mode (30-day safety track record)',   solo: true,     team: true,     enterprise: true },
  { name: 'Incident replay + MTTR analytics',          solo: false,    team: true,     enterprise: true },
  { name: 'Slack ownership routing (up to 10 services)', solo: false,  team: true,     enterprise: true },
  { name: 'Shadow mode analytics PDF',                  solo: false,    team: true,     enterprise: true },
  { name: 'Policy-enforced autonomous remediation',     solo: false,    team: false,    enterprise: true },
  { name: 'VPC deployment + TLS',                      solo: false,    team: false,    enterprise: true },
  { name: 'SSO + RBAC + compliance controls',          solo: false,    team: false,    enterprise: true },
  { name: 'Audit exports (SOC 2)',                      solo: false,    team: false,    enterprise: true },
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
      <span className="section-label">07 // Pricing</span>
      <h2>Start free.<br />Prove value before you pay.</h2>

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
            {plan.pilotCondition && (
              <p style={{ fontSize: '0.72rem', color: 'var(--gray-400)', marginBottom: '1.25rem', fontStyle: 'italic', lineHeight: 1.5 }}>
                ✓ {plan.pilotCondition}
              </p>
            )}
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