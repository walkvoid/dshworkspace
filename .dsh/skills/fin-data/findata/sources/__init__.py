"""Source router: try providers in configured order, one symbol at a time.

Only akshare and the direct Eastmoney adapter are wired in this iteration;
adata and iFinD entries stay in the config so the chain position is explicit,
and they are skipped until their adapters land.
"""

from __future__ import annotations

import time
from typing import Any

from . import akshare_source, web_source
from .base import EMPTY, RATE_LIMITED, UNSUPPORTED, ProviderError

REGISTRY: dict[str, Any] = {
    "akshare": akshare_source,
    "web": web_source,
}

NON_RETRYABLE = {UNSUPPORTED, "AUTH", "NOT_FOUND", EMPTY, RATE_LIMITED}

# Short provenance codes written into every row (`src` column).
PROVIDER_CODE = {"akshare": "ak", "adata": "ad", "ifind": "if", "web": "web"}


class AllProvidersFailed(Exception):
    """Every configured provider rejected one instrument."""

    def __init__(self, symbol: str, errors: list[ProviderError]):
        self.symbol = symbol
        self.errors = errors
        detail = "; ".join(f"{item.provider}/{item.code}: {item.message}" for item in errors) or "no provider wired"
        super().__init__(f"{symbol}: {detail}")

    def as_dict(self) -> dict[str, Any]:
        return {"symbol": self.symbol, "errors": [item.as_dict() for item in self.errors]}


def fetch_daily(
    symbol: str, kind: str, start: str, end: str, cfg: dict[str, Any]
) -> tuple[list[dict[str, Any]], str]:
    """Return `(rows, provider)` from the first source that answers."""
    order = list(cfg.get("sources", {}).get("order", []))
    retries = max(1, int(cfg.get("sources", {}).get("retries", 3)))
    errors: list[ProviderError] = []

    for name in order:
        module = REGISTRY.get(name)
        if module is None:
            continue
        for attempt in range(retries):
            try:
                rows = module.fetch(symbol, kind, start, end, cfg)
                code = PROVIDER_CODE.get(name, name[:2])
                for row in rows:
                    row["src"] = code
                return rows, name
            except ProviderError as error:
                errors.append(error)
                if error.code in NON_RETRYABLE:
                    break
                if attempt + 1 < retries:
                    time.sleep(1.2 * (attempt + 1))
            except Exception as error:  # defensive: adapters should not leak
                errors.append(ProviderError(name, "ERROR", str(error), symbol))
                break
    raise AllProvidersFailed(symbol, errors)
