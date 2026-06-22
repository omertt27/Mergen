# Postmortem — db_connection_pool

**Service:** api-gateway  |  **Date:** 2026-06-22
**Confidence:** 95%  |  **MTTR:** 3m 45s
**Resolution:** Manual
**Branch:** release/v1.4  |  **SHA:** e7f8g9h0i1j2

## Root Cause

The connection pool size was set to 5, which was exhausted during a peak analytics query run.

## Fix Applied

```
kubectl scale deployment/api-gateway --replicas=3
```

## Evidence

- Database logs showed error `connection pool exhausted`.
- HTTP 504 gateway timeouts spike on `/api/reports`.
