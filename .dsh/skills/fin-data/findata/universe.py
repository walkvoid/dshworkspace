"""Universe builders: which instruments the seed set contains.

`build("sse50")` reads the current SSE 50 constituents from the index vendor,
writes `data/universes/sse50.json` and registers the members in
`data/instruments.json`. Rebuilding replaces the membership snapshot; the
previous file is kept with a date suffix so old coverage stays reproducible.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from . import instruments as instrument_mod
from .config import DATA
from .store import write_json

_CN_EXCHANGE = {
    "上海": "sh",
    "深圳": "sz",
    "北京": "bj",
}


def universe_path(name: str) -> Path:
    return DATA / "universes" / f"{name}.json"


def load_universe(name: str) -> dict[str, Any]:
    path = universe_path(name)
    if not path.exists():
        available = sorted(item.stem for item in (DATA / "universes").glob("*.json"))
        raise FileNotFoundError(f"universe {name!r} not found; available: {available}")
    return json.loads(path.read_text(encoding="utf-8"))


def _exchange_from_row(row: dict[str, Any], code: str) -> str:
    text = str(row.get("交易所", ""))
    for marker, exchange in _CN_EXCHANGE.items():
        if marker in text:
            return exchange
    return instrument_mod.infer_exchange(code)


def _write_universe(name: str, members: list[dict[str, Any]], as_of: str, source: str) -> dict[str, Any]:
    payload = {
        "name": name,
        "asOf": as_of,
        "source": source,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "members": members,
    }
    path = universe_path(name)
    if path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
        old_as_of = str(previous.get("asOf", ""))[:10]
        if old_as_of and old_as_of != as_of:
            path.with_name(f"{name}-{old_as_of}.json").write_text(
                json.dumps(previous, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
            )
    write_json(path, payload)

    table = instrument_mod.instruments()
    for member in members:
        parsed = instrument_mod.parse(member["symbol"])
        table[parsed["symbol"]] = {
            "symbol": parsed["symbol"],
            "code": parsed["code"],
            "exchange": parsed["exchange"],
            "market": parsed["market"],
            "kind": member.get("kind", "stock"),
            "name": member.get("name"),
        }
    instrument_mod.save_instruments(table)
    return payload


def _build_sse50() -> dict[str, Any]:
    import akshare as ak

    frame = ak.index_stock_cons_csindex(symbol="000016")
    if frame is None or frame.empty:
        raise RuntimeError("no SSE 50 constituents returned")
    if "成分券代码" not in frame.columns:
        raise RuntimeError(f"unexpected constituent layout: {list(frame.columns)}")

    as_of = str(frame["日期"].iloc[0])[:10] if "日期" in frame.columns else datetime.now().date().isoformat()
    members: list[dict[str, Any]] = []
    for row in frame.to_dict("records"):
        code = str(row["成分券代码"]).zfill(6)
        exchange = _exchange_from_row(row, code)
        members.append(
            {
                "symbol": f"{code}.{exchange.upper()}",
                "kind": "stock",
                "name": row.get("成分券名称"),
            }
        )
    # The index itself is stored too, so charts can compare against it.
    members.append({"symbol": "000016.SH", "kind": "index", "name": "上证50"})
    return _write_universe("sse50", members, as_of, "csindex:000016")


def build(name: str) -> dict[str, Any]:
    """Build one named universe."""
    if name == "sse50":
        return _build_sse50()
    raise ValueError(f"no builder for universe {name!r}; expected one of: sse50")
