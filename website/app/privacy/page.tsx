import type { Metadata } from 'next'
import Nav from '@/components/Nav'
import Footer from '@/components/Footer'

export const metadata: Metadata = {
  title: 'Privacy Policy — Mergen',
  description: 'Mergen privacy policy. All data stays on 127.0.0.1 — nothing leaves your machine.',
}

const SECTIONS = [
  {
    title: 'Overview',
    body: `Mergen is a local-first developer tool. All telemetry captured by the browser extension is processed on your own machine and is never transmitted to any external server, cloud service, or third party. This policy explains what data is captured, where it goes, and how you control it.`,
  },
  {
    title: 'What the browser extension captures',
    body: `The Mergen Chrome and Firefox extensions capture the following events from browser tabs where you explicitly activate the extension:`,
    list: [
      'Console output (console.log, console.warn, console.error)',
      'Network requests made by the page (fetch, XMLHttpRequest) — URL, method, status code, duration, and response body',
      'DOM snapshots — page URL, active element, localStorage and sessionStorage keys (not values, unless opted in)',
      'HMR (hot module replacement) events from Vite and webpack dev servers',
      'WebSocket and Server-Sent Event frames',
    ],
    footer: 'The extension does NOT capture passwords, form input values, credit card numbers, or any data from browser tabs where Mergen is not actively enabled.',
  },
  {
    title: 'Where data goes',
    body: `All captured events are sent via HTTP POST to a local server running on your machine at http://127.0.0.1:3000. This address is only reachable from processes running on your own computer — it is not accessible from the internet, your local network, or any other device.`,
    list: [
      'No data is sent to Mergen servers',
      'No data is sent to any third-party analytics, logging, or monitoring service',
      'No data is stored in a database or file that persists beyond the current debugging session (events are held in a 2,000-event in-memory ring buffer and optionally in a local ~/.mergen/ session file)',
      'The ~/.mergen/ directory is stored on your local machine only',
    ],
  },
  {
    title: 'Source map de-minification',
    body: `When source maps are present in your project, Mergen reads them from your local filesystem to convert minified stack frames into readable file paths and line numbers. Source maps are never uploaded or transmitted.`,
  },
  {
    title: 'License and billing',
    body: `If you purchase a paid plan, your payment is processed by LemonSqueezy (our payment processor). Mergen receives only a license key and your email address to verify your subscription. Payment card details are handled entirely by LemonSqueezy and are never seen by Mergen. Your email is stored locally in ~/.mergen/license.json and is not shared with third parties.`,
  },
  {
    title: 'Optional telemetry',
    body: `Mergen includes an opt-in telemetry system that sends anonymous usage statistics once every 24 hours: server version, Node.js version, plan tier, and aggregate tool call counts (e.g. "analyze_runtime was called 3 times today"). No event content, error messages, URLs, or stack traces are included. Telemetry can be disabled by setting MERGEN_TELEMETRY=false in your environment.`,
  },
  {
    title: 'Calibration feedback',
    body: `When you rate a diagnosis ("Did this fix it?") in the dashboard, your feedback is stored locally in ~/.mergen/calibration.json. This file contains only the hypothesis tag, confidence score, and your verdict — never error messages, URLs, or any content from your application. Feedback is used locally to improve which detectors Mergen trusts for your specific codebase.`,
  },
  {
    title: 'Data retention and deletion',
    body: `To delete all Mergen data, run:`,
    code: 'rm -rf ~/.mergen/',
    footer: 'This removes your license key, session history, calibration feedback, and all local configuration. The browser extension stores no data of its own — it only forwards events to the local server.',
  },
  {
    title: 'Children',
    body: `Mergen is a developer tool intended for professional use. It is not directed at children under 13 and does not knowingly collect information from children.`,
  },
  {
    title: 'Changes to this policy',
    body: `If we make material changes to this privacy policy, we will update this page and increment the version number below. Continued use of Mergen after a policy update constitutes acceptance of the revised policy.`,
  },
  {
    title: 'Contact',
    body: `Questions about this privacy policy can be sent to privacy@mergen.dev or filed as a GitHub issue at https://github.com/omertt27/Mergen/issues.`,
  },
]

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: '8rem', paddingBottom: '8rem' }}>
        <div style={{ maxWidth: 720 }}>
          <p style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '0.6rem', letterSpacing: '0.5em', textTransform: 'uppercase', color: 'var(--gray-600)', marginBottom: '1.5rem' }}>
            Legal
          </p>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', fontWeight: 800, lineHeight: 1.1, marginBottom: '1rem' }}>
            Privacy Policy
          </h1>
          <p style={{ color: 'var(--gray-400)', fontSize: '0.85rem', marginBottom: '3rem', fontFamily: 'var(--font-geist-mono)' }}>
            Version 1.0 · Effective June 2026
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
            {SECTIONS.map((s) => (
              <section key={s.title} style={{ padding: 0, borderTop: '1px solid var(--gray-800)' }}>
                <h2 style={{ fontSize: '0.9rem', fontWeight: 700, marginTop: '2rem', marginBottom: '1rem', color: 'var(--white)' }}>
                  {s.title}
                </h2>
                <p style={{ color: 'var(--gray-400)', fontSize: '0.875rem', lineHeight: 1.7 }}>
                  {s.body}
                </p>
                {s.list && (
                  <ul style={{ margin: '1rem 0', paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {s.list.map((item) => (
                      <li key={item} style={{ color: 'var(--gray-400)', fontSize: '0.875rem', lineHeight: 1.7 }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
                {s.code && (
                  <pre style={{ margin: '1rem 0', padding: '0.75rem 1rem', background: 'var(--gray-800)', borderRadius: 4, fontFamily: 'var(--font-geist-mono)', fontSize: '0.8rem', color: 'var(--accent-text)', overflowX: 'auto' }}>
                    {s.code}
                  </pre>
                )}
                {s.footer && (
                  <p style={{ color: 'var(--gray-400)', fontSize: '0.875rem', lineHeight: 1.7, marginTop: '0.75rem' }}>
                    {s.footer}
                  </p>
                )}
              </section>
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  )
}
