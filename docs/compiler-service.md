# Compiler service

## Isolation boundary

Learner source is never compiled in the public Lambda. The deployed request path
is:

```text
browser --authenticated lesson request--> Cloudflare Worker
Worker --service token + bounded source--> public Lambda Function URL
Lambda gateway --HTTP through its VPC SG--> internal ALB
internal ALB --HTTP through its SG--> private ECS/Fargate compiler task
compiler task --validated Intel HEX--> gateway --validated artifact--> Worker
```

The Lambda gateway authenticates the server-only Worker credential before method
or body processing. Only then does it load and return the Terraform-bound release
identity: environment, canonical service name, release commit, and ECR image
digest. It validates the closed request contract, applies the source policy, and
forwards to the Terraform-provided internal ALB. It does not call
`compile_sketch`; both `app.lambda_handler` and the image's default command point
to `app.gateway_lambda_handler`.

The Fargate service is the only process that can invoke Arduino CLI. It has no
public IP, internet route, application secret, task IAM role, ECS Exec access, or
writable root filesystem. It runs as UID 1000 with Linux capabilities dropped
and writes only to its bounded ephemeral `/tmp` volume. Its task execution role
is used only by the Fargate agent to pull the one ECR image and deliver logs. AWS
documents that execution-role credentials are not directly accessible to
containers; the task definition
deliberately omits a task role altogether. See [ECS task execution roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html)
and [ECS task isolation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html).

The internal compiler has no application authentication because its caller
identity is enforced by the security-group chain. The ALB accepts port 80 only
from the gateway security group, and compiler tasks accept port 8080 only from
the ALB security group. The ALB is internal and has no public DNS route.

## Public request contract

The Function URL and service token are Worker secrets. They must never be placed
in a `VITE_*` variable, returned by an API route, embedded in browser JavaScript,
or written to logs. The endpoint has no CORS configuration. Knowing its URL is
not authorization.

```http
POST / HTTP/1.1
Content-Type: application/json
X-Firelight-Compiler-Token: <server-side secret>

{"fqbn":"arduino:avr:nano:cpu=atmega328old","source":"void setup() {}\nvoid loop() {}\n"}
```

A successful response is:

```json
{
  "ok": true,
  "artifact": {
    "artifactHash": "<lowercase SHA-256 of exact HEX UTF-8 bytes>",
    "format": "intel-hex",
    "fqbn": "arduino:avr:nano:cpu=atmega328old",
    "hex": ":...\n:00000001FF\n",
    "sourceHash": "<lowercase SHA-256 of submitted source UTF-8 bytes>"
  },
  "diagnostics": [],
  "identity": {
    "buildId": "<lowercase 40-character release commit>",
    "environment": "staging",
    "imageDigest": "sha256:<64 lowercase hexadecimal characters>",
    "protocolVersion": 1,
    "serviceName": "firelight-compiler-stg"
  }
}
```

An authenticated `GET /` returns only `{ "ok": true, "identity": ... }` and
is the release probe. A request without the valid service token returns the
fixed unauthorized envelope and no identity. Once the identity configuration is
validly loaded, every post-authentication response, including validation,
compile, and infrastructure errors, carries that same exact identity. Missing or
invalid identity configuration returns a generic unavailable response that the
Worker rejects as an identity mismatch.

The gateway treats the internal service as untrusted output: it bounds the body,
rejects redirects, ignores proxy environment variables, checks the exact JSON
shape, recomputes source and artifact hashes, validates the FQBN and Intel HEX,
and rejects status/error-code mismatches. On every authenticated upstream
response, the Worker requires its exact environment, derived canonical service
name, and `protocolVersion: 1`. It independently requires `buildId` and
`imageDigest` to have canonical nonzero release shapes, but does not compare
either value to the web `BUILD_ID` or a Worker binding. The protected compiler
release probe still matches both values to the exact compiler release. The Worker
then repeats the source, target, hash, and HEX checks before returning an artifact
to the browser. Identity drift fails closed even when the upstream status is 4xx
or 5xx.

The Worker owns the compile-job UUID. Neither AWS surface accepts or issues a
`compileJobId`, and neither persists raw source or HEX.

Authenticated non-2xx responses use stable codes and fixed messages plus the
same `identity` object:

```json
{
  "ok": false,
  "error": {
    "code": "COMPILER_FAILED",
    "message": "The sketch did not compile."
  },
  "diagnostics": ["[path]:4: error: expected ';'"],
  "identity": {
    "buildId": "<lowercase 40-character release commit>",
    "environment": "staging",
    "imageDigest": "sha256:<64 lowercase hexadecimal characters>",
    "protocolVersion": 1,
    "serviceName": "firelight-compiler-stg"
  }
}
```

