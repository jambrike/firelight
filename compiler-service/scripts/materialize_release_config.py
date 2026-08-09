#!/usr/bin/env python3
"""Materialize reviewed Terraform inputs without shell interpolation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Mapping


SCRIPT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_ROOT))

from verify_release_config import (  # noqa: E402
    ECR_BOOTSTRAP_IMAGE_DIGEST,
    ReleaseConfigError,
    load_ecr_bootstrap_release,
    load_release,
)


ROLE_NAMES = {
    "staging": "FirelightCompilerStagingDeploy",
    "production": "FirelightCompilerProductionDeploy",
}
SERVICE_NAMES = {
    "staging": "firelight-compiler-stg",
    "production": "firelight-compiler-prd",
}


class MaterializeError(ValueError):
    pass


def fail(code: str) -> None:
    raise MaterializeError(code)


def required(environment: Mapping[str, str], name: str, maximum: int) -> str:
    value = environment.get(name)
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or value.strip() != value
    ):
        fail(f"INVALID_{name}")
    return value


def parse_environment(
    environment: Mapping[str, str],
    *,
    ecr_bootstrap: bool,
) -> tuple[str, dict[str, object], dict[str, object]]:
    release_environment = required(
        environment,
        "FIRELIGHT_COMPILER_ENVIRONMENT",
        10,
    )
    if release_environment not in ROLE_NAMES:
        fail("INVALID_FIRELIGHT_COMPILER_ENVIRONMENT")
    account_id = required(environment, "AWS_ACCOUNT_ID", 12)
    state_bucket = required(
        environment,
        "FIRELIGHT_TERRAFORM_STATE_BUCKET",
        63,
    )
    state_kms = required(
        environment,
        "FIRELIGHT_TERRAFORM_STATE_KMS_KEY_ARN",
        256,
    )
    supplied_image_digest = environment.get("FIRELIGHT_COMPILER_IMAGE_DIGEST")
    if ecr_bootstrap:
        if supplied_image_digest not in (None, "", ECR_BOOTSTRAP_IMAGE_DIGEST):
            fail("ECR_BOOTSTRAP_IMAGE_DIGEST_INVALID")
        image_digest = ECR_BOOTSTRAP_IMAGE_DIGEST
    else:
        image_digest = required(
            environment,
            "FIRELIGHT_COMPILER_IMAGE_DIGEST",
            71,
        )
    auth_secret = required(
        environment,
        "FIRELIGHT_COMPILER_AUTH_SECRET_ARN",
        256,
    )
    release_build_id = required(
        environment,
        "FIRELIGHT_COMPILER_RELEASE_BUILD_ID",
        40,
    )
    vpc_cidr = required(environment, "FIRELIGHT_COMPILER_VPC_CIDR", 18)
    auth_secret_kms = environment.get("FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN")
    if auth_secret_kms == "":
        auth_secret_kms = None
    elif auth_secret_kms is not None:
        auth_secret_kms = required(
            environment,
            "FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN",
            256,
        )

    backend = {
        "allowed_account_ids": [account_id],
        "bucket": state_bucket,
        "encrypt": True,
        "key": f"firelight/compiler/{release_environment}/terraform.tfstate",
        "kms_key_id": state_kms,
        "region": "eu-west-1",
        "use_lockfile": True,
    }
    variables = {
        "auth_secret_arn": auth_secret,
        "auth_secret_kms_key_arn": auth_secret_kms,
        "aws_account_id": account_id,
        "compiler_desired_count": 2,
        "deployment_role_name": ROLE_NAMES[release_environment],
        "enable_deletion_protection": True,
        "environment": release_environment,
        "gateway_reserved_concurrency": -1,
        "image_digest": image_digest,
        "log_retention_days": 14,
        "release_build_id": release_build_id,
        "service_name": SERVICE_NAMES[release_environment],
        "vpc_cidr": vpc_cidr,
    }
    return release_environment, backend, variables


def backend_hcl(values: Mapping[str, object]) -> str:
    ordered_keys = (
        "bucket",
        "key",
        "region",
        "encrypt",
        "use_lockfile",
        "kms_key_id",
        "allowed_account_ids",
    )
    return "".join(
        f"{key} = {json.dumps(values[key], separators=(',', ':'))}\n"
        for key in ordered_keys
    )


def validate_output_path(path: Path) -> None:
    if not path.is_absolute() or path.name in {"", ".", ".."}:
        fail("OUTPUT_PATH_INVALID")
    parent = path.parent
    if not parent.is_dir() or parent.is_symlink():
        fail("OUTPUT_PARENT_INVALID")
    if path.exists() or path.is_symlink():
        fail("OUTPUT_ALREADY_EXISTS")


def create_private_file(path: Path, content: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    created = False
    try:
        descriptor = os.open(path, flags, 0o600)
        created = True
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if path.stat().st_mode & 0o777 != 0o600:
            fail("OUTPUT_PERMISSIONS_INVALID")
    except FileExistsError as error:
        raise MaterializeError("OUTPUT_ALREADY_EXISTS") from error
    except MaterializeError:
        if created:
            try:
                path.unlink()
            except OSError:
                pass
        raise
    except OSError as error:
        if created:
            try:
                path.unlink()
            except OSError:
                pass
        raise MaterializeError("OUTPUT_WRITE_FAILED") from error


def materialize(
    environment: Mapping[str, str],
    backend_output: Path,
    variables_output: Path,
    *,
    ecr_bootstrap: bool = False,
) -> None:
    if backend_output == variables_output:
        fail("OUTPUT_PATH_COLLISION")
    validate_output_path(backend_output)
    validate_output_path(variables_output)
    release_environment, backend, variables = parse_environment(
        environment,
        ecr_bootstrap=ecr_bootstrap,
    )
    created: list[Path] = []
    try:
        create_private_file(backend_output, backend_hcl(backend))
        created.append(backend_output)
        create_private_file(
            variables_output,
            json.dumps(variables, indent=2, sort_keys=True) + "\n",
        )
        created.append(variables_output)
        if ecr_bootstrap:
            load_ecr_bootstrap_release(
                release_environment,
                backend_output,
                variables_output,
            )
        else:
            load_release(release_environment, backend_output, variables_output)
    except (MaterializeError, ReleaseConfigError):
        for path in created:
            try:
                path.unlink()
            except OSError:
                pass
        raise


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend-output", type=Path, required=True)
    parser.add_argument("--variables-output", type=Path, required=True)
    parser.add_argument(
        "--ecr-bootstrap",
        action="store_true",
        help="materialize only the sentinel inputs for a targeted ECR bootstrap",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    materialize(
        os.environ,
        args.backend_output,
        args.variables_output,
        ecr_bootstrap=args.ecr_bootstrap,
    )
    if args.ecr_bootstrap:
        print("compiler_ecr_bootstrap_configuration_materialized=true")
    else:
        print("compiler_release_configuration_materialized=true")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (MaterializeError, ReleaseConfigError) as error:
        print(f"Compiler release configuration rejected [{error}].", file=sys.stderr)
        raise SystemExit(1) from None
