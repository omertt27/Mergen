"""
core.py — Internal poster and trace context utilities.
Zero runtime dependencies — uses only Python stdlib.

Fire-and-forget: all posts run in daemon threads and never raise.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
import urllib.request
from typing import Any, Dict, Optional

MERGEN_PORT   = int(os.environ.get("MERGEN_PORT",   "3000"))
MERGEN_HOST   = os.environ.get("MERGEN_HOST",   "127.0.0.1")
MERGEN_SECRET = os.environ.get("MERGEN_SECRET", None)
PROCESS_NAME  = os.environ.get("MERGEN_NAME",   _resolve_process_name())
PROCESS_URL   = f"mergen://python/{PROCESS_NAME}"


def _resolve_process_name() -> str:
    # Try reading name from pyproject.toml or setup.cfg in cwd
    import pathlib
    for candidate in ["pyproject.toml", "setup.cfg"]:
        p = pathlib.Path(candidate)
        if p.exists():
            try:
                text = p.read_text()
                for line in text.splitlines():
                    if line.strip().startswith("name"):
                        val = line.split("=", 1)[-1].strip().strip('"').strip("'")
                        if val:
                            return val
            except Exception:
                pass
    import sys
    if sys.argv and sys.argv[0]:
        return os.path.splitext(os.path.basename(sys.argv[0]))[0] or "python"
    return "python"


def _send_http(event: Dict[str, Any]) -> None:
    """Blocking HTTP POST — called inside a daemon thread."""
    try:
        body = json.dumps(event).encode("utf-8")
        headers = {
            "Content-Type":   "application/json",
            "Content-Length": str(len(body)),
        }
        if MERGEN_SECRET:
            headers["x-mergen-secret"] = MERGEN_SECRET
        req = urllib.request.Request(
            f"http://{MERGEN_HOST}:{MERGEN_PORT}/ingest",
            data=body,
            headers=headers,
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # server not running — silently ignore


def post(event: Dict[str, Any]) -> None:
    """Fire-and-forget: send event to Mergen server in a daemon thread."""
    t = threading.Thread(target=_send_http, args=(event,), daemon=True)
    t.start()


class TraceContext:
    __slots__ = ("trace_id", "span_id", "header")

    def __init__(self, trace_id: str, span_id: str) -> None:
        self.trace_id = trace_id
        self.span_id  = span_id
        self.header   = f"00-{trace_id}-{span_id}-01"


def generate_trace_context() -> TraceContext:
    trace_id = secrets.token_hex(16)
    span_id  = secrets.token_hex(8)
    return TraceContext(trace_id, span_id)


def extract_trace_id(traceparent: Optional[str]) -> Optional[str]:
    if not traceparent:
        return None
    parts = traceparent.split("-")
    if len(parts) >= 4 and len(parts[1]) == 32:
        return parts[1]
    return None


def extract_span_id(traceparent: Optional[str]) -> Optional[str]:
    if not traceparent:
        return None
    parts = traceparent.split("-")
    if len(parts) >= 4 and len(parts[2]) == 16:
        return parts[2]
    return None


def now_ms() -> int:
    return int(time.time() * 1000)
