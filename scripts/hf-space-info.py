#!/usr/bin/env python3
"""通过固定版本 Python SDK 读取 Hugging Face Space 并输出稳定 JSON。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi


EXPAND = ["sha", "runtime", "private", "sdk", "subdomain"]


def required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def normalize_runtime(runtime: Any) -> dict[str, Any] | None:
    if runtime is None:
        return None
    raw = getattr(runtime, "raw", None)
    if not isinstance(raw, dict):
        raise RuntimeError("Hugging Face returned an invalid Space runtime payload")
    return {
        "stage": getattr(runtime, "stage", None),
        "raw": raw,
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise RuntimeError("Usage: hf-space-info.py OUTPUT_PATH")

    space_id = required_environment("HF_SPACE_ID")
    token = required_environment("HF_TOKEN")
    info = HfApi(token=token).space_info(space_id, timeout=30, expand=EXPAND)
    if not isinstance(info.sha, str) or not info.sha:
        raise RuntimeError("Hugging Face Space response is missing repository SHA")

    document = {
        "id": info.id,
        "sha": info.sha,
        "private": info.private,
        "sdk": info.sdk,
        "subdomain": info.subdomain,
        "runtime": normalize_runtime(info.runtime),
    }
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        f"{json.dumps(document, ensure_ascii=False, sort_keys=True)}\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