Codes are `COMPILER_UNAUTHORIZED`, `COMPILER_METHOD_NOT_ALLOWED`,
`COMPILER_UNSUPPORTED_MEDIA_TYPE`, `COMPILER_INVALID_REQUEST`,
`COMPILER_REQUEST_TOO_LARGE`, `COMPILER_SOURCE_TOO_LARGE`,
`COMPILER_SOURCE_POLICY_REJECTED`, `COMPILER_UNSUPPORTED_TARGET`,
`COMPILER_FAILED`, `COMPILER_TIMEOUT`, `COMPILER_ARTIFACT_INVALID`,
`COMPILER_ARTIFACT_TOO_LARGE`, `COMPILER_UNAVAILABLE`, and
`COMPILER_INTERNAL_ERROR`. Callers branch on `code`, not message text.

## Enforced limits

| Boundary                                 |                                   Limit |
| ---------------------------------------- | --------------------------------------: |
| Decoded request JSON                     |                                 512 KiB |
| Source                                   |                      65,536 UTF-8 bytes |
| Board targets                            |           one exact old-bootloader FQBN |
| Public Lambda timeout                    |                              45 seconds |
| Gateway wait for internal service        |                              42 seconds |
| Internal ALB idle timeout                |                              45 seconds |
| Target/task rollout drain                |                              60 seconds |
| Compiler process wall time               |                              40 seconds |
| Internal socket read/write timeout       |                               5 seconds |
| Concurrent compiler processes per task   |                                       1 |
| Internal HTTP accept backlog per task    |                                       8 |
| Captured compiler stdout + stderr        |                                  64 KiB |
| Returned diagnostic lines                |                                      16 |
| Returned diagnostics                     |         8 KiB total, 512 bytes per line |
| Intel HEX text                           |                                 128 KiB |
| Unique/maximum application flash address |                      below 30,720 bytes |
| JSON response                            |                                 192 KiB |
| Gateway reserved concurrency             |         5 by default, configurable 1–20 |
| Fargate service                          | 2 tasks by default, 1 vCPU / 2 GiB each |

The gateway stops waiting at 42 seconds so it can return a bounded error before
Lambda's 45-second hard deadline. The compiler process is killed by its own
40-second process-group deadline, leaving time to return a stable timeout. Each task
accepts health requests concurrently but admits only one compile process; excess
requests fail quickly with `COMPILER_UNAVAILABLE` for the Worker to handle.

Each compile uses a new mode-0700 directory on the task's writable `/tmp` volume.
The child environment is allowlisted and contains no AWS or Firelight variables.
The process starts in a new process group, a deadline kills that whole group,
Arduino CLI uses one compiler job, and output is drained while retaining only the
shared 64 KiB budget.

On success, the compiler chooses the non-bootloader `.hex`, normalizes line
endings, then verifies record lengths, checksums, EOF ordering, record types,
non-overlap, non-empty data, and the Nano application flash ceiling. On failure,
only compiler severity lines survive. ANSI/control characters, paths, URLs, and
the service token are redacted; exception details are never returned or logged.

## Defense-in-depth source policy

The source validator rejects compiler-controlled preprocessor directives except
the repository's exact `#include <Servo.h>`, inline assembly/file inclusion,
absolute or parent paths, raw C++ string literals, alternate preprocessor tokens,
trigraphs, and backslash-newline splicing (including lone-CR files). It
comment-masks before inspecting directives so a comment boundary cannot disguise one.

This policy is deliberately only defense in depth. It is not treated as a parser
for C++ and is not the security boundary. Fargate isolation, absent task
credentials/secrets, read-only root storage, bounded subprocess handling, and the
no-internet VPC remain required even when the policy accepts a sketch.

## Private network and IAM

Terraform creates a dedicated VPC across two availability zones. It creates no
internet gateway, NAT gateway, public subnet, or default route. Private endpoints
provide only what the AWS-managed runtimes need:

| Endpoint                     | Consumer       | Purpose                                |
| ---------------------------- | -------------- | -------------------------------------- |
| Secrets Manager interface    | Lambda gateway | Read the single auth token             |
| ECR API + ECR DKR interfaces | Fargate agent  | Authenticate and pull the pinned image |
| S3 gateway                   | Fargate agent  | Fetch the regional ECR layer objects   |
| CloudWatch Logs interface    | Fargate agent  | Create streams and put log events      |

