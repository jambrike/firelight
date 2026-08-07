# Compiler service

## Boundary and contract

The compiler is a repository-owned AWS Lambda container in `eu-west-1`. The
Cloudflare Worker is its only intended caller:

```text
browser --authenticated lesson request--> Worker
Worker --service token + source--> Lambda Function URL
Lambda --local pinned toolchain--> validated Intel HEX
Worker --validated artifact--> browser Web Serial flow
```

The Function URL and service token must stay in server-side Worker secrets. They
must never be placed in a `VITE_*` variable, returned by a Worker route, embedded
in browser JavaScript, or written to application logs. The endpoint deliberately
has no CORS configuration. Knowing the URL is not authorization; the token is.

The Lambda accepts only:

```http
POST / HTTP/1.1
Content-Type: application/json
X-Firelight-Compiler-Token: <server-side secret>

{"fqbn":"arduino:avr:nano:cpu=atmega328old","source":"void setup() {}\nvoid loop() {}\n"}
```

A successful response has this shape:

```json
{
  "ok": true,
  "artifact": {
    "artifactHash": "<lowercase SHA-256 of the exact returned HEX UTF-8 bytes>",
    "format": "intel-hex",
    "fqbn": "arduino:avr:nano:cpu=atmega328old",
    "hex": ":...\n:00000001FF\n",
    "sourceHash": "<lowercase SHA-256 of the submitted source UTF-8 bytes>"
  },
  "diagnostics": []
}
```

`artifactHash` is a defense-in-depth assertion. The Worker must recompute it when
present, recompute `sourceHash`, and validate the FQBN and Intel HEX itself. The
Worker owns the compile-job UUID and decorates the browser artifact only after
its database job exists; the Lambda neither accepts nor issues a `compileJobId`.

Non-2xx responses always use a stable code and fixed message:

```json
{
  "ok": false,
  "error": {
    "code": "COMPILER_FAILED",
    "message": "The sketch did not compile."
  },
  "diagnostics": ["[path]:4: error: expected ';'"]
}
```

Expected codes are `COMPILER_UNAUTHORIZED`, `COMPILER_METHOD_NOT_ALLOWED`,
`COMPILER_UNSUPPORTED_MEDIA_TYPE`, `COMPILER_INVALID_REQUEST`,
`COMPILER_REQUEST_TOO_LARGE`, `COMPILER_SOURCE_TOO_LARGE`,
`COMPILER_UNSUPPORTED_TARGET`, `COMPILER_FAILED`, `COMPILER_TIMEOUT`,
`COMPILER_ARTIFACT_INVALID`, `COMPILER_ARTIFACT_TOO_LARGE`,
`COMPILER_UNAVAILABLE`, and `COMPILER_INTERNAL_ERROR`. Callers must branch on
`code`, not message text.

## Enforced limits

| Boundary | Limit |
| --- | ---: |
| Decoded request JSON | 512 KiB |
| Source | 65,536 UTF-8 bytes |
| Board targets | one exact old-bootloader FQBN |
| Compiler process wall time | 45 seconds |
| Lambda timeout | 50 seconds |
| Captured compiler stdout + stderr | 64 KiB |
| Returned diagnostic lines | 16 |
| Returned diagnostics | 8 KiB total, 512 bytes per line |
| Intel HEX text | 128 KiB |
| Unique/maximum application flash address | below 30,720 bytes |
| JSON response | 192 KiB |
| Lambda ephemeral storage | 512 MiB |
| Lambda memory | 1,024 MiB |
| Reserved concurrency | 5 by default (configurable 1–20) |

The compiler runs in a new mode-0700 `/tmp` directory for every invocation.
Its child environment is allowlisted and contains no AWS or Firelight secret
variables. The process starts in a new process group; a deadline kills that
whole group, and Arduino CLI is restricted to one compiler job. Output is drained
but retained only up to the shared 64 KiB budget.

On success, the service chooses the non-bootloader `.hex`, normalizes line endings
to LF with one trailing LF, and verifies record lengths, checksums, EOF ordering,
record types, non-overlap, non-empty data, and the Nano application flash ceiling.

