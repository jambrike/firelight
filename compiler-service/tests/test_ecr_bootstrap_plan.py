from __future__ import annotations

import contextlib
import io
import itertools
import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

from verify_ecr_bootstrap_plan import (  # noqa: E402
    BOOTSTRAP_RESOURCE_ADDRESSES,
    EcrBootstrapPlanError,
    main,
    validate_bootstrap_plan,
)


def resource_change(address: str, actions: list[str]) -> dict[str, object]:
    return {"address": address, "change": {"actions": actions}}


def plan(*changes: dict[str, object]) -> dict[str, object]:
    return {"format_version": "1.2", "resource_changes": list(changes)}


class EcrBootstrapPlanTests(unittest.TestCase):
    def test_every_unique_create_noop_subset_is_resumable(self):
        addresses = sorted(BOOTSTRAP_RESOURCE_ADDRESSES)
        choices: tuple[list[str] | None, ...] = (None, ["create"], ["no-op"])
        for actions in itertools.product(choices, repeat=len(addresses)):
            with self.subTest(actions=actions):
                changes = [
                    resource_change(address, action)
                    for address, action in zip(addresses, actions, strict=True)
                    if action is not None
                ]
                validate_bootstrap_plan(plan(*changes))

    def test_post_apply_requires_all_three_resources_as_noops(self):
        complete = plan(
            *(
                resource_change(address, ["no-op"])
                for address in sorted(BOOTSTRAP_RESOURCE_ADDRESSES)
            )
        )
        validate_bootstrap_plan(complete, require_complete=True)

        incomplete_or_changing = [
            plan(),
            plan(resource_change(sorted(BOOTSTRAP_RESOURCE_ADDRESSES)[0], ["no-op"])),
            plan(
                *(
                    resource_change(
                        address,
                        ["create"] if index == 0 else ["no-op"],
                    )
                    for index, address in enumerate(
                        sorted(BOOTSTRAP_RESOURCE_ADDRESSES)
                    )
                )
            ),
        ]
        for candidate in incomplete_or_changing:
            with self.subTest(candidate=candidate):
                with self.assertRaisesRegex(
                    EcrBootstrapPlanError, "^BOOTSTRAP_NOT_CONVERGED$"
                ):
                    validate_bootstrap_plan(candidate, require_complete=True)

    def test_drift_destruction_replacement_reads_and_malformed_actions_are_rejected(self):
        address = "aws_ecr_repository.compiler"
        for actions in [
            ["update"],
            ["delete"],
            ["delete", "create"],
            ["create", "delete"],
            ["read"],
            [],
            ["no-op", "create"],
            "create",
            [1],
        ]:
            with self.subTest(actions=actions):
                with self.assertRaisesRegex(
                    EcrBootstrapPlanError, "^RESOURCE_ACTIONS_INVALID$"
                ):
                    validate_bootstrap_plan(
                        plan(resource_change(address, actions))  # type: ignore[arg-type]
                    )

    def test_unrelated_address_is_rejected_even_when_noop(self):
        for actions in (["create"], ["no-op"]):
            with self.subTest(actions=actions):
                with self.assertRaisesRegex(
                    EcrBootstrapPlanError, "^RESOURCE_ADDRESS_INVALID$"
                ):
                    validate_bootstrap_plan(
                        plan(resource_change("aws_vpc.compiler", actions))
                    )

    def test_duplicate_bootstrap_address_is_rejected(self):
        duplicate = resource_change("terraform_data.operator_gate", ["no-op"])
        with self.assertRaisesRegex(
            EcrBootstrapPlanError, "^RESOURCE_ADDRESS_DUPLICATE$"
        ):
            validate_bootstrap_plan(plan(duplicate, duplicate))

    def test_malformed_plan_shapes_are_rejected(self):
        candidates = [
            {},
            {"resource_changes": {}},
            {"resource_changes": [None]},
            {"resource_changes": [{"address": "aws_ecr_repository.compiler"}]},
            {
                "resource_changes": [
                    {
                        "address": "aws_ecr_repository.compiler",
                        "change": None,
                    }
                ]
            },
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                with self.assertRaises(EcrBootstrapPlanError):
                    validate_bootstrap_plan(candidate)

    def test_cli_reports_only_a_stable_error_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text(
                json.dumps(
                    plan(
                        resource_change(
                            "aws_lambda_function.gateway",
                            ["delete", "create"],
                        )
                    )
                ),
                encoding="utf-8",
            )
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = main([str(path)])
            self.assertEqual(result, 1)
            self.assertEqual(stderr.getvalue(), "RESOURCE_ADDRESS_INVALID\n")
            self.assertNotIn("aws_lambda_function", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
