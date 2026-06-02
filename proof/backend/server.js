'use strict';

const express = require('express');
const app  = express();
const PORT = 4000;

app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow the traceparent header through the preflight so the browser doesn't
// strip it before it reaches the traceparent middleware below.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, traceparent, tracestate');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// ── Structured access log (the one line that closes the causal loop) ──────────
// Reads the W3C traceparent header injected by the Mergen browser extension,
// extracts the 32-char hex traceId, and emits it to stdout in a format that
// Mergen's process-watcher regex extractor recognises automatically.
// No manual trace IDs. No custom debugging. Standard access logging.
app.use((req, res, next) => {
  const tp = req.headers['traceparent']; // "00-{traceId32}-{spanId16}-01"
  if (tp) {
    const traceId = tp.split('-')[1];
    console.log(JSON.stringify({
      traceId,
      method:  req.method,
      url:     req.url,
      service: 'proof-backend',
    }));
  }
  next();
});

// ── /api/checkout — the failing endpoint ─────────────────────────────────────
app.post('/api/checkout', (req, res) => {
  console.log('[backend] Processing checkout...');

  try {
    const cart = req.body.cart;

    // Bug: accessing .length on undefined when cart has no items field
    if (!cart || cart.items.length === 0) {
      throw new Error('Cart is empty at checkout.js:42');
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[backend] Error: ${err.message}`);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] Proof backend running on http://localhost:${PORT}`);
});
