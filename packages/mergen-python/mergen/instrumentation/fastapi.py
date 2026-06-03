"""
fastapi.py — FastAPI/Starlette middleware that records inbound request spans.

Usage:
    from fastapi import FastAPI
    from mergen.instrumentation.fastapi import MergenMiddleware

    app = FastAPI()
    app.add_middleware(MergenMiddleware)
"""

from __future__ import annotations

import time
from mergen.core import (
    post, generate_trace_context, extract_trace_id, extract_span_id,
    PROCESS_NAME, now_ms,
)

try:
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import Response

    class MergenMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            start_ms = now_ms()

            traceparent = request.headers.get("traceparent")
            trace_id = extract_trace_id(traceparent)
            span_id  = extract_span_id(traceparent)

            if not trace_id:
                ctx = generate_trace_context()
                trace_id = ctx.trace_id
                span_id  = ctx.span_id

            response: Response = await call_next(request)
            response.headers["traceparent"] = f"00-{trace_id}-{span_id or '0000000000000000'}-01"

            duration_ms = now_ms() - start_ms

            # Attempt to get matched route pattern
            route = request.url.path
            try:
                scope_route = request.scope.get("route")
                if scope_route and hasattr(scope_route, "path"):
                    route = scope_route.path
            except Exception:
                pass

            post({
                "type":       "backend_span",
                "service":    PROCESS_NAME,
                "route":      route,
                "method":     request.method.upper(),
                "statusCode": response.status_code,
                "durationMs": duration_ms,
                "traceId":    trace_id,
                "spanId":     span_id or "0000000000000000",
                "sdk":        "python",
                "timestamp":  start_ms,
                **({"error": f"HTTP {response.status_code}"} if response.status_code >= 400 else {}),
            })

            return response

except ImportError:
    # Starlette not installed — provide a stub that raises a clear error
    class MergenMiddleware:  # type: ignore[no-redef]
        def __init__(self, *args, **kwargs):
            raise ImportError(
                "mergen-python FastAPI middleware requires starlette. "
                "Install it with: pip install fastapi"
            )
