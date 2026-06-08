const plans = [
  {
    name: 'Free',
    price: '$0',
    period: '/mo',
    features: [
      'Up to 25 incidents / month',
      'Full causal analysis (shadow mode)',
      'MCP tools: triage_incident, analyze_runtime',
      'PagerDuty, Slack, Docker, OTLP',
      'PII Shield + audit log',
    ],
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
    href: '/install',
  },
  {
    name: 'Pro',
    price: '$29',
    period: '/mo',
    features: [
      'Up to 200 incidents / month',
      '$50 overage ceiling — never more',
      'Autopilot execution (≥85% confidence)',
      'Auto-rollback + blast radius gate',
      'Override corpus + adaptive threshold',
      'Slack thread ownership',
    ],
    cta: 'Get Pro',
    ctaClass: 'btn btn-white',
    featured: true,
    href: 'https://mergen.lemonsqueezy.com/buy/solo-pro',
  },
  {
    name: 'Enterprise',
    price: 'Contact us',
    period: '',
    features: [
      'Unlimited incidents, per seat',
      'Shared override corpus across team',
      'SSO + RBAC + compliance exports',
      'Priority support + SLA + audit logs',
    ],
    cta: 'Contact Sales',
    ctaClass: 'btn btn-outline',
    href: 'mailto:hello@mergen.dev',
  },
]

export default function Pricing() {
  return (
    <section id="access">
      <span className="section-label">04 // Pricing</span>
      <h2>One command.<br />Full production memory.</h2>

      <div className="price-row mt-lg">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className="price-col"
            style={
              plan.featured
                ? {
                    background: '#080808',
                    borderColor: 'var(--accent)',
                    boxShadow: 'inset 0 0 50px rgba(165, 243, 252, 0.05)',
                  }
                : undefined
            }
          >
            <span
              className="price-name"
              style={plan.featured ? { color: 'var(--accent-text)' } : undefined}
            >
              {plan.name}
            </span>
            <div className="price-val">
              {plan.price}
              {plan.period && <span>{plan.period}</span>}
            </div>
            <ul className="price-list">
              {plan.features.map((f, i) => (
                <li
                  key={i}
                  style={plan.featured && i === 0 ? { color: 'var(--white)' } : undefined}
                >
                  {f}
                </li>
              ))}
            </ul>
            <a href={plan.href} className={plan.ctaClass} style={{ display: 'block', textAlign: 'center' }}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  )
}
