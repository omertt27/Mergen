import CausalCanvas from '@/components/CausalCanvas'
import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Features from '@/components/Features'
import Architecture from '@/components/Architecture'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <>
      <CausalCanvas />
      <Nav />
      <main className="wrap">
        <Hero />
        <Features />
        <Architecture />
        <Pricing />
      </main>
      <Footer />
    </>
  )
}
