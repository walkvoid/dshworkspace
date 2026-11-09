"""Unit tests for store, instrument parsing, quality rules and calendar.

The store writes into a temporary `FIN_DATA_HOME`, so tests never touch the
committed dataset.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from datetime import datetime

_TMP = tempfile.mkdtemp(prefix="fin-data-test-")
os.environ["FIN_DATA_HOME"] = _TMP

from findata import calendar, config, instruments, quality, store  # noqa: E402


def _row(date: str, close: float = 10.0, symbol: str = "600519.SH") -> dict:
    return {
        "date": date,
        "symbol": symbol,
        "open": close - 0.1,
        "high": close + 0.2,
        "low": close - 0.3,
        "close": close,
        "volume": 1000,
        "amount": 10000.0,
        "turnover": 0.5,
        "src": "ak",
    }


class InstrumentTests(unittest.TestCase):
    def test_accepted_spellings(self):
        for value in ("600519", "sh600519", "cn:sh600519", "600519.SH", "600519.sh"):
            self.assertEqual(instruments.parse(value)["symbol"], "600519.SH", value)

    def test_bare_code_inference(self):
        self.assertEqual(instruments.parse("000001")["symbol"], "000001.SZ")
        self.assertEqual(instruments.parse("920992")["symbol"], "920992.BJ")
        self.assertEqual(instruments.parse("688981")["symbol"], "688981.SH")

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            instruments.parse("not-a-symbol")


class StoreTests(unittest.TestCase):
    def setUp(self):
        config.ensure_dirs()

    def test_format_row_units(self):
        line = store.format_row(_row("2026-11-07", 1439.12))
        self.assertEqual(line, "2026-11-07,600519.SH,1439.02,1439.32,1438.82,1439.12,1000,10000.00,0.50,ak")

    def test_append_is_monotonic_and_idempotent(self):
        symbol, kind = "600519.SH", "stock"
        path = store.bar_path(symbol, kind)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(store.HEADER + "\n", encoding="utf-8")

        written = store.append_bars(symbol, kind, [_row("2026-11-05", 10.0), _row("2026-11-06", 10.5)])
        self.assertEqual(written, 2)
        self.assertEqual(store.last_date(symbol, kind), "2026-11-06")
        self.assertAlmostEqual(store.last_close(symbol, kind), 10.5)

        # Same input again: nothing new, no duplicate rows.
        self.assertEqual(store.append_bars(symbol, kind, [_row("2026-11-06", 10.5)]), 0)
        # Older rows are ignored, newer rows append.
        written = store.append_bars(
            symbol, kind, [_row("2026-11-04", 9.0), _row("2026-11-07", 11.0), _row("2026-11-07", 11.0)]
        )
        self.assertEqual(written, 1)

        frame = store.read_bars(symbol, kind)
        self.assertEqual(frame["date"].tolist(), ["2026-11-05", "2026-11-06", "2026-11-07"])
        self.assertEqual(str(frame["volume"].dtype), "Int64")

    def test_rewrite_sorts_and_dedupes(self):
        symbol, kind = "000001.SZ", "stock"
        import pandas as pd

        frame = pd.DataFrame([_row("2026-11-07", 2.0, symbol), _row("2026-11-06", 1.0, symbol)])
        self.assertEqual(store.rewrite_bars(symbol, kind, frame), 2)
        self.assertEqual(store.read_bars(symbol, kind)["date"].tolist(), ["2026-11-06", "2026-11-07"])

    def test_manifest_rebuild(self):
        import pandas as pd

        store.rewrite_bars("600519.SH", "stock", pd.DataFrame([_row("2026-11-06", 10.0)]))
        store.rewrite_bars("000001.SZ", "stock", pd.DataFrame([_row("2026-11-06", 5.0, "000001.SZ")]))
        store.rebuild_manifest("sse50")
        dataset = store.dataset("daily.cn")
        self.assertIsNotNone(dataset)
        self.assertGreaterEqual(dataset["symbolCount"], 2)
        self.assertIn("coverage", dataset)


class QualityTests(unittest.TestCase):
    def test_price_limits(self):
        self.assertAlmostEqual(quality.price_limit("600519"), 0.10)
        self.assertAlmostEqual(quality.price_limit("300750"), 0.20)
        self.assertAlmostEqual(quality.price_limit("688981"), 0.20)
        self.assertAlmostEqual(quality.price_limit("920992"), 0.30)

    def test_flags_bad_ohlc(self):
        row = _row("2026-11-07", 10.0)
        row["high"] = 9.0  # below open/close
        flags = quality.check_rows("600519.SH", "stock", [row])
        self.assertTrue(any(flag["rule"] == "OHLC" for flag in flags))

    def test_flags_limit_move(self):
        flags = quality.check_rows("600519.SH", "stock", [_row("2026-11-07", 20.0)], prev_close=10.0)
        self.assertTrue(any(flag["rule"] == "LIMIT_UP" for flag in flags))

    def test_ex_rights_is_a_note_not_an_error(self):
        flags = quality.check_rows("600519.SH", "stock", [_row("2026-11-07", 8.0)], prev_close=10.0)
        self.assertTrue(any(flag["rule"] == "EX_RIGHTS" and flag["severity"] == "note" for flag in flags))

    def test_ipo_grace_skips_first_five_sessions(self):
        rows = [_row(f"2026-11-{day:02d}", 10.0 * (2**position)) for position, day in enumerate(range(2, 7))]
        flags = quality.check_rows("600519.SH", "stock", rows, prev_close=None)
        self.assertEqual([flag for flag in flags if flag["rule"] == "LIMIT_UP"], [])


class CalendarTests(unittest.TestCase):
    def test_latest_closed_before_close_time(self):
        store.write_json(
            calendar.PATH,
            {
                "source": "test",
                "fetchedAt": datetime.now().isoformat(timespec="seconds"),
                "dates": ["2026-11-05", "2026-11-06", "2026-11-09"],
            },
        )
        at = datetime(2026, 11, 9, 10, 0)
        self.assertEqual(calendar.latest_closed(at, "15:30"), "2026-11-06")
        at = datetime(2026, 11, 9, 16, 0)
        self.assertEqual(calendar.latest_closed(at, "15:30"), "2026-11-09")
        weekend = datetime(2026, 11, 8, 12, 0)
        self.assertEqual(calendar.latest_closed(weekend, "15:30"), "2026-11-06")


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
