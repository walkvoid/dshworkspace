"""Storage: one CSV per instrument, append-only, plus the manifest.

Layout:

    data/daily/cn/sh/600519.csv
    data/daily/cn/sz/000001.csv
    data/daily/cn/index/000016.csv

Invariant: rows are appended in ascending `date` order and never rewritten,
unless `repair` explicitly rebuilds one file. That is what keeps `git diff`
small and the history auditable.
"""

from __future__ import annotations

import json
import math
import os
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from .config import DATA, load_config
from . import instruments as instrument_mod

COLUMNS = ["date", "symbol", "open", "high", "low", "close", "volume", "amount", "turnover", "src"]
HEADER = ",".join(COLUMNS)

MANIFEST_PATH = DATA / "manifest.json"


# --------------------------------------------------------------------------- io


def daily_dir() -> Path:
    return DATA / "daily" / "cn"


def local_dir() -> Path:
    """Cache for instruments outside the committed universe (gitignored)."""
    return DATA / "local" / "daily" / "cn"


def _base(local: bool) -> Path:
    return local_dir() if local else daily_dir()


def bar_path(symbol: str, kind: str = "stock", local: bool = False) -> Path:
    """Path of one instrument's file; `.csv.gz` when compression is enabled."""
    parsed = instrument_mod.parse(symbol)
    directory = "index" if kind == "index" else parsed["exchange"]
    compressed = load_config()["storage"].get("compress") == "gzip"
    suffix = ".csv.gz" if compressed else ".csv"
    return _base(local) / directory / f"{parsed['code']}{suffix}"


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def read_json(path: Path) -> Any:
    """Read JSON, returning `None` when the file is missing or broken."""
    return _read_json_file(path)


def write_json(path: Path, payload: Any, stamp: bool = False) -> None:
    """Atomically write JSON with stable formatting (2-space indent, UTF-8)."""
    if stamp and isinstance(payload, dict):
        payload = {**payload, "updatedAt": datetime.now().isoformat(timespec="seconds")}
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(temp, path)


# ------------------------------------------------------------------ formatting


def _num(value: Any, digits: int = 2) -> str:
    if value is None:
        return ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return ""
    if not math.isfinite(number):
        return ""
    return f"{number:.{digits}f}"


def _int(value: Any) -> str:
    if value is None:
        return ""
    try:
        return str(int(round(float(value))))
    except (TypeError, ValueError):
        return ""


def format_row(row: dict[str, Any]) -> str:
    """Serialize one bar. Prices keep two decimals; volume is whole shares."""
    return ",".join(
        [
            str(row["date"])[:10],
            str(row["symbol"]),
            _num(row.get("open")),
            _num(row.get("high")),
            _num(row.get("low")),
            _num(row.get("close")),
            _int(row.get("volume")),
            _num(row.get("amount")),
            _num(row.get("turnover")),
            str(row.get("src") or ""),
        ]
    )


# ----------------------------------------------------------------- raw reading


def _last_line(path: Path) -> str | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    if path.suffix == ".gz":
        import gzip

        with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
            lines = [line for line in handle.read().splitlines() if line.strip()]
        return lines[-1] if lines else None
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        block = min(size, 8192)
        handle.seek(size - block)
        text = handle.read().decode("utf-8", "replace")
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else None


def _first_data_line(path: Path) -> str | None:
    if not path.exists():
        return None
    if path.suffix == ".gz":
        import gzip

        with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
            lines = [line for line in handle.read().splitlines() if line.strip()]
        return lines[1] if len(lines) > 1 else None
    with path.open("r", encoding="utf-8", newline="") as handle:
        handle.readline()
        return handle.readline().strip() or None


def last_date(symbol: str, kind: str = "stock", local: bool = False) -> str | None:
    """Last stored session for an instrument, or `None` when it has no file."""
    line = _last_line(bar_path(symbol, kind, local))
    if line is None or line.startswith("date,"):
        return None
    return line.split(",", 1)[0] or None


def last_close(symbol: str, kind: str = "stock", local: bool = False) -> float | None:
    """Close of the last stored bar, used for the limit-move sanity check."""
    line = _last_line(bar_path(symbol, kind, local))
    if line is None or line.startswith("date,"):
        return None
    parts = line.split(",")
    if len(parts) <= 5:
        return None
    try:
        value = float(parts[5])
    except ValueError:
        return None
    return value if value > 0 else None


