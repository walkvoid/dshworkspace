"""Direct Eastmoney K-line fallback (no vendor SDK).

`push2his.eastmoney.com/api/qt/stock/kline/get` is the same endpoint akshare
uses, so a vendor-side library breakage does not take the whole update down.
Volume comes back in 手 and is converted to shares here.
"""

from __future__ import annotations

from typing import Any

import requests

from .. import instruments as instrument_mod
from .base import BAD_SHAPE, EMPTY, HTTP, ProviderError, Throttle, clean

NAME = "web"
CAPABILITIES = {"kinds": {"daily", "index"}, "markets": {"cn"}}

_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) fin-data/0.1",
    "Referer": "https://quote.eastmoney.com/",
}

# date, open, close, high, low, volume(手), amount(元), amplitude, pct, change, turnover
_FIELDS = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"

_FIELD_SPEC = "f1,f2,f3,f4,f5,f6"

_throttle = Throttle(500)


def secid(symbol: str) -> str:
    """Eastmoney's `<market>.<code>` where market is 1 for Shanghai, 0 otherwise."""
    parsed = instrument_mod.parse(symbol)
    market = "1" if parsed["exchange"] == "sh" else "0"
    return f"{market}.{parsed['code']}"


def parse_kline(payload: dict[str, Any], symbol: str, start: str, end: str) -> list[dict[str, Any]]:
    """Normalize one `klines` payload into raw bars."""
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("klines"), list):
        raise ProviderError(NAME, BAD_SHAPE, "payload has no klines", symbol)
    rows: list[dict[str, Any]] = []
    for line in data["klines"]:
        parts = str(line).split(",")
        if len(parts) < 7:
            continue
        date = parts[0][:10]
        if not (start <= date <= end):
            continue
        volume_lots = clean(parts[5])
        rows.append(
            {
                "date": date,
                "open": clean(parts[1]),
                "close": clean(parts[2]),
                "high": clean(parts[3]),
                "low": clean(parts[4]),
                "volume": None if volume_lots is None else int(round(volume_lots * 100)),
                "amount": clean(parts[6]),
                "turnover": clean(parts[10]) if len(parts) > 10 else None,
            }
        )
    if not rows:
        raise ProviderError(NAME, EMPTY, f"no klines in {start}..{end}", symbol)
    return rows


def fetch(symbol: str, kind: str, start: str, end: str, cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Fetch one instrument's raw daily bars."""
    _throttle.wait()
    params = {
        "secid": secid(symbol),
        "fields1": _FIELD_SPEC,
        "fields2": _FIELDS,
        "klt": "101",
        "fqt": "0",  # 0 = raw, never adjusted
        "beg": start.replace("-", ""),
        "end": end.replace("-", ""),
    }
    try:
        response = requests.get(_URL, params=params, headers=_HEADERS, timeout=20)
        response.raise_for_status()
        payload = response.json()
    except Exception as error:
        raise ProviderError(NAME, HTTP, f"eastmoney request failed: {error}", symbol) from error
    return parse_kline(payload, symbol, start, end)
