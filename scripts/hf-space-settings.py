#!/usr/bin/env python3
"""通过固定版本 Python SDK 写入、回读 Space Variables 并触发重启。"""

from __future__ import annotations

import os
import re

from huggingface_hub import HfApi


SOURCE_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
VARIABLE_NAMES = (
    "FAP_ARTIFACT_MANIFEST_HF_URI",
    "FAP_ARTIFACT_EXPECTED_SOURCE_REF",
    "FAP_ARTIFACT_MAX_BYTES",
)


def required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def main() -> int:
    space_id = required_environment("HF_SPACE_ID")
    token = required_environment("HF_TOKEN")
    values = {name: required_environment(name) for name in VARIABLE_NAMES}
    source_ref = values["FAP_ARTIFACT_EXPECTED_SOURCE_REF"]
    manifest_uri = values["FAP_ARTIFACT_MANIFEST_HF_URI"]

    if not SOURCE_SHA_RE.fullmatch(source_ref):
        raise RuntimeError("FAP_ARTIFACT_EXPECTED_SOURCE_REF must be a full lowercase commit SHA")
    if not manifest_uri.startswith("hf://buckets/") or not manifest_uri.endswith(
        f"/edge/{source_ref}/manifest.json"
    ):
        raise RuntimeError("FAP_ARTIFACT_MANIFEST_HF_URI does not match the expected source ref")
    try:
        max_bytes = int(values["FAP_ARTIFACT_MAX_BYTES"])
    except ValueError as error:
        raise RuntimeError("FAP_ARTIFACT_MAX_BYTES must be a positive integer") from error
    if max_bytes <= 0:
        raise RuntimeError("FAP_ARTIFACT_MAX_BYTES must be a positive integer")

    api = HfApi(token=token)
    for key, value in values.items():
        api.add_space_variable(space_id, key, value)

    observed = api.get_space_variables(space_id)
    mismatches = [
        key
        for key, expected in values.items()
        if key not in observed or getattr(observed[key], "value", None) != expected
    ]
    if mismatches:
        raise RuntimeError(f"Space variable readback mismatch: {', '.join(mismatches)}")

    api.restart_space(space_id)
    print(f"space_variables_verified={len(values)}")
    print("space_restart_requested=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