def _open_append(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".gz":
        import gzip

        return gzip.open(path, "at", encoding="utf-8", newline="")
    return path.open("a", encoding="utf-8", newline="")


def read_bars(symbol: str, kind: str = "stock", local: bool = False) -> pd.DataFrame:
    """Read one instrument's full history as typed columns."""
    path = bar_path(symbol, kind, local)
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame(columns=COLUMNS).astype({"date": "string", "symbol": "string", "src": "string"})
    frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    for column in ("open", "high", "low", "close", "amount", "turnover"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame["volume"] = pd.to_numeric(frame["volume"], errors="coerce").astype("Int64")
    frame["date"] = frame["date"].astype("string")
    frame["symbol"] = frame["symbol"].astype("string")
    frame["src"] = frame["src"].astype("string")
    return frame


# -------------------------------------------------------------------- writing


def append_bars(symbol: str, kind: str, rows: Iterable[dict[str, Any]], local: bool = False) -> int:
    """Append bars newer than the last stored date; return how many were written.

    Rows at or before the last stored date are skipped (the call is idempotent),
    which is also what makes a repeated `update` a no-op.
    """
    path = bar_path(symbol, kind, local)
    previous = last_date(symbol, kind, local)
    fresh: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in sorted(rows, key=lambda item: str(item["date"])):
        date = str(row["date"])[:10]
        if previous is not None and date <= previous:
            continue
        if date in seen:
            continue
        seen.add(date)
        fresh.append({**row, "date": date, "symbol": instrument_mod.parse(symbol)["symbol"]})
    if not fresh:
        return 0

    needs_header = not path.exists() or path.stat().st_size == 0
    with _open_append(path) as handle:
        if needs_header:
            handle.write(HEADER + "\n")
        handle.write("\n".join(format_row(row) for row in fresh) + "\n")
    return len(fresh)


def rewrite_bars(symbol: str, kind: str, frame: pd.DataFrame, local: bool = False) -> int:
    """Replace one instrument's file with a repaired, sorted frame.

    Only `repair` uses this: appends must stay append-only.
    """
    path = bar_path(symbol, kind, local)
    frame = frame.copy()
    frame["date"] = frame["date"].astype(str).str[:10]
    frame = frame.sort_values("date").drop_duplicates("date", keep="last")
    lines = [HEADER]
    for row in frame.to_dict("records"):
        lines.append(format_row(row))
    path.parent.mkdir(parents=True, exist_ok=True)
    target = path
    if path.suffix == ".gz":
        # Rebuild through the plain text path, then gzip in place.
        import gzip
        import tempfile

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".csv") as temp:
            temp.write("\n".join(lines) + "\n")
            temp_name = temp.name
        with open(temp_name, "rb") as source, gzip.open(target, "wb") as sink:
            sink.write(source.read())
        os.unlink(temp_name)
        return len(lines) - 1
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines) - 1


# ------------------------------------------------------------------- manifest


def _file_stats(path: Path) -> dict[str, Any]:
    first = _first_data_line(path)
    last = _last_line(path)
    if path.suffix == ".gz":
        import gzip

        with gzip.open(path, "rt", encoding="utf-8") as handle:
            rows = max(0, sum(1 for _ in handle) - 1)
    else:
        with path.open("rb") as handle:
            rows = max(0, sum(1 for _ in handle) - 1)
    dates = [line.split(",", 1)[0] for line in (first, last) if line]
    return {
        "rows": rows,
        "firstDate": dates[0] if dates else None,
        "lastDate": dates[-1] if dates else None,
        "bytes": path.stat().st_size,
    }


def rebuild_manifest(universe_name: str | None = None, dataset: str = "daily.cn") -> dict[str, Any]:
    """Recompute `data/manifest.json` from the files on disk."""
    root = daily_dir()
    files = sorted(root.rglob("*.csv")) + sorted(root.rglob("*.csv.gz"))
    by_exchange: dict[str, dict[str, int]] = {}
    sources: Counter[str] = Counter()
    first_date: str | None = None
    last_date_value: str | None = None
    total_rows = 0
    for path in files:
        stats = _file_stats(path)
        total_rows += stats["rows"]
        directory = path.parent.name
        bucket = by_exchange.setdefault(directory, {"symbols": 0, "rows": 0})
        bucket["symbols"] += 1
        bucket["rows"] += stats["rows"]
        if stats["firstDate"] and (first_date is None or stats["firstDate"] < first_date):
            first_date = stats["firstDate"]
        if stats["lastDate"] and (last_date_value is None or stats["lastDate"] > last_date_value):
            last_date_value = stats["lastDate"]
    # Count per-source rows by reading the `src` column (cheap at this size).
    for path in files:
        try:
            frame = pd.read_csv(path, usecols=["src"], dtype=str, keep_default_na=False)
        except ValueError:
            continue
        for value, count in frame["src"].value_counts().items():
            sources[str(value)] += int(count)

    existing = read_json(MANIFEST_PATH) or {}
    datasets = dict(existing.get("datasets", {})) if isinstance(existing, dict) else {}
    datasets[dataset] = {
        "kind": "daily-bar",
        "adjust": "none",
        "format": "csv.gz" if any(path.suffix == ".gz" for path in files) else "csv",
        "fields": COLUMNS,
        "universe": [universe_name] if universe_name else existing.get("universe", []),
        "coverage": {"from": first_date, "to": last_date_value},
        "lastTradeDate": last_date_value,
        "symbolCount": len(files),
        "rowCount": total_rows,
        "byExchange": dict(sorted(by_exchange.items())),
        "sources": dict(sources),
    }
    payload = {
        "schemaVersion": 1,
        "timezone": "Asia/Shanghai",
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "datasets": datasets,
    }
    write_json(MANIFEST_PATH, payload)
    return payload


def read_manifest() -> dict[str, Any] | None:
    payload = read_json(MANIFEST_PATH)
    return payload if isinstance(payload, dict) else None


def dataset(name: str = "daily.cn") -> dict[str, Any] | None:
    payload = read_manifest() or {}
    return (payload.get("datasets") or {}).get(name)


def quality_path() -> Path:
    return DATA / "quality" / "report-latest.json"
