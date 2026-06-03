"""
django.py — Django middleware that records inbound request spans.

Usage (settings.py):
    MIDDLEWARE = [
        'mergen.instrumentation.django.MergenDjangoMiddleware',
        ...
    ]
"""

from __future__ import annotations

import time
from mergen.core import (
    post, generate_trace_context, extract_trace_id, extract_span_id,
    PROCESS_NAME, now_ms,
)


class MergenDjangoMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start_ms = now_ms()

        # Read or generate trace context
        traceparent = request.META.get("HTTP_TRACEPARENT")
        trace_id = extract_trace_id(traceparent)
        span_id  = extract_span_id(traceparent)

        if not trace_id:
            ctx = generate_trace_context()
            trace_id = ctx.trace_id
            span_id  = ctx.span_id

        response = self.get_response(request)

        # Echo traceId back so browser extension can read the join key
        response["traceparent"] = f"00-{trace_id}-{span_id or '0000000000000000'}-01"

        duration_ms = now_ms() - start_ms

        # Resolve matched route pattern (e.g. "api/users/<int:pk>/")
        route = request.path
        try:
            if hasattr(request, "resolver_match") and request.resolver_match:
                route = request.resolver_match.route or request.path
        except Exception:
            pass

        post({
            "type":       "backend_span",
            "service":    PROCESS_NAME,
            "route":      f"/{route.lstrip('/')}",
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
