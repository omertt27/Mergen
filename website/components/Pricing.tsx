const plans = [
  {
    name: 'Developer',
    price: '$0',
    period: '/mo',
    features: [
      '500 reasoning calls / month',
      'Chrome extension + browser capture',
      'Snapshot debugging (50 captures)',
      'PII Shield — client-side masking',
      'Standard MCP tools',
    ],
    cta: 'Join Waitlist',
    ctaClass: 'btn btn-outline',
  },
  {
    name: 'Solo Pro',
    price: '$29',
    period: '/mo',
    features: [
      'Unlimited reasoning calls',
      'Node.js + Python SDK instrumentation',
      'OTLP receiver — any OTel service',
      'Dynamic logpoints + trace correlation',
      'Devcontainer templates + Traefik ingress',
    ],
    cta: 'Start Free Trial',
    ctaClass: 'btn btn-white',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    features: [
      'Air-gapped OTLP pipeline',
      'Multi-tenant isolation + cost chargeback',
      'DLP-compliant PII redaction policies',
      'Audit log export + SIEM integration',
      'SSO / mTLS zero-trust gateway',
    ],
    cta: 'Contact Sales',
    ctaClass: 'btn btn-outline',
  },
]

export default function Pricing() {
  return (
    <section id="access">
      <span className="section-label">04 // Pricing</span>
      <h2>Start local.<br />Scale to enterprise.</h2>

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
            <a href="#" className={plan.ctaClass} style={{ display: 'block', textAlign: 'center' }}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  )
}
