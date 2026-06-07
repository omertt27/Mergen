# Mergen Calibration Corpus Server

Cloudflare Worker that aggregates anonymous calibration verdicts from Mergen installations and returns cross-installation accuracy stats.

## Privacy

- **Receives:** detector tag, verdict (`correct`/`partial`/`wrong`), verdict dimension
- **Ignores:** pid, note, confidence score, timestamps (stripped at parse time)
- **Stores:** per-tag aggregated counts only — no individual verdict rows, no install IDs beyond 1-hour rate-limit TTL
- **Returns:** global accuracy per detector tag + sample count

## Deploy

```bash
cd aggregation-server

# 1. Install dependencies
npm install

# 2. Create KV namespace
wrangler kv namespace create CALIBRATION_KV
wrangler kv namespace create CALIBRATION_KV --preview

# 3. Update wrangler.toml with the IDs printed by the above commands

# 4. Set admin key (optional — enables GET /admin/stats)
wrangler secret put CORPUS_ADMIN_KEY

# 5. Deploy
npm run deploy
```

## API

### POST /corpus

Receive a calibration CSV from a Mergen installation. Returns global stats.

```
Headers:
  Content-Type: text/csv; charset=utf-8
  X-Install-Id: <uuid>           (optional — used for rate limiting only, not stored)

Body: RFC-4180 CSV
  pid,tag,confidence,predictedAt,verdict,verdictAt,note,verdictDimension
  ...

Response: { ok: true, stats: [{ tag, globalAccuracy, sampleCount, diagnosisAccuracy, remediationAccuracy }] }

Rate limit: 1 upload per installation per hour
```

### GET /stats

Current global accuracy stats (public, 5-minute cache).

```json
{
  "stats": [
    {
      "tag": "infra_db_connection_pool",
      "globalAccuracy": 0.87,
      "sampleCount": 143,
      "diagnosisAccuracy": 0.91,
      "remediationAccuracy": 0.78
    }
  ],
  "generatedAt": 1717900800000,
  "totalInstallations": 42
}
```

### GET /admin/stats

Same as `/stats` but not cached. Requires `X-Admin-Key: <CORPUS_ADMIN_KEY>`.

### GET /health

Health check. Returns `{ ok: true, service: "mergen-corpus" }`.

## Local development

```bash
npm run dev
# Worker available at http://localhost:8787

# Test with the Mergen server:
MERGEN_TELEMETRY=1 MERGEN_TELEMETRY_URL=http://localhost:8787 mergen-server start
```

## Client-side activation (Mergen server)

```bash
# Enable on a Mergen installation:
MERGEN_TELEMETRY=1 mergen-server start

# Use custom aggregation server (e.g. self-hosted):
MERGEN_TELEMETRY=1 MERGEN_TELEMETRY_URL=https://your-worker.workers.dev mergen-server start

# Audit what would be sent before enabling:
curl http://127.0.0.1:3000/calibration/export
```
