import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Mergen — Operational Memory for AI Agents'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#050505',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          fontFamily: 'sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Subtle accent glow */}
        <div
          style={{
            position: 'absolute',
            top: '-200px',
            right: '-200px',
            width: '600px',
            height: '600px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(165,243,252,0.06) 0%, transparent 70%)',
          }}
        />

        {/* Logo / wordmark */}
        <div
          style={{
            fontSize: '16px',
            fontWeight: 800,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: '#f0f0f0',
            marginBottom: '48px',
            display: 'flex',
          }}
        >
          MERGEN
        </div>

        {/* Headline */}
        <div
          style={{
            fontSize: '64px',
            fontWeight: 800,
            color: '#f0f0f0',
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            maxWidth: '800px',
            display: 'flex',
            flexWrap: 'wrap',
          }}
        >
          Operational Memory{' '}
          <span style={{ color: '#a5f3fc', display: 'flex' }}>for AI Agents.</span>
        </div>

        {/* Subline */}
        <div
          style={{
            fontSize: '22px',
            color: '#808080',
            marginTop: '32px',
            maxWidth: '720px',
            lineHeight: 1.5,
            display: 'flex',
          }}
        >
          Override Corpus · Agent Blunder Log · ≥85% confidence gate · Local-first
        </div>

        {/* Bottom tag */}
        <div
          style={{
            position: 'absolute',
            bottom: '48px',
            right: '80px',
            fontSize: '13px',
            color: '#67e8f9',
            fontFamily: 'monospace',
            display: 'flex',
          }}
        >
          mergen.dev
        </div>
      </div>
    ),
    size,
  )
}
