"""akshare adapter: A-share stocks and indices from the vendor's daily K-line.

The vendor returns Chinese column names, prices in yuan and volume in 手
(lots = 100 shares); this adapter normalizes to shares before anything is
written. Column layouts are asserted instead of guessed, so a vendor change
raises BAD_SHAPE instead of silently writing the wrong numbers.
"""

from __future__ import annotations

from typing import Any

from .. import instruments as instrument_mod
from .base import BAD_SHAPE, EMPTY, UNSUPPORTED, ProviderError, Throttle, clean

NAME = "akshare"
CAPABILITIES = {"kinds": {"daily", "index"}, "markets": {"cn"}}

_throttle = Throttle(250)

_STOCK_REQUIRED = ["日期", "开盘", "收盘", "最高", "最低", "成交量", "成交额"]
_INDEX_REQUIRED = ["日期", "开盘", "收盘", "最高", "最低", "成交量", "成交额"]


def _load():
    try:
        import akshare as ak  # noqa: F401 - imported for availability check
    except Exception as error:  # pragma: no cover - depends on the environment
        raise ProviderError(NAME, UNSUPPORTED, f"akshare is not importable: {error}") from error
    return ak


def _normalize(df, symbol: str, start: str, end: str) -> list[dict[str, Any]]:
    missing = [column for column in _STOCK_REQUIRED if column not in df.columns]
    if missing:
        raise ProviderError(NAME, BAD_SHAPE, f"missing columns {missing}; got {list(df.columns)}", symbol)
    rows: list[dict[str, Any]] = []
    for record in df.to_dict("records"):
        date = str(record["日期"])[:10]
        if not (start <= date <= end):
            continue
        volume_lots = clean(record.get("成交量"))
        rows.append(
            {
                "date": date,
                "open": clean(record.get("开盘")),
                "high": clean(record.get("最高")),
                "low": clean(record.get("最低")),
                "close": clean(record.get("收盘")),
                "volume": None if volume_lots is None else int(round(volume_lots * 100)),
                "amount": clean(record.get("成交额")),
                "turnover": clean(record.get("换手率")),
            }
        )
    return rows


def fetch(symbol: str, kind: str, start: str, end: str, cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Fetch one instrument's daily bars in `[start, end]` (ISO dates)."""
    parsed = instrument_mod.parse(symbol)
    if parsed["market"] != "cn":
        raise ProviderError(NAME, UNSUPPORTED, f"only A shares are wired, got {parsed['market']}", symbol)

    ak = _load()
    _throttle.wait()
    begin = start.replace("-", "")
    finish = end.replace("-", "")
    try:
        if kind == "index":
            frame = ak.index_zh_a_hist(symbol=parsed["code"], period="daily", start_date=begin, end_date=finish)
        else:
            frame = ak.stock_zh_a_hist(
                symbol=parsed["code"],
                period="daily",
                start_date=begin,
                end_date=finish,
                adjust="",
            )
    except Exception as error:
        raise ProviderError(NAME, "HTTP", f"akshare request failed: {error}", symbol) from error

    if frame is None or getattr(frame, "empty", True):
        raise ProviderError(NAME, EMPTY, f"akshare returned no rows for {start}..{end}", symbol)
    rows = _normalize(frame, symbol, start, end)
    if not rows:
        raise ProviderError(NAME, EMPTY, f"akshare rows all outside {start}..{end}", symbol)
    return rows
