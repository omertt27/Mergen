import Nav from '@/components/Nav'
import Architecture from '@/components/Architecture'
import EvalProof from '@/components/EvalProof'
import Footer from '@/components/Footer'

export default function ArchitecturePage() {
  return (
    <>
      <Nav />
      <main className="page-main">
        <div className="wrap">
          <div style={{ padding: '4rem 0 2rem' }}>
            <span className="section-label">Technical Deep Dive</span>
            <h1 style={{
              fontSize: 'clamp(2rem, 4vw, 3rem)',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              color: 'var(--white)',
              marginBottom: '1rem',
              marginTop: '0.75rem',
            }}>
              Architecture &amp; Evaluation
            </h1>
            <p style={{ color: 'var(--gray-600)', fontSize: '1.05rem', lineHeight: 1.7, maxWidth: 580 }}>
              How Mergen intercepts every tool call in under 1ms, and the deterministic
              test harness that validates every policy claim.
            </p>
          </div>
          <Architecture />
          <EvalProof />
        </div>
      </main>
      <Footer />
    </>
  )
}
