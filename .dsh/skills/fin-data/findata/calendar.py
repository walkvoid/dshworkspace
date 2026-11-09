"""Trading calendar: which dates are sessions, and what "latest closed" means.

The calendar is a committed JSON file (`data/calendar/trade-dates.json`) fetched
from akshare's Sina endpoint. It is the *only* source of truth for "should
today's bar exist"; a stale calendar can otherwise make `update` silently skip
a day.
"""

from __future__ import annotations

from datetime import datetime, time
from typing import Iterable

from .config import DATA
from .store import read_json, write_json

PATH = DATA / "calendar" / "trade-dates.json"

# Far enough back for any 10-year window we might ask for.
_FLOOR = "2010-01-01"


def load() -> list[str]:
    """Read the stored ISO dates (ascending)."""
    payload = read_json(PATH)
    if not isinstance(payload, dict):
        return []
    dates = payload.get("dates", [])
    return [str(item) for item in dates if str(item) >= _FLOOR]


def _fetch() -> list[str]:
    """Fetch the Sina trade-date history through akshare."""
    import akshare as ak  # lazy: reading data does not need akshare

    frame = ak.tool_trade_date_hist_sina()
    column = "trade_date" if "trade_date" in frame.columns else frame.columns[0]
    dates = sorted({str(value)[:10] for value in frame[column].astype(str)})
    return [value for value in dates if value >= _FLOOR]


def ensure(force: bool = False, today: str | None = None) -> list[str]:
    """Load the calendar, refreshing it when it was fetched on an earlier day."""
    today = today or datetime.now().date().isoformat()
    dates = load()
    payload = read_json(PATH) or {}
    fetched_on = str(payload.get("fetchedAt", ""))[:10]
    if force or not dates or fetched_on < today:
        try:
            fresh = _fetch()
        except Exception:
            fresh = []
        if fresh:
            dates = fresh
            write_json(
                PATH,
                {
                    "source": "akshare:tool_trade_date_hist_sina",
                    "fetchedAt": datetime.now().isoformat(timespec="seconds"),
                    "count": len(dates),
                    "dates": dates,
                },
            )
        elif not dates:
            raise RuntimeError("trading calendar is empty and akshare could not be fetched")
    return dates


def is_trade_date(value: str) -> bool:
    """Whether `YYYY-MM-DD` is a session in the stored calendar."""
    return value[:10] in set(load())


def latest_closed(now: datetime | None = None, close_time: str = "15:30") -> str | None:
    """Latest session whose closing bar should already exist.

    On a trading day before `close_time` the previous session is returned, so a
    scheduled update cannot ask for a bar that has not settled yet.
    """
    now = now or datetime.now()
    today = now.date().isoformat()
    dates = load()
    eligible = [value for value in dates if value <= today]
    if not eligible:
        return None
    last = eligible[-1]
    if last == today and now.time() < time.fromisoformat(close_time):
        return eligible[-2] if len(eligible) > 1 else None
    return last


def next_day(value: str) -> str:
    """Calendar day after an ISO date."""
    from datetime import date, timedelta

    return (date.fromisoformat(value[:10]) + timedelta(days=1)).isoformat()


def sessions_between(start: str, end: str) -> list[str]:
    """Sessions in `[start, end]`, for coverage checks."""
    return [value for value in load() if start <= value <= end]


def _unused(values: Iterable[str]) -> None:  # pragma: no cover - keeps typing honest
    list(values)