On failure, it returns only lines carrying compiler severity markers. ANSI and
control characters, temporary/runtime paths, HTTP/WebSocket URLs, and the service
token are removed. Unexpected exception details are never returned or logged.
All responses set `Cache-Control: no-store`, HSTS, `nosniff`, a deny-all CSP, and
no CORS headers.

## Pinned supply chain

| Component | Pin |
| --- | --- |
| Lambda Python base | `public.ecr.aws/lambda/python:3.12@sha256:8e75daf5b46d34c8ea7336eb7a3e3dbd4d43032689dbd401e52c6d319d312e37` |
| Arduino CLI | `1.5.1`, Linux 64-bit archive SHA-256 `28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b` |
| Arduino AVR core | `arduino:avr@1.8.6`, archive SHA-256 `ff1d17274b5a952f172074bd36c3924336baefded0232e10982f8999c2f7c3b6` |
| Terraform AWS provider | `6.56.0` |
| Runtime architecture | `linux/amd64` / Lambda `x86_64` |

The image build verifies the Arduino CLI archive before installing it. It also
checks the downloaded package index against repository-owned URL, size, version,
and checksum pins for the AVR core and all three transitive linux/amd64 tools
(`avr-gcc`, `avrdude`, and `arduinoOTA`) before Arduino CLI may download them.
The core is installed into the image at build time and the runtime does not
update indexes or download dependencies. Terraform addresses the private ECR
image by digest, never by tag. These pins should be updated in one reviewed
change after building, compiling the smoke sketch, inspecting the ECR scan, and
running a physical Nano old-bootloader upload gate.

