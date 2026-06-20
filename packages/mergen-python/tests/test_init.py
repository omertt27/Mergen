"""Tests for mergen.__init__ — SDK init lifecycle."""

import logging
import sys

import mergen
import mergen.core as core
from mergen.instrumentation.logging_handler import MergenHandler


def setup_function():
    # Reset init guard between tests
    mergen._initialized = False
    # Remove any MergenHandler added by a previous test
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not isinstance(h, MergenHandler)]


def test_init_is_idempotent():
    """Calling init() twice does not add a second MergenHandler."""
    mergen.init()
    mergen.init()
    root = logging.getLogger()
    mergen_handlers = [h for h in root.handlers if isinstance(h, MergenHandler)]
    assert len(mergen_handlers) == 1


def test_init_adds_logging_handler():
    mergen.init(instrument_logging=True)
    root = logging.getLogger()
    assert any(isinstance(h, MergenHandler) for h in root.handlers)


def test_init_skips_logging_handler_when_disabled():
    mergen.init(instrument_logging=False)
    root = logging.getLogger()
    assert not any(isinstance(h, MergenHandler) for h in root.handlers)


def test_init_overrides_name():
    mergen.init(name="test-service")
    assert core.PROCESS_NAME == "test-service"
    assert core.PROCESS_URL  == "mergen://python/test-service"


def test_init_overrides_port():
    mergen.init(port=9000)
    assert core.MERGEN_PORT == 9000


def test_init_registers_excepthook():
    mergen.init()
    assert sys.excepthook is not sys.__excepthook__


def test_mergen_handler_exported():
    from mergen import MergenHandler as MH  # noqa: F401


def test_post_exported():
    from mergen import post as p  # noqa: F401
