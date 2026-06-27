import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Terminal from '@/components/Terminal'
import CausalCanvas from '@/components/CausalCanvas'
import LegacyVsMergen from '@/components/LegacyVsMergen'
import Features from '@/components/Features'
import EvalProof from '@/components/EvalProof'
import Integrations from '@/components/Integrations'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <>
      <Nav />
      <main className="page-main">
        <div className="wrap">
          <Hero />
          <Terminal />
          
          <section id="visualizer" style={{ marginTop: '8rem', marginBottom: '8rem' }}>
            <span className="section-label">02 // Visual Audit Trail</span>
            <h2>
              I don't understand my
              <br />
              own system anymore.
            </h2>
            <p style={{ color: 'var(--gray-600)', fontSize: '1rem', lineHeight: 1.7, maxWidth: 580, marginBottom: '2.5rem' }}>
              Side projects grow large and complex, leading to a forgotten mental model of runtime behavior.
              Mergen maps out an auto-generated, living graph of how your services actually communicate and behave
              at runtime—providing the visual audit trail of agent activity.
            </p>
            <CausalCanvas />
          </section>

          <LegacyVsMergen />
          <Features />
          <EvalProof />
          <Integrations />
          <Pricing />
        </div>
      </main>
      <Footer />
    </>
  )
}
