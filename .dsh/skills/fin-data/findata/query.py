"""Read path: `load_bars` and the CLI `get` payload.

Reading never touches the network unless the requested instrument has no file
at all, in which case the skill fetches it once (the "missing data, update via
the chain" requirement).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from . import instruments as instrument_mod
from . import sources, store
from .config import load_config
from .sources import AllProvidersFailed
from .sync import latest_target
from .universe import load_universe


def _universe_members(cfg: dict[str, Any]) -> set[str]:
    try:
        return {member["symbol"] for member in load_universe(cfg["universe"]).get("members", [])}
    except Exception:
        return set()


def _use_local(symbol: str, kind: str, cfg: dict[str, Any]) -> bool:
    """Non-seed instruments are cached under `data/local/` (gitignored)."""
    if store.bar_path(symbol, kind).exists():
        return False
    if store.bar_path(symbol, kind, local=True).exists():
        return True
    return symbol not in _universe_members(cfg)


def fetch_one(
    symbol: str, kind: str | None = None, since: str | None = None, local: bool | None = None
) -> dict[str, Any]:
    """Fetch (or top up) a single instrument through the provider chain."""
    cfg = load_config()
    parsed = instrument_mod.parse(symbol)
    kind = kind or instrument_mod.kind_of(parsed["symbol"])
    if local is None:
        local = _use_local(parsed["symbol"], kind, cfg)
    target = latest_target(cfg)
    if target is None:
        raise RuntimeError("trading calendar has no usable session")
    start = since or cfg["history_start"]
    try:
        rows, provider = sources.fetch_daily(parsed["symbol"], kind, start, target, cfg)
    except AllProvidersFailed as error:
        raise RuntimeError(f"could not fetch {parsed['symbol']}: {error}") from error
    written = store.append_bars(parsed["symbol"], kind, rows, local=local)
    if not local:
        store.rebuild_manifest(cfg["universe"])
    return {
        "symbol": parsed["symbol"],
        "provider": provider,
        "rows": written,
        "target": target,
        "storedIn": "local" if local else "daily",
    }


def load_bars(
    symbol: str,
    start: str | None = None,
    end: str | None = None,
    adjust: str = "raw",
    fetch_missing: bool = True,
) -> pd.DataFrame:
    """Return one instrument's bars as a typed DataFrame.

    Only `raw` is available until the adjustment-factor dataset lands; asking
    for anything else fails loudly instead of silently returning raw prices.
    """
    if adjust != "raw":
        raise ValueError(f"adjust={adjust!r} is not available yet; only 'raw' is stored")
    cfg = load_config()
    parsed = instrument_mod.parse(symbol)
    kind = instrument_mod.kind_of(parsed["symbol"])
    local = _use_local(parsed["symbol"], kind, cfg)
    if fetch_missing and not store.bar_path(parsed["symbol"], kind, local).exists():
        fetch_one(parsed["symbol"], kind, local=local)
    frame = store.read_bars(parsed["symbol"], kind, local=local)
    if start:
        frame = frame[frame["date"] >= start]
    if end:
        frame = frame[frame["date"] <= end]
    return frame.reset_index(drop=True)


def records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """JSON-safe rows: NaN becomes null, numpy scalars become Python values."""
    output: list[dict[str, Any]] = []
    for row in frame.to_dict("records"):
        cleaned: dict[str, Any] = {}
        for key, value in row.items():
            if value is None or (isinstance(value, float) and np.isnan(value)):
                cleaned[key] = None
            elif isinstance(value, (np.integer,)):
                cleaned[key] = int(value)
            elif isinstance(value, (np.floating,)):
                cleaned[key] = None if np.isnan(value) else float(value)
            elif isinstance(value, pd.Timestamp):
                cleaned[key] = value.date().isoformat()
            else:
                cleaned[key] = value
        output.append(cleaned)
    return output


def payload(symbol: str, start: str | None, end: str | None, adjust: str = "raw") -> dict[str, Any]:
    """The `get` result: rows plus provenance the answer must quote."""
    frame = load_bars(symbol, start=start, end=end, adjust=adjust)
    counts = frame["src"].value_counts().to_dict() if len(frame) else {}
    return {
        "ok": True,
        "symbol": instrument_mod.parse(symbol)["symbol"],
        "adjust": adjust,
        "asOf": str(frame["date"].iloc[-1]) if len(frame) else None,
        "rowCount": len(frame),
        "sources": {str(key): int(value) for key, value in counts.items()},
        "rows": records(frame),
    }
