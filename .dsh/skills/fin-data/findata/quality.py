"""Row-level validation and the on-disk quality report.

Rules are deliberately conservative: anything questionable is *flagged*, never
dropped, because a suspension, a new listing or a limit day all look anomalous
to a naive check. The report is what a human reviews before publishing.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

import pandas as pd

from . import instruments as instrument_mod
from . import store
from .config import DATA

LIMIT_MAIN = 0.10
LIMIT_GROWTH = 0.20
LIMIT_BJ = 0.30
LIMIT_ST = 0.05


def price_limit(code: str, name: str | None = None) -> float:
    """Daily price-move limit for a board, as a fraction."""
    label = (name or "").upper()
    if "ST" in label:
        return LIMIT_ST
    if code.startswith(("300", "301", "688", "689")):
        return LIMIT_GROWTH
    if code.startswith(("4", "8", "92")):
        return LIMIT_BJ
    return LIMIT_MAIN


def _bad(value: Any) -> bool:
    return value is None or (isinstance(value, float) and pd.isna(value))


def check_rows(
    symbol: str,
    kind: str,
    rows: Iterable[dict[str, Any]],
    prev_close: float | None = None,
    name: str | None = None,
) -> list[dict[str, Any]]:
    """Validate freshly fetched bars; returns one entry per flagged row/rule."""
    parsed = instrument_mod.parse(symbol)
    limit = price_limit(parsed["code"], name or instrument_mod.descriptor(symbol).get("name"))
    flags: list[dict[str, Any]] = []
    reference = prev_close
    # New listings have no price limit for their first sessions; when the file
    # is new we cannot tell a listing from a data gap, so skip the first five.
    grace = 5 if prev_close is None else 0

    for position, row in enumerate(rows):
        date = str(row.get("date"))[:10]
        prices = {key: row.get(key) for key in ("open", "high", "low", "close")}
        if any(_bad(value) or float(value) <= 0 for value in prices.values()):
            flags.append({"symbol": symbol, "date": date, "rule": "PRICE", "detail": "missing or non-positive OHLC"})
            continue
        if float(row["high"]) < max(float(row["open"]), float(row["close"])) or float(row["low"]) > min(
            float(row["open"]), float(row["close"])
        ):
            flags.append({"symbol": symbol, "date": date, "rule": "OHLC", "detail": "high/low inconsistent with open/close"})
        volume = row.get("volume")
        if not _bad(volume) and float(volume) < 0:
            flags.append({"symbol": symbol, "date": date, "rule": "VOLUME", "detail": "negative volume"})
        if reference and float(reference) > 0 and position >= grace:
            move = float(row["close"]) / float(reference) - 1.0
            if move > limit * 1.05 + 0.02:
                flags.append(
                    {
                        "symbol": symbol,
                        "date": date,
                        "rule": "LIMIT_UP",
                        "severity": "error",
                        "detail": f"close moved {move * 100:.2f}% vs prev close, limit {limit * 100:.0f}%",
                    }
                )
            elif move < -(limit * 1.05 + 0.02):
                # Raw (unadjusted) prices drop on ex-rights days; this is
                # expected until the adjustment-factor dataset can explain it.
                flags.append(
                    {
                        "symbol": symbol,
                        "date": date,
                        "rule": "EX_RIGHTS",
                        "severity": "note",
                        "detail": f"close dropped {abs(move) * 100:.2f}%; likely ex-rights on raw prices",
                    }
                )
        reference = float(row["close"])
    return flags


def verify_files() -> dict[str, Any]:
    """Check every stored file for ordering, duplicates and OHLC sanity."""
    root = store.daily_dir()
    files = sorted(root.rglob("*.csv")) + sorted(root.rglob("*.csv.gz"))
    violations: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    rows_total = 0
    checked = 0
    for path in files:
        # Recover the canonical symbol from the first data row (the file name
        # alone cannot tell an index from a stock).
        canonical = f"{path.parent.name}/{path.name}"
        try:
            frame = pd.read_csv(path, dtype=str, keep_default_na=False)
        except Exception as error:
            violations.append({"symbol": canonical, "date": None, "rule": "READ", "detail": str(error)})
            continue
        checked += 1
        rows_total += len(frame)
        if len(frame) and "symbol" in frame.columns:
            canonical = str(frame["symbol"].iloc[0])
        dates = frame["date"].tolist()
        if dates != sorted(dates):
            violations.append({"symbol": canonical, "date": None, "rule": "ORDER", "detail": "dates not ascending"})
        if len(dates) != len(set(dates)):
            violations.append({"symbol": canonical, "date": None, "rule": "DUP", "detail": "duplicate dates"})
        numeric = frame.assign(
            open=pd.to_numeric(frame["open"], errors="coerce"),
            high=pd.to_numeric(frame["high"], errors="coerce"),
            low=pd.to_numeric(frame["low"], errors="coerce"),
            close=pd.to_numeric(frame["close"], errors="coerce"),
        )
        bad_ohlc = numeric[
            (numeric[["open", "high", "low", "close"]] <= 0).any(axis=1)
            | (numeric["high"] < numeric[["open", "close"]].max(axis=1))
            | (numeric["low"] > numeric[["open", "close"]].min(axis=1))
        ]
        for record in bad_ohlc.head(5).to_dict("records"):
            violations.append(
                {"symbol": canonical, "date": record["date"], "rule": "OHLC", "detail": "invalid OHLC values"}
            )

        # Limit-move scan: positive breaks are errors (unexplainable), negative
        # breaks are normally ex-rights on raw prices, so they become notes.
        try:
            parsed = instrument_mod.parse(canonical)
            limit = price_limit(parsed["code"], instrument_mod.descriptor(canonical).get("name"))
        except ValueError:
            continue
        closes = numeric["close"]
        for index in range(1, len(closes)):
            if index < 5:  # IPO grace: first sessions have no price limit
                continue
            previous, current = closes.iloc[index - 1], closes.iloc[index]
            if pd.isna(previous) or pd.isna(current) or previous <= 0:
                continue
            move = float(current) / float(previous) - 1.0
            if move > limit * 1.05 + 0.02:
                violations.append(
                    {
                        "symbol": canonical,
                        "date": dates[index],
                        "rule": "LIMIT_UP",
                        "detail": f"close moved {move * 100:.2f}% vs prev close",
                    }
                )
            elif move < -(limit * 1.05 + 0.02) and len(notes) < 200:
                notes.append(
                    {
                        "symbol": canonical,
                        "date": dates[index],
                        "rule": "EX_RIGHTS",
                        "detail": f"close dropped {abs(move) * 100:.2f}% (expected on raw prices at ex-rights)",
                    }
                )
    report = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "files": checked,
        "rows": rows_total,
        "violations": violations,
        "violationCount": len(violations),
        "notes": notes,
        "noteCount": len(notes),
    }
    store.write_json(store.quality_path(), report)
    return report


def write_rows_report(flags: list[dict[str, Any]], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Persist the sync-time flags (called by `sync`/`update`)."""
    report = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "violations": flags,
        "violationCount": len(flags),
    }
    if extra:
        report.update(extra)
    store.write_json(DATA / "quality" / "report-latest.json", report)
    return report
