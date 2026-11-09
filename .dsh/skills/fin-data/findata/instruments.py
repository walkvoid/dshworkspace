"""Instrument identity: `<code>.<exchange>` in, canonical descriptor out.

Accepted spellings: `600519`, `sh600519`, `cn:sh600519`, `600519.SH`.

The suffix is uppercase in files and JSON (`600519.SH`); parsing is
case-insensitive. Bare six-digit codes are inferred by the A-share convention
(6/9 -> SH, 4/8 -> BJ, otherwise SZ) — indices must be spelled with a suffix or
come from a universe file, because `000001` is ambiguous.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .config import DATA

_SUFFIX = {"sh": "SH", "sz": "SZ", "bj": "BJ"}
_PREFIX = {value: key for key, value in _SUFFIX.items()}

_CN_CODE = re.compile(r"^(?:cn:)?(sh|sz|bj)(\d{6})$")
_SUFFIXED = re.compile(r"^(\d{6})\.(sh|sz|bj)$")
_BARE = re.compile(r"^\d{6}$")


def infer_exchange(code: str) -> str:
    """A-share exchange from a bare six-digit code.

    `920xxx` is the newer Beijing Stock Exchange range and `900xxx` is
    Shanghai B shares, so the leading digit alone is not enough.
    """
    if code.startswith("920"):
        return "bj"
    if code.startswith("900"):
        return "sh"
    first = code[0]
    if first in "69":
        return "sh"
    if first in "48":
        return "bj"
    return "sz"


def make(exchange: str, code: str) -> dict[str, str]:
    exchange = exchange.lower()
    if exchange not in _SUFFIX:
        raise ValueError(f"unknown exchange {exchange!r}")
    return {
        "market": "cn",
        "exchange": exchange,
        "code": code,
        "symbol": f"{code}.{_SUFFIX[exchange]}",
    }


def parse(value: str) -> dict[str, str]:
    """Parse any accepted spelling into `{market, exchange, code, symbol}`."""
    text = str(value).strip().lower()
    match = _CN_CODE.fullmatch(text)
    if match is not None:
        return make(match.group(1), match.group(2))
    match = _SUFFIXED.fullmatch(text)
    if match is not None:
        return make(match.group(2), match.group(1))
    if _BARE.fullmatch(text):
        return make(infer_exchange(text), text)
    raise ValueError(f"cannot parse instrument {value!r}; expected e.g. 600519, sh600519 or 600519.SH")


def instruments() -> dict[str, dict[str, Any]]:
    """Read `data/instruments.json` as `{symbol: descriptor}`."""
    path = DATA / "instruments.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw.get("items", raw) if isinstance(raw, dict) else {}
    return {key: value for key, value in items.items() if isinstance(value, dict)}


def descriptor(symbol: str) -> dict[str, Any]:
    """Return the stored descriptor for a symbol, or a stock-shaped fallback."""
    parsed = parse(symbol)
    stored = instruments().get(parsed["symbol"])
    if stored is not None:
        return stored
    return {**parsed, "kind": "stock", "name": None}


def kind_of(symbol: str) -> str:
    """`index` or `stock`; indices live under `daily/cn/index/`."""
    return descriptor(symbol).get("kind", "stock")


def exchange_dir(symbol: str, kind: str | None = None) -> str:
    """Directory name under `data/daily/cn/`: exchange, or `index` for indices."""
    parsed = parse(symbol)
    if (kind or kind_of(symbol)) == "index":
        return "index"
    return parsed["exchange"]


def save_instruments(items: dict[str, dict[str, Any]]) -> None:
    """Persist the instrument table (sorted for stable git diffs)."""
    from .store import write_json

    ordered = {key: items[key] for key in sorted(items)}
    write_json(DATA / "instruments.json", {"updatedAt": None, "items": ordered}, stamp=True)
