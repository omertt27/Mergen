"""
flask.py — Flask before/after_request hooks for Mergen instrumentation.

Usage:
    from flask import Flask
    from mergen.instrumentation.flask import init_app

    app = Flask(__name__)
    init_app(app)
"""

from __future__ import annotations

from mergen.core import (
    post, generate_trace_context, extract_trace_id, extract_span_id,
    PROCESS_NAME, now_ms,
)

try:
    import flask

    def init_app(app: "flask.Flask") -> None:
        _start_key = "_mergen_start"
        _trace_key = "_mergen_trace"

        @app.before_request
        def _before():
            flask.g.__dict__[_start_key] = now_ms()
            traceparent = flask.request.headers.get("traceparent")
            trace_id = extract_trace_id(traceparent)
            span_id  = extract_span_id(traceparent)
            if not trace_id:
                ctx = generate_trace_context()
                trace_id, span_id = ctx.trace_id, ctx.span_id
            flask.g.__dict__[_trace_key] = (trace_id, span_id)

        @app.after_request
        def _after(response: "flask.Response") -> "flask.Response":
            start_ms = flask.g.__dict__.get(_start_key, now_ms())
            trace_id, span_id = flask.g.__dict__.get(_trace_key, (generate_trace_context().trace_id, "0000000000000000"))

            response.headers["traceparent"] = f"00-{trace_id}-{span_id}-01"

            route = flask.request.url_rule.rule if flask.request.url_rule else flask.request.path

            post({
                "type":       "backend_span",
                "service":    PROCESS_NAME,
                "route":      route,
                "method":     flask.request.method.upper(),
                "statusCode": response.status_code,
                "durationMs": now_ms() - start_ms,
                "traceId":    trace_id,
                "spanId":     span_id,
                "sdk":        "python",
                "timestamp":  start_ms,
                **({"error": f"HTTP {response.status_code}"} if response.status_code >= 400 else {}),
            })
            return response

except ImportError:
    def init_app(app):  # type: ignore[misc]
        raise ImportError("mergen-python Flask instrumentation requires flask. pip install flask")
