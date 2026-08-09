#!/usr/bin/env python3
"""Print a bounded, redacted summary from Terraform's captured stderr."""

from __future__ import annotations

import re
import sys
from pathlib import Path


MAX_INPUT_BYTES = 256 * 1024
MAX_OUTPUT_LINES = 80
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")
AWS_ARN = re.compile(r"arn:aws(?:-[a-z]+)?:[^\s\"']+")
AWS_ACCOUNT = re.compile(r"(?<!\d)\d{12}(?!\d)")
URL = re.compile(r"https?://[^\s\"']+")
LONG_VALUE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_+/=-]{40,}(?![A-Za-z0-9])")
SENSITIVE_ASSIGNMENT = re.compile(
    r"(?i)(password|secret|token|credential|api[_ -]?key)(\s*[:=]\s*)(\S+)"
)


def redact(line: str) -> str:
    line = AWS_ARN.sub("[AWS_ARN]", line)
    line = AWS_ACCOUNT.sub("[AWS_ACCOUNT]", line)
    line = URL.sub("[URL]", line)
    line = SENSITIVE_ASSIGNMENT.sub(r"\1\2[REDACTED]", line)
    return LONG_VALUE.sub("[REDACTED]", line)


def safe_summary(raw: str) -> list[str]:
    clean = ANSI_ESCAPE.sub("", raw).replace("\r", "")
    lines = clean.splitlines()
    selected: list[str] = []
    in_error = False

    for line in lines:
        stripped = line.strip(" │")
        if stripped.startswith("Error:"):
            in_error = True
        elif in_error and stripped.startswith("Warning:"):
            in_error = False

        if in_error and stripped:
            selected.append(redact(stripped))
            if len(selected) >= MAX_OUTPUT_LINES:
                break

    if not selected:
        return ["Terraform failed without a safe diagnostic summary."]
    return selected


def main() -> int:
    if len(sys.argv) != 2:
        print("Terraform failed without a safe diagnostic summary.", file=sys.stderr)
        return 0

    path = Path(sys.argv[1])
    try:
        raw = path.read_bytes()[:MAX_INPUT_BYTES].decode("utf-8", errors="replace")
    except (OSError, ValueError):
        print("Terraform failed without a safe diagnostic summary.", file=sys.stderr)
        return 0

    for line in safe_summary(raw):
        print(line, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
