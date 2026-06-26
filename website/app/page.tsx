import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Terminal from '@/components/Terminal'
import LegacyVsMergen from '@/components/LegacyVsMergen'
import Features from '@/components/Features'
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
          <LegacyVsMergen />
          <Features />
          <Integrations />
          <Pricing />
        </div>
      </main>
      <Footer />
    </>
  )
}
