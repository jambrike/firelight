#!/usr/bin/env python3
"""Validate the narrowly targeted, resumable compiler ECR bootstrap plan.

The bootstrap may be resumed after Terraform persisted only part of an earlier
apply.  A safe retry can therefore contain any unique subset of the three
bootstrap resources, but every represented action must be either ``create`` or
``no-op``.  Updates, destruction, replacement, reads, duplicate addresses, and
unrelated resources are rejected before a saved plan can be approved.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence


MAX_PLAN_JSON_BYTES = 32 * 1024 * 1024
BOOTSTRAP_RESOURCE_ADDRESSES = frozenset(
    {
        "aws_ecr_lifecycle_policy.compiler",
        "aws_ecr_repository.compiler",
        "terraform_data.operator_gate",
    }
)
ALLOWED_ACTIONS = {("create",), ("no-op",)}


class EcrBootstrapPlanError(ValueError):
    """A stable error that never includes Terraform plan content."""


def fail(code: str) -> None:
    raise EcrBootstrapPlanError(code)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("PLAN_JSON_KEY_DUPLICATE")
        result[key] = value
    return result


def load_plan(path: Path) -> dict[str, Any]:
    try:
        if not path.is_file() or path.is_symlink():
            fail("PLAN_JSON_NOT_REGULAR_FILE")
        size = path.stat().st_size
        if size <= 0 or size > MAX_PLAN_JSON_BYTES:
            fail("PLAN_JSON_SIZE_INVALID")
        raw = path.read_bytes()
    except OSError as error:
        raise EcrBootstrapPlanError("PLAN_JSON_READ_FAILED") from error

    try:
        plan = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EcrBootstrapPlanError("PLAN_JSON_INVALID") from error
    if not isinstance(plan, dict):
        fail("PLAN_JSON_INVALID")
    return plan


def validate_bootstrap_plan(
    plan: dict[str, Any], *, require_complete: bool = False
) -> None:
    changes = plan.get("resource_changes")
    if not isinstance(changes, list):
        fail("RESOURCE_CHANGES_INVALID")

    seen: set[str] = set()
    actions_by_address: dict[str, tuple[str, ...]] = {}
    for resource_change in changes:
        if not isinstance(resource_change, dict):
            fail("RESOURCE_CHANGE_INVALID")
        address = resource_change.get("address")
        if not isinstance(address, str) or address not in BOOTSTRAP_RESOURCE_ADDRESSES:
            fail("RESOURCE_ADDRESS_INVALID")
        if address in seen:
            fail("RESOURCE_ADDRESS_DUPLICATE")
        seen.add(address)

        change = resource_change.get("change")
        if not isinstance(change, dict):
            fail("RESOURCE_ACTIONS_INVALID")
        raw_actions = change.get("actions")
        if not isinstance(raw_actions, list) or not all(
            isinstance(action, str) for action in raw_actions
        ):
            fail("RESOURCE_ACTIONS_INVALID")
        actions = tuple(raw_actions)
        if actions not in ALLOWED_ACTIONS:
            fail("RESOURCE_ACTIONS_INVALID")
        actions_by_address[address] = actions

    if require_complete and (
        seen != BOOTSTRAP_RESOURCE_ADDRESSES
        or any(actions != ("no-op",) for actions in actions_by_address.values())
    ):
        fail("BOOTSTRAP_NOT_CONVERGED")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan_json", type=Path)
    parser.add_argument("--require-complete", action="store_true")
    arguments = parser.parse_args(argv)

    try:
        plan = load_plan(arguments.plan_json)
        validate_bootstrap_plan(plan, require_complete=arguments.require_complete)
    except EcrBootstrapPlanError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
