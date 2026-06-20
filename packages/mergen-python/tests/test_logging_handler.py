"""Tests for MergenHandler — the Python logging integration."""

import logging
from unittest.mock import patch, call

from mergen.instrumentation.logging_handler import MergenHandler


def _make_handler() -> MergenHandler:
    h = MergenHandler()
    h.setFormatter(logging.Formatter("%(message)s"))
    return h


def test_emit_error_level(monkeypatch):
    posted = []
    monkeypatch.setattr("mergen.instrumentation.logging_handler.post", lambda evt: posted.append(evt))

    h = _make_handler()
    record = logging.LogRecord("test", logging.ERROR, "", 0, "boom", (), None)
    h.emit(record)

    assert len(posted) == 1
    assert posted[0]["level"] == "error"
    assert "boom" in posted[0]["args"][0]
    assert posted[0]["type"] == "console"


def test_emit_warning_level(monkeypatch):
    posted = []
    monkeypatch.setattr("mergen.instrumentation.logging_handler.post", lambda evt: posted.append(evt))

    h = _make_handler()
    record = logging.LogRecord("test", logging.WARNING, "", 0, "heads up", (), None)
    h.emit(record)

    assert posted[0]["level"] == "warn"


def test_emit_debug_level(monkeypatch):
    posted = []
    monkeypatch.setattr("mergen.instrumentation.logging_handler.post", lambda evt: posted.append(evt))

    h = _make_handler()
    record = logging.LogRecord("test", logging.DEBUG, "", 0, "trace", (), None)
    h.emit(record)

    assert posted[0]["level"] == "log"


def test_emit_never_raises(monkeypatch):
    """Handler must not propagate exceptions — logging must stay stable."""
    def _boom(evt):
        raise RuntimeError("post failed")

    monkeypatch.setattr("mergen.core.post", _boom)

    h = _make_handler()
    record = logging.LogRecord("test", logging.ERROR, "", 0, "msg", (), None)
    h.emit(record)  # must not raise


def test_handler_attached_to_root_logger(monkeypatch):
    posted = []
    monkeypatch.setattr("mergen.instrumentation.logging_handler.post", lambda evt: posted.append(evt))

    root = logging.getLogger()
    h = _make_handler()
    root.addHandler(h)
    try:
        logging.error("hello from root")
        assert any("hello from root" in str(p.get("args", [])) for p in posted)
    finally:
        root.removeHandler(h)
