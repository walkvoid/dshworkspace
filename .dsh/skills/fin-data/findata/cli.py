"""Command line entry point.

Every command prints JSON (except `get --format csv` and the human `status`), so
the skill can pipe results straight into an answer and quote `asOf`/`sources`.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import quality, sync, universe
from . import query, store


def _print(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fin-data", description="A-share daily bars, one CSV per instrument")
    sub = parser.add_subparsers(dest="command", required=True)

    sync_parser = sub.add_parser("sync", help="fetch missing bars for a universe")
    sync_parser.add_argument("--universe", help="universe name (default: config.universe)")
    sync_parser.add_argument("--since", help="override history start, YYYY-MM-DD")
    sync_parser.add_argument("--full", action="store_true", help="re-fetch from history_start")
    sync_parser.add_argument("--symbols", help="comma separated symbols to sync")
    sync_parser.add_argument("--quiet", action="store_true")

    update_parser = sub.add_parser("update", help="daily incremental update")
    update_parser.add_argument("--universe")
    update_parser.add_argument("--quiet", action="store_true")

    get_parser = sub.add_parser("get", help="read bars for one instrument")
    get_parser.add_argument("symbol", nargs="?", help="e.g. 600519.SH")
    get_parser.add_argument("--symbol", dest="symbol_option", help="same as the positional form")
    get_parser.add_argument("--start")
    get_parser.add_argument("--end")
    get_parser.add_argument("--adjust", default="raw", choices=["raw"])
    get_parser.add_argument("--format", choices=["json", "csv"], default="json")

    status_parser = sub.add_parser("status", help="freshness and coverage")
    status_parser.add_argument("--json", action="store_true")

    sub.add_parser("verify", help="scan stored files for structural problems")

    list_parser = sub.add_parser("list-universe", help="show a universe's members")
    list_parser.add_argument("name", nargs="?")

    build_parser_ = sub.add_parser("build-universe", help="(re)build a universe from its index")
    build_parser_.add_argument("name")

    return parser


def _human_status(payload: dict[str, Any]) -> str:
    coverage = payload.get("coverage") or {}
    stale = payload.get("stale")
    verdict = "STALE - run `fin-data update`" if stale else "fresh"
    lines = [
        f"dataset      daily.cn (universe={payload.get('universe')})",
        f"coverage     {coverage.get('from')} .. {coverage.get('to')}",
        f"latest trade {payload.get('latestTradeDate')} ({verdict})",
        f"data         {payload.get('files')} files, {payload.get('rows')} rows, {payload.get('sizeMB')} MB",
        f"sources      {payload.get('sources')}",
    ]
    for warning in payload.get("warnings") or []:
        lines.append(f"warning      {warning}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "sync":
            only = [item.strip() for item in args.symbols.split(",") if item.strip()] if args.symbols else None
            summary = sync.sync(
                universe=args.universe,
                since=args.since,
                full=args.full,
                only=only,
                quiet=args.quiet,
            )
            return 0 if summary.get("ok") else 2

        if args.command == "update":
            summary = sync.update(universe=args.universe, quiet=args.quiet)
            return 0 if summary.get("ok") else 2

        if args.command == "get":
            symbol = args.symbol or args.symbol_option
            if not symbol:
                print("error: get requires a symbol", file=sys.stderr)
                return 2
            if args.format == "csv":
                frame = query.load_bars(symbol, args.start, args.end, args.adjust)
                sys.stdout.write(frame.to_csv(index=False, float_format="%.2f"))
                return 0
            _print(query.payload(symbol, args.start, args.end, args.adjust))
            return 0

        if args.command == "status":
            payload = sync.current_status()
            if args.json:
                _print(payload)
            else:
                print(_human_status(payload))
            return 0

        if args.command == "verify":
            _print(quality.verify_files())
            return 0

        if args.command == "list-universe":
            if args.name:
                _print(universe.load_universe(args.name))
            else:
                names = sorted(path.stem for path in (store.DATA / "universes").glob("*.json"))
                _print({"universes": names})
            return 0

        if args.command == "build-universe":
            _print(universe.build(args.name))
            return 0
    except FileNotFoundError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - the CLI is the boundary
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