Endpoint policies scope Secrets Manager to the one secret, ECR image calls to the
one repository, S3 to the regional ECR layer bucket, and Logs to the two service
log groups. Security-group egress permits the gateway only to the internal ALB
and interface endpoints; tasks may reach only the interface endpoints and ECR's
S3 prefix list. There is no `0.0.0.0/0` rule.

The gateway execution role can write its own logs, read the named secret, decrypt
only its optional customer-managed key, and manage the Lambda VPC network
interfaces required by AWS. The ECS execution role can obtain an ECR token, read
the named repository's image layers, and write the compiler log group. It has no
Secrets Manager, KMS, S3 application-data, ECS, or broad application permission.
The container definitions contain empty `environment` and `secrets` collections.

## Pinned supply chain and container modes

| Component              | Pin                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lambda Python base     | `public.ecr.aws/lambda/python:3.12@sha256:8e75daf5b46d34c8ea7336eb7a3e3dbd4d43032689dbd401e52c6d319d312e37` |
| Arduino CLI            | `1.5.1`, Linux 64-bit archive SHA-256 `28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b`    |
| Arduino AVR core       | `arduino:avr@1.8.6`, archive SHA-256 `ff1d17274b5a952f172074bd36c3924336baefded0232e10982f8999c2f7c3b6`     |
| Arduino Servo library  | `1.3.0`, registry archive SHA-256 `d25b0d77f10a810d24876c570410f32cc3129f9cc3d0370c861a278b969b4b38`        |
| Terraform AWS provider | `6.56.0`                                                                                                    |
| Runtime architecture   | `linux/amd64`, Lambda/ECS `x86_64`                                                                          |
| Fargate platform       | `1.4.0`                                                                                                     |

The build verifies the Arduino CLI archive and repository-owned URL, size,
version, and checksum pins for the AVR core plus its `avr-gcc`, `avrdude`, and
`arduinoOTA` dependencies. It separately downloads Servo 1.3.0 from Arduino's
library CDN, rejects redirects, verifies its exact byte size and checksum, safely
extracts the ZIP, and checks `name`, `version`, AVR architecture support, and
required AVR sources. Compile commands include only the fixed
`/opt/arduino/libraries` path. Runtime never updates indexes or downloads
toolchain dependencies. Terraform addresses ECR by digest, never tag.

One image supports two explicit modes:

- Lambda's image command is `app.gateway_lambda_handler`, which only authenticates
  and forwards.
- ECS overrides the entry point with `/var/lang/bin/python3 /var/task/app.py serve`.
  Invoking `app.py` without the exact `serve` argument fails closed.

