import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'

const SITE_URL = 'https://mergen.dev'
const TITLE = 'Mergen — Execution & Security Gateway for AI Agents'
const DESCRIPTION =
  'Mergen sits inline between AI agents and your systems, blocking unsafe actions, enforcing approval workflows, and creating auditable execution trails across development and production environments.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: 'website',
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Mergen',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Mergen — Operational Memory for AI Agents',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var theme = localStorage.getItem('mergen-theme') || 'light';
                document.documentElement.className = document.documentElement.className + ' notion-' + theme;
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
