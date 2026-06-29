'use client'

import { useSearchParams } from 'next/navigation'
import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'

function CLIAuthContent() {
  const searchParams = useSearchParams()
  const port = searchParams.get('port')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<'idle' | 'authorizing' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // Load key from localStorage if present
  useEffect(() => {
    const saved = localStorage.getItem('mergen-license-key')
    if (saved) {
      setToken(saved)
    }
  }, [])

  const handleAuthorize = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!token.trim()) {
      setErrorMsg('Please enter a valid license key.')
      setStatus('error')
      return
    }

    // Save key for future CLI logins
    localStorage.setItem('mergen-license-key', token.trim())
    setStatus('authorizing')
    setErrorMsg('')

    try {
      const targetPort = port ? parseInt(port, 10) : 3000
      const callbackUrl = `http://127.0.0.1:${targetPort}/callback?token=${encodeURIComponent(token.trim())}`
      
      // Perform JSONP or standard fetch (with CORS enabled on the local server callback)
      const res = await fetch(callbackUrl, { mode: 'cors' })
      if (res.ok) {
        setStatus('success')
      } else {
        throw new Error(`Local server responded with status: ${res.status}`)
      }
    } catch (err) {
      console.error(err)
      setErrorMsg(
        'Failed to connect to the local Mergen server. Please make sure the CLI is running and waiting for login.'
      )
      setStatus('error')
    }
  }

  const copyCommand = () => {
    const cmd = `npx mergen-server login --key ${token || 'YOUR_KEY'}`
    navigator.clipboard.writeText(cmd)
    alert('Command copied to clipboard!')
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      {/* Cover / Header Card */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--gray-800)',
        borderRadius: '12px',
        padding: '2.5rem',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Top orange glow effect */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '120px',
          height: '4px',
          background: 'var(--accent)',
          boxShadow: '0 0 20px var(--accent)',
          borderRadius: '0 0 4px 4px'
        }} />

        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <span style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            fontSize: '0.65rem',
            color: 'var(--accent-text)',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: '0.75rem'
          }}>
            CLI Authentication
          </span>
          <h2 style={{ fontSize: '1.6rem', fontWeight: 800, margin: 0, color: 'var(--white)', letterSpacing: '-0.02em' }}>
            Authorize Mergen CLI
          </h2>
          {port && (
            <p style={{ color: 'var(--gray-500)', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
              Attempting connection on local port <code style={{ color: 'var(--accent-text)', fontFamily: 'var(--font-geist-mono)' }}>{port}</code>
            </p>
          )}
        </div>

        {status === 'success' ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(34,197,94,0.1)',
              border: '1px solid #22c55e',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1.5rem',
              color: '#22c55e',
              fontSize: '1.75rem',
              boxShadow: '0 0 16px rgba(34,197,94,0.2)'
            }}>
              ✓
            </div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--white)', marginBottom: '0.5rem' }}>
              Successfully Authorized!
            </h3>
            <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', lineHeight: 1.6, marginBottom: '2rem' }}>
              The license key was securely sent to your local daemon. You can close this tab and return to your terminal window.
            </p>
            <button
              onClick={() => window.close()}
              className="btn btn-outline"
              style={{ width: '100%', fontSize: '0.8rem' }}
            >
              Close Tab
            </button>
          </div>
        ) : (
          <form onSubmit={handleAuthorize} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--gray-400)' }}>
                Mergen License Key
              </label>
              <input
                type="text"
                placeholder="mrgn_live_..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={status === 'authorizing'}
                style={{
                  background: '#0a0a0a',
                  border: '1px solid var(--gray-800)',
                  borderRadius: '6px',
                  color: 'var(--white)',
                  padding: '12px 14px',
                  fontSize: '0.85rem',
                  fontFamily: 'var(--font-geist-mono), monospace',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent)'}
                onBlur={(e) => e.target.style.borderColor = 'var(--gray-800)'}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--gray-500)', lineHeight: 1.4 }}>
                Find your key in the billing email or copy it from your web dashboard.
              </span>
            </div>

            {status === 'error' && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.08)',
                borderLeft: '3px solid #ef4444',
                padding: '0.75rem 1rem',
                borderRadius: '4px',
                color: '#ef4444',
                fontSize: '0.78rem',
                lineHeight: 1.5
              }}>
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'authorizing'}
              className="btn btn-white"
              style={{
                width: '100%',
                padding: '12px',
                fontSize: '0.82rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              {status === 'authorizing' ? 'Authorizing...' : 'Authorize CLI'}
            </button>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              margin: '0.5rem 0',
              color: 'var(--gray-600)'
            }}>
              <hr style={{ flex: 1, border: 'none', height: 1, background: 'var(--gray-800)' }} />
              <span style={{ padding: '0 10px', fontSize: '0.7rem', textTransform: 'uppercase', fontFamily: 'var(--font-geist-mono)' }}>or manual setup</span>
              <hr style={{ flex: 1, border: 'none', height: 1, background: 'var(--gray-800)' }} />
            </div>

            <div style={{ textAlign: 'center' }}>
              <p style={{ color: 'var(--gray-400)', fontSize: '0.75rem', lineHeight: 1.5, margin: '0 0 1rem' }}>
                If browser-based loopback fails (e.g. running inside Docker or SSH), run this command instead:
              </p>
              <div style={{
                background: '#0a0a0a',
                border: '1px solid var(--gray-800)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontFamily: 'var(--font-geist-mono), monospace',
                fontSize: '0.72rem',
                color: 'var(--accent-text)',
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflowX: 'auto',
                marginBottom: '1rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <span>npx mergen-server login --key {token ? `${token.substring(0, 12)}...` : 'YOUR_KEY'}</span>
                <button
                  type="button"
                  onClick={copyCommand}
                  style={{
                    background: 'var(--gray-800)',
                    border: 'none',
                    borderRadius: '4px',
                    color: 'var(--white)',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: '0.65rem',
                    marginLeft: '8px'
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default function CLIAuthPage() {
  return (
    <>
      <Nav />
      <div className="notion-page-container">
        <div className="notion-page-cover" style={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' }} />
        <main className="wrap notion-page-content" style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Suspense fallback={
            <div style={{ color: 'var(--gray-400)', fontSize: '0.85rem' }}>Loading CLI parameters...</div>
          }>
            <CLIAuthContent />
          </Suspense>
        </main>
        <Footer />
      </div>
    </>
  )
}
