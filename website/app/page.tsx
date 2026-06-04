import CausalCanvas from '@/components/CausalCanvas'
import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Terminal from '@/components/Terminal'
import Architecture from '@/components/Architecture'
import Features from '@/components/Features'
import Integrations from '@/components/Integrations'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <>
      <CausalCanvas />
      <Nav />
      <main className="wrap">
        <Hero />
        <Terminal />
        <Architecture />
        <Features />
        <Integrations />
        <Pricing />
      </main>
      <Footer />
    </>
  )
}
