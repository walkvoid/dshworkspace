"""Adapter contract shared by every upstream.

Each source returns *raw* (unadjusted) daily bars as plain dicts:

    {"date": "2026-11-07", "open": ..., "high": ..., "low": ...,
     "close": ..., "volume": <shares>, "amount": <yuan>, "turnover": <pct>|None}

Adapters must raise `ProviderError` (never a bare exception) so the router can
decide whether to fall through to the next source.
"""

from __future__ import annotations

import math
import time
from typing import Any

NOT_FOUND = "NOT_FOUND"
EMPTY = "EMPTY"
HTTP = "HTTP"
BAD_SHAPE = "BAD_SHAPE"
UNSUPPORTED = "UNSUPPORTED"
RATE_LIMITED = "RATE_LIMITED"
AUTH = "AUTH"
UPSTREAM_DOWN = "UPSTREAM_DOWN"


class ProviderError(Exception):
    """A source-specific failure, carrying the router's error code."""

    def __init__(self, provider: str, code: str, message: str, symbol: str | None = None):
        super().__init__(f"{provider}: {code}: {message}")
        self.provider = provider
        self.code = code
        self.message = message
        self.symbol = symbol

    def as_dict(self) -> dict[str, Any]:
        return {"provider": self.provider, "code": self.code, "message": self.message}


class Throttle:
    """Minimum spacing between calls to one upstream."""

    def __init__(self, min_interval_ms: int = 250):
        self.min_interval = max(0, int(min_interval_ms)) / 1000.0
        self._last = 0.0

    def wait(self) -> None:
        if self.min_interval <= 0:
            return
        delay = self.min_interval - (time.monotonic() - self._last)
        if delay > 0:
            time.sleep(delay)
        self._last = time.monotonic()


def clean(value: Any) -> float | None:
    """Convert a possibly-empty source cell to a finite float or `None`."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if text in ("", "-", "--", "None", "nan"):
            return None
        try:
            value = float(text)
        except ValueError:
            return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None
