"""
logging_handler.py — Python logging.Handler that ships log records to Mergen.

Usage:
    import logging
    import mergen
    mergen.init()   # adds MergenHandler to the root logger automatically

Or manually:
    from mergen.instrumentation.logging_handler import MergenHandler
    logging.getLogger().addHandler(MergenHandler())
"""

from __future__ import annotations

import logging
from mergen.core import post, PROCESS_URL, now_ms


class MergenHandler(logging.Handler):
    _LEVEL_MAP = {
        logging.DEBUG:    "log",
        logging.INFO:     "log",
        logging.WARNING:  "warn",
        logging.ERROR:    "error",
        logging.CRITICAL: "error",
    }

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = self._LEVEL_MAP.get(record.levelno, "log")
            message = self.format(record)
            post({
                "type":      "console",
                "level":     level,
                "args":      [message],
                "stack":     record.exc_text or "",
                "url":       PROCESS_URL,
                "timestamp": int(record.created * 1000),
                "sdk":       "python",
            })
        except Exception:
            self.handleError(record)
