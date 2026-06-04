const plans = [
  {
    name: 'Free',
    price: '$0',
    period: '/mo',
    features: [
      '500 reasoning calls / month',
      '10 calls / hour burst cap',
      'Console, network & DOM capture',
      'Source map de-minification',
      'PII Shield — client-side masking',
    ],
    cta: 'Get Started',
    ctaClass: 'btn btn-outline',
  },
  {
    name: 'Pro',
    price: '$29',
    period: '/mo',
    features: [
      '2,000 reasoning calls / month',
      '$0.02 / call after quota · no burst cap',
      'WebSocket & SSE frame inspection',
      'React / Vue component tree',
      'OTLP export to any OTel collector',
      'Backend spans + trace correlation',
    ],
    cta: 'Get Pro',
    ctaClass: 'btn btn-white',
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Contact us',
    period: '',
    features: [
      'Everything in Pro, per seat',
      'Pooled credits across the team',
      'Team sync — shared debug context',
      'Priority support',
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