CI also exports the real typed lesson catalog into a deterministic, hash-bound
fixture and runs `/var/task/verify_lesson_sketches.py` inside this image. The
verifier independently checks the exact six lesson IDs and versions, every
source hash, the live Arduino CLI version, installed AVR core files, and Servo
metadata/sources before calling the production compiler once for each sketch.
Each resulting artifact must bind to its source hash and the fixed Nano target.
The exact restricted container invocation is documented in
[Monitoring and hosted acceptance](monitoring.md#repository-and-image-gates).

## Local test and image gates

From the repository root:

```sh
python3 -m unittest discover -s compiler-service/tests -p 'test_*.py' -v
```

Tests cover gateway authentication and forwarding, strict internal URLs and
responses, request/result/concurrency bounds, source policy adversaries,
subprocess deadlines, diagnostics, Intel HEX, supply-chain pins, and static
Terraform isolation and monitoring invariants. They also cover deterministic
export of all six typed starter sketches and the independent in-image verifier.

Build the exact deployment architecture:

```sh
IMAGE_TAG="firelight-compiler:$(git rev-parse --short HEAD)"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --load \
  --tag "$IMAGE_TAG" \
  compiler-service
```

Inspect embedded versions:

```sh
docker run --rm --platform linux/amd64 \
  --entrypoint /usr/local/bin/arduino-cli \
  "$IMAGE_TAG" version

docker run --rm --platform linux/amd64 \
  --entrypoint /usr/local/bin/arduino-cli \
  "$IMAGE_TAG" \
  --config-file /opt/arduino/arduino-cli.yaml core list

docker run --rm --platform linux/amd64 \
  --entrypoint /bin/sh \
  "$IMAGE_TAG" -c \
  'grep -E "^(name|version|architectures)=" /opt/arduino/libraries/Servo/library.properties'
```

Smoke the internal service mode locally, then post the exact two-field JSON
contract to `http://127.0.0.1:8080/compile`:

```sh
docker run --rm --platform linux/amd64 -p 127.0.0.1:8080:8080 \
  --entrypoint /var/lang/bin/python3 \
  "$IMAGE_TAG" /var/task/app.py serve
```

The release gate also requires an image scan, a container smoke compile, and a
physical upload to an Arduino Nano configured for the old ATmega328P bootloader.

## Secret creation and rotation

Create the token outside Terraform so plaintext never enters plans, state, shell
arguments, or outputs. `SecretString` is the raw 32–512-byte token with no
leading/trailing whitespace. Put the same value in the Cloudflare Worker secret
store. Never paste it into chat, tickets, CI logs, `.tfvars`, or command-line
arguments.

The gateway caches the token for at most five minutes per warm environment.
Rotate by updating Secrets Manager and the Worker secret during a controlled
window, publish a fresh gateway version or wait for old caches to expire, test
authorized and unauthorized calls, then revoke the old token. Fargate never
receives the token and needs no rotation action.

## Terraform deployment gate

Terraform owns the immutable ECR repository, no-NAT VPC and endpoints, security
groups, internal ALB, ECS cluster/service/task definition, bounded gateway,
least-privilege roles, log groups, public buffered Function URL, encrypted alert
topic, 11 alarms, and operational dashboard. The region is fixed to
`eu-west-1`. The public URL and internal ALB output are sensitive.

These Terraform and public-probe definitions are implemented, but hosted
monitoring is still an external acceptance gate until each environment has been
applied, primary and backup subscriptions are confirmed, staging has completed
the notification/alarm drill, and the evidence is reviewed. Follow
[Monitoring and hosted acceptance](monitoring.md); recipient endpoints never
belong in Terraform state.

The environment-separated remote state, assumed-role/account gates, real input
validator, OIDC handoff, immutable-image rollout, sensitive-output handling, and
post-deploy gateway proof are specified in
[`backend-release-readiness.md`](./backend-release-readiness.md). Account root,
IAM-user credentials, example account IDs, a placeholder image digest, and a
cross-account compiler secret now produce hard failures before a normal plan.

Deployment is two phase because every runtime references an image digest, but
both phases run only through the protected manual **Deploy compiler** workflow:

1. Complete the organization bootstrap and protected GitHub environment setup in
   [`backend-release-readiness.md`](./backend-release-readiness.md). An
   organization administrator creates the OIDC roles, encrypted state boundary,
   and compiler token outside Terraform; account root and local AWS credentials
   are forbidden.
2. Local work is validation-only. From `compiler-service/terraform`, run
   `terraform fmt -check -recursive`, `terraform init -backend=false
   -lockfile=readonly`, `terraform validate`, and `terraform test`. Do not create
   local backend/tfvars files, run a provider-backed plan, push an image, or run
   `terraform apply`.
3. Dispatch **Deploy compiler** for staging from the current `main` commit with
   `DEPLOY_STAGING_COMPILER`. Include `BOOTSTRAP_STAGING_COMPILER_ECR` when the
   repository is absent or a prior bootstrap was interrupted. A fresh protected
   run can resume only unique `create`/`no-op` actions for the repository,
   lifecycle policy, and operator gate, followed by a zero-drift proof.
4. The workflow builds or safely reuses the immutable linux/amd64 image, smoke
   tests all lesson fixtures, scans the registry digest, and creates the complete
   saved plan. Its plan/apply streams remain in mode-`0600` ephemeral runner
   files; only separately rendered review text travels through the SSE-KMS state
   handoff. Approvers verify the no-NAT design, endpoint/IAM/security-group rules,
   gateway timeout, release commit, digest, and expected cost before apply.
5. After staging acceptance, transfer the protected Function URL, origin, host,
   token, build ID, and digest into the staging web-release environment without
   printing their values. Test unauthorized, authenticated identity,
   invalid-source, compile-failure, busy-service, timeout, and artifact-bound
   responses, plus the physical Nano acceptance gate.
6. Dispatch **Deploy compiler** for production from the same current `main`
   commit with `DEPLOY_PRODUCTION_COMPILER` and the exact accepted staging run
   ID/evidence hash. Include `BOOTSTRAP_PRODUCTION_COMPILER_ECR` only when its
   repository is absent or its bootstrap was interrupted. Production copies the
   accepted staging digest with preservation, never rebuilds it, and repeats the
   protected plan, apply, health, identity, and compile gates.
7. Transfer the independently protected production compiler bindings to the
   production web-release environment. The Worker pins the exact Function URL
   origin and host, while every authenticated compiler response must match the
   environment/service/protocol/build/digest contract. Do not use a local
   Terraform, ECR, Lambda, or secret-management command as a shortcut.

Function URLs with `AuthType=NONE` require public resource-policy permissions;
AWS provider 6.56 manages both current permissions when it creates the URL. The
application token is still checked before request parsing. See [Lambda Function URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).

ALB deletion protection defaults on. An intentional environment teardown must be
a reviewed two-step change that first disables it. Never point the Worker at the
internal ALB or expose ALB/task security groups publicly.

## Recovery runbook

Use the alarm-to-dashboard triage and hosted drill procedure in
[Monitoring and hosted acceptance](monitoring.md#incident-use) alongside these
compiler-specific recovery actions.

- Repeated 401: verify Worker and Secrets Manager token versions without printing
  either value; rotate through the controlled procedure.
- Repeated 503: inspect ECS desired/running counts, ALB target health, VPC endpoint
  status, and Fargate-agent ECR/Logs events. Do not add a NAT route as a shortcut.
- Timeouts: compare gateway duration with task CPU/memory and compiler deadline;
  drain/replace unhealthy tasks rather than raising the 45-second public bound.
- Bad image release: merge a reviewed revert or forward repair and run the normal
  staging-then-production compiler workflow. It creates and applies the reviewed
  digest-bound plan, proves target health, and advances the live alias; local
  Terraform and arbitrary previous-digest inputs remain forbidden.
- Suspected source escape or credential exposure: disable the public Function URL,
  rotate the gateway token, stop the ECS service, preserve redacted AWS audit
  records, and do not return service until image and IAM boundaries are reviewed.

## Verification record (2026-08-09)

- `python3 -m unittest discover -s compiler-service/tests -p 'test_*.py' -v`:
  109 tests passed, including manifest/toolchain verification, resumable ECR
  plan validation, deployment probes, and 11-alarm static infrastructure
  coverage.
- `npm run test:operations`: 155 tests passed, including the typed six-lesson
  export, protected workflow ordering, release evidence, rollback identity,
  request/response bounds, and fixed compiler timeouts.
- `npm run check`: passed with 282 UI unit tests, 152 Worker tests, the compiler
  and operations suites above, type checks, lint, lesson validation, and the
  production build. Playwright passed all 19 hermetic browser journeys.
- The pinned Servo installer downloaded the current Arduino CDN artifact, matched
  133,580 bytes and SHA-256
  `d25b0d77f10a810d24876c570410f32cc3129f9cc3d0370c861a278b969b4b38`,
  safely extracted it, and verified Servo `1.3.0` with AVR support.
- Terraform 1.15.8: `fmt -check -recursive`, offline-backend `init`, `validate`,
  and four mocked static plan tests passed using locked AWS provider 6.56.0.
  No AWS account was contacted or mutated.
- Docker is unavailable in the implementation environment, so the image build,
  non-root six-sketch image gate, Fargate-mode smoke, embedded CLI/core/Servo
  inspection, and ECR scan were not run.
- No AWS plan/apply, API mutation, secret read/write, ECR push, Lambda invocation,
  or Fargate launch was performed.
- No physical Arduino Nano compile/upload/run acceptance was performed.

## Security review checklist

- Public Lambda authenticates then forwards; it never calls `compile_sketch`.
- Internal ALB and task ports are security-group restricted; tasks have no public
  IP, task role, secrets, ECS Exec, NAT, IGW, or `0.0.0.0/0` route/rule.
- Execution-role permissions are agent-only ECR pull and log delivery operations.
- Source policy is explicitly defense in depth, not the isolation boundary.
- Request, source, result, diagnostics, flash, process output, time, concurrency,
  memory, disk, and network boundaries are explicit.
- No shell executes learner-controlled values; source is written only to a fresh
  temporary sketch file.
- Gateway and Worker independently verify source/artifact hashes, FQBN, and HEX.
- Image, CLI, core dependencies, provider, architecture, and deployed digest are
  pinned.
- Alarm and recovery actions share a customer-key-encrypted SNS topic; recipient
  details remain outside Terraform state.
- Remaining release risks are the unexecuted container/AWS/physical gates,
  hosted subscriptions/alarm drill, and coordinated secret/domain rollout.
