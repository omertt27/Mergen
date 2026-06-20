"""Tests for mergen.core — stdlib-only utilities."""

import time
import mergen.core as core


def test_import():
    """Package imports without error."""
    import mergen  # noqa: F401


def test_process_name_default():
    """PROCESS_NAME is a non-empty string."""
    assert isinstance(core.PROCESS_NAME, str)
    assert len(core.PROCESS_NAME) > 0


def test_process_url_format():
    """PROCESS_URL contains the process name."""
    assert core.PROCESS_URL.startswith("mergen://python/")
    assert core.PROCESS_NAME in core.PROCESS_URL


def test_generate_trace_context():
    ctx = core.generate_trace_context()
    assert len(ctx.trace_id) == 32   # 16 bytes hex
    assert len(ctx.span_id)  == 16   # 8 bytes hex
    assert ctx.header.startswith("00-")
    assert ctx.trace_id in ctx.header
    assert ctx.span_id  in ctx.header


def test_generate_trace_context_unique():
    """Each call produces a different trace id."""
    assert core.generate_trace_context().trace_id != core.generate_trace_context().trace_id


def test_extract_trace_id_valid():
    ctx = core.generate_trace_context()
    result = core.extract_trace_id(ctx.header)
    assert result == ctx.trace_id


def test_extract_trace_id_none():
    assert core.extract_trace_id(None) is None
    assert core.extract_trace_id("") is None
    assert core.extract_trace_id("bad-header") is None


def test_extract_span_id_valid():
    ctx = core.generate_trace_context()
    result = core.extract_span_id(ctx.header)
    assert result == ctx.span_id


def test_extract_span_id_none():
    assert core.extract_span_id(None) is None


def test_now_ms():
    before = int(time.time() * 1000)
    result = core.now_ms()
    after  = int(time.time() * 1000)
    assert before <= result <= after


def test_post_does_not_raise(monkeypatch):
    """post() is fire-and-forget — must never raise even if server is down."""
    def _boom(*a, **kw):
        raise ConnectionRefusedError("server down")

    monkeypatch.setattr("urllib.request.urlopen", _boom)
    core.post({"type": "console", "level": "error", "args": ["test"], "timestamp": core.now_ms()})
    # No exception raised — daemon thread swallowed the error


def test_mergen_port_default():
    assert core.MERGEN_PORT == 3000


def test_mergen_host_default():
    assert core.MERGEN_HOST == "127.0.0.1"
