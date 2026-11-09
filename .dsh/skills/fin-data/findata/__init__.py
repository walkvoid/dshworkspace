"""fin-data: A-share daily bars, stored as one CSV per instrument.

Public surface used by the skill:

    from findata import load_bars, status
    rows = load_bars("600519.SH", start="2026-01-01")
"""

from .query import load_bars
from .store import read_manifest

__all__ = ["load_bars", "read_manifest", "status", "main"]


def status():
    """Thin re-export so callers and the CLI share one code path."""
    from .sync import current_status

    return current_status()


def main(argv=None):
    from .cli import main as cli_main

    return cli_main(argv)
