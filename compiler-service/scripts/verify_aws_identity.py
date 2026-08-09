#!/usr/bin/env python3
"""Reject root, IAM-user, and wrong-role AWS sessions before compiler release."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


MAX_IDENTITY_BYTES = 16 * 1024
ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
ROLE_NAMES = {
    "staging": "FirelightCompilerStagingDeploy",
    "production": "FirelightCompilerProductionDeploy",
}


class IdentityError(ValueError):
    pass


def fail(code: str) -> None:
    raise IdentityError(code)


def verify_identity(
    value: Any,
    *,
    environment: str,
    expected_account_id: str,
) -> dict[str, str]:
    if environment not in ROLE_NAMES:
        fail("ENVIRONMENT_INVALID")
    if not ACCOUNT_ID.fullmatch(expected_account_id):
        fail("EXPECTED_ACCOUNT_ID_INVALID")
    if not isinstance(value, dict) or set(value) != {"Account", "Arn", "UserId"}:
        fail("AWS_IDENTITY_INVALID")
    if value["Account"] != expected_account_id:
        fail("AWS_ACCOUNT_MISMATCH")
    role_name = ROLE_NAMES[environment]
    expected_arn = re.compile(
        rf"^arn:aws:sts::{re.escape(expected_account_id)}:"
        rf"assumed-role/{re.escape(role_name)}/[A-Za-z0-9+=,.@_-]{{2,64}}$"
    )
    arn = value["Arn"]
    user_id = value["UserId"]
    if (
        not isinstance(arn, str)
        or not expected_arn.fullmatch(arn)
        or not isinstance(user_id, str)
        or not re.fullmatch(r"AROA[A-Z0-9]+:[A-Za-z0-9+=,.@_-]{2,64}", user_id)
    ):
        fail("AWS_DEPLOYMENT_ROLE_REQUIRED")
    return {
        "account_id": expected_account_id,
        "environment": environment,
        "role_name": role_name,
    }


def read_identity(path: Path) -> Any:
    try:
        if path.is_symlink() or not path.is_file():
            fail("AWS_IDENTITY_FILE_INVALID")
        raw = path.read_bytes()
    except OSError as error:
        raise IdentityError("AWS_IDENTITY_READ_FAILED") from error
    if not raw or len(raw) > MAX_IDENTITY_BYTES:
        fail("AWS_IDENTITY_FILE_INVALID")
    try:
        return json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IdentityError("AWS_IDENTITY_JSON_INVALID") from error


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("AWS_IDENTITY_KEY_DUPLICATE")
        result[key] = value
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("identity_file", type=Path)
    parser.add_argument("--environment", choices=sorted(ROLE_NAMES), required=True)
    parser.add_argument("--expected-account-id", required=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    result = verify_identity(
        read_identity(args.identity_file),
        environment=args.environment,
        expected_account_id=args.expected_account_id,
    )
    print(f"aws_account_id={result['account_id']}")
    print(f"aws_environment={result['environment']}")
    print(f"aws_role_name={result['role_name']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except IdentityError as error:
        print(f"AWS release identity rejected [{error}].", file=sys.stderr)
        raise SystemExit(1) from None
