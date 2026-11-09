"""Sync orchestration: plan missing ranges, fetch through the chain, append.

`update` is the daily path (append only the sessions that are missing);
`sync --full` is the bootstrap/rebuild path. Both share the same per-symbol
failover, so one bad symbol never blocks the batch.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from . import calendar as trading_calendar
from . import instruments as instrument_mod
from . import quality, sources, store
from .config import ensure_dirs, load_config
from .sources import AllProvidersFailed
from .universe import load_universe


def latest_target(cfg: dict[str, Any]) -> str | None:
    """Latest session that should have a closing bar by now."""
    trading_calendar.ensure()
    return trading_calendar.latest_closed(close_time=cfg["update"]["close_time"])


def _resolve_members(name: str, only: list[str] | None) -> list[dict[str, Any]]:
    members = list(load_universe(name).get("members", []))
    if not only:
        return members
    wanted = {instrument_mod.parse(item)["symbol"] for item in only}
    selected = [member for member in members if member["symbol"] in wanted]
    known = {member["symbol"] for member in selected}
    for symbol in sorted(wanted - known):
        selected.append({"symbol": symbol, "kind": instrument_mod.kind_of(symbol), "name": None})
    return selected


def sync(
    universe: str | None = None,
    since: str | None = None,
    full: bool = False,
    only: list[str] | None = None,
    quiet: bool = False,
) -> dict[str, Any]:
    """Fetch missing bars for every member of a universe."""
    cfg = load_config()
    ensure_dirs()
    target = latest_target(cfg)
    if target is None:
        raise RuntimeError("trading calendar has no usable session")
    name = universe or cfg["universe"]
    members = _resolve_members(name, only)
    history_start = since or cfg["history_start"]

    added = 0
    updated_symbols = 0
    failures: list[dict[str, Any]] = []
    flags: list[dict[str, Any]] = []
    skipped: list[str] = []
    per_source: dict[str, int] = {}

    for member in members:
        symbol = member["symbol"]
        kind = member.get("kind") or instrument_mod.kind_of(symbol)
        last = store.last_date(symbol, kind)
        start = history_start if (full or not last) else trading_calendar.next_day(last)
        if start > target:
            skipped.append(symbol)
            continue
        try:
            rows, provider = sources.fetch_daily(symbol, kind, start, target, cfg)
        except AllProvidersFailed as error:
            failures.append(error.as_dict())
            if not quiet:
                print(f"[fail] {error}", flush=True)
            continue
        previous = store.last_close(symbol, kind)
        flags.extend(quality.check_rows(symbol, kind, rows, prev_close=previous, name=member.get("name")))
        written = store.append_bars(symbol, kind, rows)
        added += written
        updated_symbols += 1
        per_source[provider] = per_source.get(provider, 0) + 1
        if not quiet:
            print(f"{symbol:<12} {start}..{target}  +{written:<6} {provider}", flush=True)

    manifest = store.rebuild_manifest(name)
    dataset = (manifest.get("datasets") or {}).get("daily.cn", {})
    report = None
    if added or failures or flags:
        # A no-op update must not wipe the previous report.
        report = quality.write_rows_report(
            flags,
            {
                "lastTradeDate": target,
                "failedSymbols": [failure["symbol"] for failure in failures],
                "skippedSymbols": skipped,
            },
        )
    summary = {
        "ok": not failures,
        "universe": name,
        "target": target,
        "symbols": len(members),
        "updated": updated_symbols,
        "addedRows": added,
        "skipped": len(skipped),
        "failures": failures,
        "violations": len([flag for flag in flags if flag.get("severity") != "note"]),
        "notes": len([flag for flag in flags if flag.get("severity") == "note"]),
        "perSource": per_source,
        "coverage": dataset.get("coverage"),
        "rowCount": dataset.get("rowCount"),
        "startedAt": datetime.now().isoformat(timespec="seconds"),
        "report": (report or {}).get("violationCount", 0),
    }
    if not quiet:
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return summary


def update(universe: str | None = None, quiet: bool = False) -> dict[str, Any]:
    """Daily incremental update (alias of `sync` without `--full`)."""
    return sync(universe=universe, full=False, quiet=quiet)


def _dir_size(path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def current_status() -> dict[str, Any]:
    """Freshness and coverage summary for the skill/agent to act on."""
    cfg = load_config()
    dataset = store.dataset() or {}
    warnings: list[str] = []
    target: str | None = None
    try:
        target = latest_target(cfg)
    except Exception as error:  # a calendar/network failure must not hide the data
        warnings.append(f"calendar unavailable: {error}")
    last = dataset.get("lastTradeDate")
    stale = bool(target and (last or "") < target)
    universe = cfg["universe"]
    members: list[dict[str, Any]] = []
    try:
        members = load_universe(universe).get("members", [])
    except Exception:
        warnings.append(f"universe {universe!r} is not built yet")
    size = _dir_size(store.daily_dir())
    return {
        "ok": True,
        "dataset": "daily.cn",
        "universe": universe,
        "symbolsInUniverse": len(members),
        "files": dataset.get("symbolCount", 0),
        "rows": dataset.get("rowCount", 0),
        "lastTradeDate": last,
        "latestTradeDate": target,
        "stale": stale,
        "coverage": dataset.get("coverage"),
        "sizeMB": round(size / (1024 * 1024), 2),
        "sources": dataset.get("sources", {}),
        "warnings": warnings,
    }
