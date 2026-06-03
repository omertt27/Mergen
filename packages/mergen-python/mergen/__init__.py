"""
mergen-python — Mergen Python SDK

Usage:
    import mergen
    mergen.init()   # auto-instruments logging + requests

Or with options:
    mergen.init(port=3000, name="api-service")
"""

from __future__ import annotations

import logging
import sys
from typing import Optional

from mergen.core import post, generate_trace_context, PROCESS_URL, PROCESS_NAME
from mergen.instrumentation.logging_handler import MergenHandler

__all__ = ["init", "post", "generate_trace_context", "MergenHandler"]

_initialized = False


def init(
    port: Optional[int] = None,
    host: Optional[str] = None,
    secret: Optional[str] = None,
    name: Optional[str] = None,
    instrument_logging: bool = True,
    instrument_requests: bool = True,
) -> None:
    """Initialize Mergen SDK. Safe to call multiple times — only runs once."""
    global _initialized
    if _initialized:
        return
    _initialized = True

    # Override env-based config if kwargs are provided
    import mergen.core as _core
    if port   is not None: _core.MERGEN_PORT   = port
    if host   is not None: _core.MERGEN_HOST   = host
    if secret is not None: _core.MERGEN_SECRET = secret
    if name   is not None:
        _core.PROCESS_NAME = name
        _core.PROCESS_URL  = f"mergen://python/{name}"

    if instrument_logging:
        _attach_logging_handler()

    if instrument_requests:
        _patch_requests()

    _register_excepthook()


def _attach_logging_handler() -> None:
    handler = MergenHandler()
    handler.setLevel(logging.DEBUG)
    root = logging.getLogger()
    if not any(isinstance(h, MergenHandler) for h in root.handlers):
        root.addHandler(handler)


def _patch_requests() -> None:
    try:
        import requests
        from mergen.core import generate_trace_context, extract_trace_id, PROCESS_NAME, now_ms

        _orig_send = requests.Session.send

        def _patched_send(self, prepared_request, **kwargs):
            url = prepared_request.url or ""
            # Skip Mergen's own ingest calls
            import mergen.core as _c
            if f"{_c.MERGEN_HOST}:{_c.MERGEN_PORT}" in url:
                return _orig_send(self, prepared_request, **kwargs)

            ctx = generate_trace_context()
            if "traceparent" not in (prepared_request.headers or {}):
                prepared_request.headers["traceparent"] = ctx.header

            start_ms = now_ms()
            try:
                response = _orig_send(self, prepared_request, **kwargs)
                tp = response.headers.get("traceparent")
                trace_id = extract_trace_id(tp) or ctx.trace_id
                post({
                    "type": "network",
                    "method": (prepared_request.method or "GET").upper(),
                    "url": url,
                    "status": response.status_code,
                    "statusText": response.reason or "",
                    "duration": now_ms() - start_ms,
                    "timestamp": start_ms,
                    "sdk": "python",
                    "traceId": trace_id,
                })
                return response
            except Exception as exc:
                post({
                    "type": "network",
                    "method": (prepared_request.method or "GET").upper(),
                    "url": url,
                    "status": 0,
                    "statusText": "NetworkError",
                    "duration": now_ms() - start_ms,
                    "error": str(exc),
                    "timestamp": start_ms,
                    "sdk": "python",
                })
                raise

        requests.Session.send = _patched_send  # type: ignore[method-assign]
    except ImportError:
        pass  # requests not installed — skip


def _register_excepthook() -> None:
    _orig = sys.excepthook

    def _hook(exc_type, exc_value, exc_tb):
        import traceback
        stack = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        post({
            "type":      "console",
            "level":     "error",
            "args":      [f"[uncaughtException] {exc_type.__name__}: {exc_value}"],
            "stack":     stack,
            "url":       PROCESS_URL,
            "timestamp": __import__("mergen.core", fromlist=["now_ms"]).now_ms(),
            "sdk":       "python",
        })
        _orig(exc_type, exc_value, exc_tb)

    sys.excepthook = _hook
