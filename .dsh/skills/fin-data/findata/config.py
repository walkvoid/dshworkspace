"""Paths and configuration for the fin-data skill.

Everything is resolved relative to the skill directory, so the store works both
in-repo (`dshworkspace/.dsh/skills/fin-data`) and when installed elsewhere by
`install-skills.mjs` (link or copy).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parent.parent
# `FIN_DATA_HOME` lets tests (and alternate installs) point the store elsewhere.
DATA = Path(os.environ["FIN_DATA_HOME"]) if os.environ.get("FIN_DATA_HOME") else ROOT / "data"
CONFIG_PATH = ROOT / "config.json"

DEFAULTS: dict[str, Any] = {
    "timezone": "Asia/Shanghai",
    "history_start": "2016-01-01",
    "universe": "sse50",
    "storage": {"compress": "none"},
    "sources": {
        "order": ["akshare", "adata", "ifind", "web"],
        "concurrency": 1,
        "min_interval_ms": 250,
        "retries": 3,
    },
    "update": {"close_time": "15:30"},
    "git": {"autoCommit": False},
}


def _merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(merged.get(key), Mapping):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config() -> dict[str, Any]:
    """Read `config.json`, merged over the built-in defaults."""
    if not CONFIG_PATH.exists():
        return _merge(DEFAULTS, {})
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return _merge(DEFAULTS, raw)


def ensure_dirs() -> None:
    """Create the data directories the store writes to."""
    for path in (
        DATA,
        DATA / "calendar",
        DATA / "universes",
        DATA / "daily" / "cn",
        DATA / "quality",
        DATA / "local",
    ):
        path.mkdir(parents=True, exist_ok=True)
