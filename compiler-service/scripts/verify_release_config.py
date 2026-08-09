#!/usr/bin/env python3
"""Validate compiler Terraform release inputs without contacting AWS.

The validator deliberately understands only Firelight's narrow backend HCL
shape and JSON variable files. It rejects credentials, placeholders, unknown
keys, cross-account ARNs, environment drift, and unsafe runtime defaults before
an operator is allowed to run Terraform init or plan.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_CONFIG_BYTES = 64 * 1024
ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
BUILD_ID = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ECR_BOOTSTRAP_IMAGE_DIGEST = f"sha256:{'0' * 64}"
ISOLATION_FINGERPRINT_DOMAIN = b"firelight.compiler-release-isolation.v1\0"
KMS_KEY_ARN = re.compile(
    r"^arn:aws:kms:eu-west-1:([0-9]{12}):key/"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
SECRET_ARN = re.compile(
    r"^arn:aws:secretsmanager:eu-west-1:([0-9]{12}):"
    r"secret:firelight/(staging|production)/compiler-auth-[A-Za-z0-9]+$"
)
BUCKET = re.compile(r"^(?!.*\.\.)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
ROLE_NAMES = {
    "staging": "FirelightCompilerStagingDeploy",
    "production": "FirelightCompilerProductionDeploy",
}
SERVICE_NAMES = {
    "staging": "firelight-compiler-stg",
    "production": "firelight-compiler-prd",
}
CANONICAL_VPC_CIDRS = {
    "staging": "10.42.0.0/20",
    "production": "10.43.0.0/20",
}
EXAMPLE_ACCOUNTS = {"000000000000", "111111111111", "123456789012", "222222222222"}
BACKEND_KEYS = {
    "allowed_account_ids",
    "bucket",
    "encrypt",
    "key",
    "kms_key_id",
    "region",
    "use_lockfile",
}
VARIABLE_KEYS = {
    "auth_secret_arn",
    "auth_secret_kms_key_arn",
    "aws_account_id",
    "compiler_desired_count",
    "deployment_role_name",
    "enable_deletion_protection",
    "environment",
    "gateway_reserved_concurrency",
    "image_digest",
    "log_retention_days",
    "release_build_id",
    "service_name",
    "vpc_cidr",
}


class ReleaseConfigError(ValueError):
    """A stable, non-secret release configuration error."""


def fail(code: str) -> None:
    raise ReleaseConfigError(code)


def read_bounded(path: Path) -> bytes:
    try:
        if not path.is_file() or path.is_symlink():
            fail("CONFIG_NOT_REGULAR_FILE")
        size = path.stat().st_size
        if size <= 0 or size > MAX_CONFIG_BYTES:
            fail("CONFIG_SIZE_INVALID")
        return path.read_bytes()
    except OSError as error:
        raise ReleaseConfigError("CONFIG_READ_FAILED") from error


def parse_backend(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = read_bounded(path)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ReleaseConfigError("BACKEND_NOT_UTF8") from error

    result: dict[str, Any] = {}
    for source_line in text.splitlines():
        line = source_line.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r"([a-z_]+)\s*=\s*(.+)", line)
        if not match:
            fail("BACKEND_SYNTAX_INVALID")
        key, encoded = match.groups()
        if key not in BACKEND_KEYS:
            fail("BACKEND_KEY_UNEXPECTED")
        if key in result:
            fail("BACKEND_KEY_DUPLICATE")
        try:
            value = json.loads(encoded)
        except json.JSONDecodeError as error:
            raise ReleaseConfigError("BACKEND_VALUE_INVALID") from error
        if not isinstance(value, (str, bool, list)):
            fail("BACKEND_VALUE_INVALID")
        result[key] = value
    if set(result) != BACKEND_KEYS:
        fail("BACKEND_KEYS_INCOMPLETE")
    return result, raw


def parse_variables(path: Path) -> tuple[dict[str, Any], bytes]:
    raw = read_bounded(path)
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_variable_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseConfigError("VARIABLES_JSON_INVALID") from error
    if not isinstance(value, dict):
        fail("VARIABLES_JSON_INVALID")
    if set(value) != VARIABLE_KEYS:
        fail("VARIABLE_KEYS_INVALID")
    return value, raw


def _reject_duplicate_variable_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail("VARIABLE_KEY_DUPLICATE")
        result[key] = value
    return result


def exact_string(value: Any, code: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        fail(code)
    return value


@dataclass(frozen=True)
class VerifiedRelease:
    environment: str
    account_id: str
    backend_bucket: str
    backend_key: str
    backend_kms_key_arn: str
    vpc_cidr: str
    auth_secret_arn: str
    release_build_id: str
    backend_sha256: str
    variables_sha256: str

    def isolation_fingerprints(self) -> dict[str, str]:
        backend_location = (
            f"s3://{self.backend_bucket}/{self.backend_key}?region=eu-west-1"
        )
        return {
            "aws_account_id_sha256": isolation_fingerprint(
                "aws-account-id", self.account_id
            ),
            "backend_location_sha256": isolation_fingerprint(
                "backend-location", backend_location
            ),
            "state_kms_key_sha256": isolation_fingerprint(
                "state-kms-key", self.backend_kms_key_arn
            ),
            "auth_secret_sha256": isolation_fingerprint(
                "auth-secret", self.auth_secret_arn
            ),
            "vpc_cidr_sha256": isolation_fingerprint("vpc-cidr", self.vpc_cidr),
        }


def isolation_fingerprint(label: str, value: str) -> str:
    payload = ISOLATION_FINGERPRINT_DOMAIN + label.encode("ascii") + b"\0" + value.encode(
        "utf-8"
    )
    return hashlib.sha256(payload).hexdigest()


def _validate_release(
    expected_environment: str,
    backend: dict[str, Any],
    variables: dict[str, Any],
    backend_raw: bytes,
    variables_raw: bytes,
    *,
    ecr_bootstrap: bool,
) -> VerifiedRelease:
    if expected_environment not in ROLE_NAMES:
        fail("ENVIRONMENT_INVALID")
    environment = exact_string(variables["environment"], "ENVIRONMENT_INVALID")
    if environment != expected_environment:
        fail("ENVIRONMENT_MISMATCH")

    account_id = exact_string(variables["aws_account_id"], "AWS_ACCOUNT_ID_INVALID")
    if not ACCOUNT_ID.fullmatch(account_id) or account_id in EXAMPLE_ACCOUNTS:
        fail("AWS_ACCOUNT_ID_INVALID")

    if variables["service_name"] != SERVICE_NAMES[environment]:
        fail("SERVICE_NAME_INVALID")
    if variables["deployment_role_name"] != ROLE_NAMES[environment]:
        fail("DEPLOYMENT_ROLE_INVALID")

    digest = exact_string(variables["image_digest"], "IMAGE_DIGEST_INVALID")
    if not IMAGE_DIGEST.fullmatch(digest):
        fail("IMAGE_DIGEST_INVALID")
    if ecr_bootstrap:
        if digest != ECR_BOOTSTRAP_IMAGE_DIGEST:
            fail("ECR_BOOTSTRAP_IMAGE_DIGEST_INVALID")
    elif digest == ECR_BOOTSTRAP_IMAGE_DIGEST:
        fail("IMAGE_DIGEST_INVALID")

    release_build_id = exact_string(
        variables["release_build_id"],
        "RELEASE_BUILD_ID_INVALID",
    )
    if not BUILD_ID.fullmatch(release_build_id):
        fail("RELEASE_BUILD_ID_INVALID")

    secret_arn = exact_string(variables["auth_secret_arn"], "AUTH_SECRET_ARN_INVALID")
    secret_match = SECRET_ARN.fullmatch(secret_arn)
    if not secret_match or secret_match.group(1) != account_id or secret_match.group(2) != environment:
        fail("AUTH_SECRET_ARN_INVALID")

    secret_kms = variables["auth_secret_kms_key_arn"]
    if secret_kms is not None:
        secret_kms = exact_string(secret_kms, "AUTH_SECRET_KMS_ARN_INVALID")
        kms_match = KMS_KEY_ARN.fullmatch(secret_kms)
        if not kms_match or kms_match.group(1) != account_id:
            fail("AUTH_SECRET_KMS_ARN_INVALID")

    cidr_text = exact_string(variables["vpc_cidr"], "VPC_CIDR_INVALID")
    try:
        cidr = ipaddress.ip_network(cidr_text, strict=True)
    except ValueError as error:
        raise ReleaseConfigError("VPC_CIDR_INVALID") from error
    if cidr.version != 4 or not cidr.is_private or cidr.prefixlen != 20:
        fail("VPC_CIDR_INVALID")
    if str(cidr) != CANONICAL_VPC_CIDRS[environment]:
        fail("VPC_CIDR_INVALID")

    if type(variables["gateway_reserved_concurrency"]) is not int or not (
        1 <= variables["gateway_reserved_concurrency"] <= 20
    ):
        fail("GATEWAY_CONCURRENCY_INVALID")
    if type(variables["compiler_desired_count"]) is not int or not (
        2 <= variables["compiler_desired_count"] <= 10
    ):
        fail("COMPILER_COUNT_INVALID")
    if variables["enable_deletion_protection"] is not True:
        fail("DELETION_PROTECTION_REQUIRED")
    if type(variables["log_retention_days"]) is not int or variables[
        "log_retention_days"
    ] not in {1, 3, 5, 7, 14, 30, 60, 90}:
        fail("LOG_RETENTION_INVALID")

    bucket = exact_string(backend["bucket"], "BACKEND_BUCKET_INVALID")
    if not BUCKET.fullmatch(bucket) or "FIRELIGHT_" in bucket or "placeholder" in bucket.lower():
        fail("BACKEND_BUCKET_INVALID")
    expected_key = f"firelight/compiler/{environment}/terraform.tfstate"
    if backend["key"] != expected_key:
        fail("BACKEND_KEY_INVALID")
    if backend["region"] != "eu-west-1":
        fail("BACKEND_REGION_INVALID")
    if backend["encrypt"] is not True:
        fail("BACKEND_ENCRYPTION_REQUIRED")
    if backend["use_lockfile"] is not True:
        fail("BACKEND_LOCKING_REQUIRED")
    if backend["allowed_account_ids"] != [account_id]:
        fail("BACKEND_ACCOUNT_MISMATCH")
    backend_kms = exact_string(backend["kms_key_id"], "BACKEND_KMS_ARN_INVALID")
    backend_kms_match = KMS_KEY_ARN.fullmatch(backend_kms)
    if not backend_kms_match or backend_kms_match.group(1) != account_id:
        fail("BACKEND_KMS_ARN_INVALID")

    return VerifiedRelease(
        environment=environment,
        account_id=account_id,
        backend_bucket=bucket,
        backend_key=expected_key,
        backend_kms_key_arn=backend_kms,
        vpc_cidr=str(cidr),
        auth_secret_arn=secret_arn,
        release_build_id=release_build_id,
        backend_sha256=hashlib.sha256(backend_raw).hexdigest(),
        variables_sha256=hashlib.sha256(variables_raw).hexdigest(),
    )


def validate_release(
    expected_environment: str,
    backend: dict[str, Any],
    variables: dict[str, Any],
    backend_raw: bytes,
    variables_raw: bytes,
) -> VerifiedRelease:
    """Validate a complete runtime release; the bootstrap sentinel is invalid."""

    return _validate_release(
        expected_environment,
        backend,
        variables,
        backend_raw,
        variables_raw,
        ecr_bootstrap=False,
    )


def validate_ecr_bootstrap_release(
    expected_environment: str,
    backend: dict[str, Any],
    variables: dict[str, Any],
    backend_raw: bytes,
    variables_raw: bytes,
) -> VerifiedRelease:
    """Validate only the narrow, targeted ECR repository bootstrap inputs."""

    return _validate_release(
        expected_environment,
        backend,
        variables,
        backend_raw,
        variables_raw,
        ecr_bootstrap=True,
    )


def validate_peer(release: VerifiedRelease, peer: VerifiedRelease) -> None:
    if release.environment == peer.environment:
        fail("PEER_ENVIRONMENT_DUPLICATE")
    if release.account_id != peer.account_id:
        fail("PEER_AWS_ACCOUNT_MISMATCH")
    if (release.backend_bucket, release.backend_key) == (
        peer.backend_bucket,
        peer.backend_key,
    ):
        fail("PEER_STATE_COLLISION")
    if release.backend_kms_key_arn == peer.backend_kms_key_arn:
        fail("PEER_STATE_KMS_COLLISION")
    if release.auth_secret_arn == peer.auth_secret_arn:
        fail("PEER_AUTH_SECRET_COLLISION")
    if release.account_id == peer.account_id and release.vpc_cidr == peer.vpc_cidr:
        fail("PEER_VPC_CIDR_COLLISION")


def validate_peer_fingerprints(
    release: VerifiedRelease,
    peer_fingerprints: dict[str, str],
) -> None:
    expected_keys = set(release.isolation_fingerprints())
    if set(peer_fingerprints) != expected_keys or any(
        not isinstance(value, str) or not SHA256.fullmatch(value)
        for value in peer_fingerprints.values()
    ):
        fail("PEER_FINGERPRINT_INVALID")

    collision_codes = {
        "backend_location_sha256": "PEER_STATE_COLLISION",
        "state_kms_key_sha256": "PEER_STATE_KMS_COLLISION",
        "auth_secret_sha256": "PEER_AUTH_SECRET_COLLISION",
        "vpc_cidr_sha256": "PEER_VPC_CIDR_COLLISION",
    }
    current = release.isolation_fingerprints()
    if current["aws_account_id_sha256"] != peer_fingerprints[
        "aws_account_id_sha256"
    ]:
        fail("PEER_AWS_ACCOUNT_MISMATCH")
    for key, collision_code in collision_codes.items():
        if current[key] == peer_fingerprints[key]:
            fail(collision_code)


def load_release(environment: str, backend_path: Path, variables_path: Path) -> VerifiedRelease:
    backend, backend_raw = parse_backend(backend_path)
    variables, variables_raw = parse_variables(variables_path)
    return validate_release(environment, backend, variables, backend_raw, variables_raw)


def load_ecr_bootstrap_release(
    environment: str,
    backend_path: Path,
    variables_path: Path,
) -> VerifiedRelease:
    backend, backend_raw = parse_backend(backend_path)
    variables, variables_raw = parse_variables(variables_path)
    return validate_ecr_bootstrap_release(
        environment,
        backend,
        variables,
        backend_raw,
        variables_raw,
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ecr-bootstrap", action="store_true")
    parser.add_argument("--environment", choices=sorted(ROLE_NAMES), required=True)
    parser.add_argument("--backend-config", type=Path, required=True)
    parser.add_argument("--var-file", type=Path, required=True)
    parser.add_argument("--peer-environment", choices=sorted(ROLE_NAMES))
    parser.add_argument("--peer-backend-config", type=Path)
    parser.add_argument("--peer-var-file", type=Path)
    parser.add_argument("--peer-backend-location-sha256")
    parser.add_argument("--peer-aws-account-id-sha256")
    parser.add_argument("--peer-state-kms-key-sha256")
    parser.add_argument("--peer-auth-secret-sha256")
    parser.add_argument("--peer-vpc-cidr-sha256")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    peer_values = (
        args.peer_environment,
        args.peer_backend_config,
        args.peer_var_file,
    )
    if any(value is not None for value in peer_values) and not all(
        value is not None for value in peer_values
    ):
        fail("PEER_ARGUMENTS_INCOMPLETE")
    peer_fingerprint_values = {
        "aws_account_id_sha256": args.peer_aws_account_id_sha256,
        "backend_location_sha256": args.peer_backend_location_sha256,
        "state_kms_key_sha256": args.peer_state_kms_key_sha256,
        "auth_secret_sha256": args.peer_auth_secret_sha256,
        "vpc_cidr_sha256": args.peer_vpc_cidr_sha256,
    }
    supplied_peer_fingerprints = [
        value for value in peer_fingerprint_values.values() if value is not None
    ]
    if supplied_peer_fingerprints and len(supplied_peer_fingerprints) != len(
        peer_fingerprint_values
    ):
        fail("PEER_FINGERPRINT_ARGUMENTS_INCOMPLETE")
    if args.peer_environment is not None and supplied_peer_fingerprints:
        fail("PEER_PROOF_AMBIGUOUS")

    release_loader = load_ecr_bootstrap_release if args.ecr_bootstrap else load_release
    release = release_loader(args.environment, args.backend_config, args.var_file)
    if args.peer_environment is not None:
        peer = load_release(
            args.peer_environment,
            args.peer_backend_config,
            args.peer_var_file,
        )
        validate_peer(release, peer)
    elif supplied_peer_fingerprints:
        validate_peer_fingerprints(release, peer_fingerprint_values)

    # Only reviewed identities and content fingerprints are emitted; the secret
    # ARN, state KMS ARN, bucket, CIDR, and input contents remain out of logs.
    print(f"environment={release.environment}")
    print(f"aws_account_id={release.account_id}")
    print(f"backend_config_sha256={release.backend_sha256}")
    print(f"variable_file_sha256={release.variables_sha256}")
    for key, value in release.isolation_fingerprints().items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ReleaseConfigError as error:
        print(f"Compiler release configuration rejected [{error}].", file=sys.stderr)
        raise SystemExit(1) from None