Upstream references: [Arduino CLI releases](https://github.com/arduino/arduino-cli/releases),
[Arduino AVR core](https://github.com/arduino/ArduinoCore-avr), and
[AWS Lambda Python images](https://docs.aws.amazon.com/lambda/latest/dg/python-image.html).

## Test and build gates

Run unit tests from the repository root:

```sh
python3 -m unittest discover -s compiler-service/tests -v
```

The tests mock Arduino CLI at the process boundary. They cover authentication,
request and result bounds, the exact FQBN, UTF-8 source sizing, hashes, diagnostic
redaction, compiler failure/timeout behavior, bounded subprocess capture, and
Intel HEX validation.

Build an x86_64 image from the repository root:

```sh
IMAGE_TAG="firelight-compiler:$(git rev-parse --short HEAD)"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --load \
  --tag "$IMAGE_TAG" \
  compiler-service
```

Confirm the embedded versions without starting the Lambda handler:

```sh
docker run --rm --platform linux/amd64 \
  --entrypoint /usr/local/bin/arduino-cli \
  "$IMAGE_TAG" version

docker run --rm --platform linux/amd64 \
  --entrypoint /usr/local/bin/arduino-cli \
  "$IMAGE_TAG" \
  --config-file /opt/arduino/arduino-cli.yaml core list
```

The release gate also requires a container smoke compile using the exact FQBN and
a physical upload to an Arduino Nano configured for the old ATmega328P
bootloader. Unit tests cannot prove the toolchain image builds, AWS can pull the
image, or a physical board accepts and runs the artifact.

## Secret creation and rotation

Create the auth token outside Terraform so plaintext never enters Terraform
configuration, plans, state, shell arguments, or outputs. The Secrets Manager
`SecretString` must be the raw 32–512-byte token with no leading/trailing
whitespace. One safe workflow is to create a mode-0600 temporary file, generate
at least 256 random bits into it, use `aws secretsmanager create-secret` with a
`file://` value in `eu-west-1`, configure the same value through the Worker's
secret-input command, then securely remove the temporary file. Do not paste the
token into chat, tickets, CI logs, `.tfvars`, or command-line arguments.

The Lambda caches the secret for at most five minutes per warm environment to
reduce Secrets Manager calls. A rotation therefore needs a controlled window:
update the Secrets Manager value and Worker secret, publish a fresh Lambda
version (or wait for all old caches to expire), test the server-to-server route,
then revoke the old value. Wrong and missing tokens have the same fixed 401 body;
comparison is SHA-256-then-`hmac.compare_digest` over equal-length digests.

The Terraform execution role can read only the named secret and write only its
own log group. If the secret uses a customer-managed KMS key, set
`auth_secret_kms_key_arn` to grant `kms:Decrypt` only on that key.

## Infrastructure and deployment gate

Terraform owns a scan-on-push, immutable ECR repository, bounded Lambda,
least-privilege role, 14-day log group, immutable published version plus `live`
alias, and buffered Lambda Function URL. The region is deliberately hard-coded
to `eu-west-1`. The URL output is marked sensitive.

The Function URL uses AWS `AuthType=NONE` because the Worker does not hold AWS
SigV4 credentials. Current AWS Function URLs need public invoke policy statements
for this mode; AWS provider 6.56 manages those statements. Application auth still
runs before method/body validation. Reserved concurrency contains cost and
resource impact, but unauthorized calls can still consume invocations; configure
AWS budgets/alarms and rotate the unguessable URL/token if it is disclosed.
See [AWS Function URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).

Deployment is intentionally two-phase because Lambda can be created only after
its digest-addressed image exists:

1. Install Docker Buildx, Terraform, AWS CLI, and credentials authorized for the
   narrowly scoped ECR/Lambda/IAM/Logs/Secrets resources.
2. Copy `terraform/terraform.tfvars.example` outside version control, replace the
   example secret ARN, and retain the dummy digest only for the repository
   bootstrap.
3. From `compiler-service/terraform`, run `terraform init`, `terraform fmt -check`,
   `terraform validate`, review a plan, then bootstrap only
   `aws_ecr_repository.compiler` and `aws_ecr_lifecycle_policy.compiler`.
4. Build the linux/amd64 image, authenticate Docker to that ECR repository, tag
   it with a non-secret release identifier, and push it.
5. Obtain the pushed `imageDigest` from ECR, inspect scan findings, replace the
   dummy `image_digest`, and confirm it begins `sha256:` followed by 64 lowercase
   hex characters.
6. Run a full `terraform plan`; review the public Function URL policy, exact
   secret/KMS/log permissions, 50-second timeout, concurrency, region, and image
   digest. Only an authorized operator may apply it.
7. Retrieve the sensitive URL explicitly and store it directly as a Worker
   server-side secret. Do not echo it into CI logs. Perform authorized,
   unauthorized, timeout, compile-failure, and response-bound smoke tests.

Do not run `terraform apply` until the Docker build, ECR scan, AWS credential,
cost-control, and physical-board gates have owners. This repository change does
not build an image, push to ECR, create/modify a secret, or deploy AWS resources.

## Verification record (2026-08-07)

- `python3 -m unittest discover -s compiler-service/tests -v`: 33 tests passed.
- Terraform 1.15.8: `fmt -check` and `validate` passed after a local-only
  `init -backend=false` downloaded the locked AWS provider 6.56.0; it did not
  contact an AWS account.
- Docker is not installed in the implementation environment, so the Lambda image
  build, embedded CLI/core inspection, and container smoke compile were not run.
- No AWS plan/apply, API mutation, secret read/write, ECR push/scan, or Lambda URL
  request was performed.
- No physical Arduino Nano compile/upload/run gate was performed.

## Security review checklist

- Only the exact Nano old-bootloader FQBN is accepted; request fields are closed.
- Authentication precedes method, content type, JSON, and source processing.
- The shared token is absent from Terraform state and compiler child processes.
- Source, request, log, diagnostics, HEX, flash, response, time, disk, memory, and
  concurrency boundaries are explicit.
- No shell is used for compilation; all command arguments are fixed except
  service-created paths.
- The process group is killed at 45 seconds; Lambda has a five-second cleanup
  margin.
- Compiler output is never logged and only sanitized severity lines can return.
- Paths, controls, ANSI, URLs, and the auth token are redacted from diagnostics.
- Generated HEX is checksum/shape/address validated before return.
- The base image, CLI archive/checksum, core, provider, architecture, and deployed
  image digest are pinned.
- IAM is resource-scoped; log retention, image scanning, tag immutability,
  reserved concurrency, no CORS, and no-store headers are configured.
- Remaining operational risks are public-endpoint invocation cost, coordinated
  secret rotation, upstream image/core rebuild verification, AWS policy behavior,
  and the unexecuted physical-hardware gate.
