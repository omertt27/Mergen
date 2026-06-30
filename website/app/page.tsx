import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import InterceptionGate from '@/components/InterceptionGate'
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
          <InterceptionGate />
          
          <section id="visualizer" className="visualizer-section">
            <span className="section-label">VISUAL_AUDIT_TRAIL</span>
            <h2 className="section-title">
              Map runtime service communication
            </h2>
            <p className="section-desc">
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

