# Backend release readiness

This is the handoff from repository-complete backend infrastructure to the
protected deploy buttons. None of the commands in this document were run against
a hosted project or AWS account while preparing the repository.

## Known external-state blockers

As of 2026-08-09, only one hosted Supabase project named `firelight` is known to
exist and be linked locally. It cannot represent both staging and production.
Create and approve two independent `eu-west-1` projects before either release
workflow receives credentials. Do not treat the existing link as evidence of
the target selected by a protected workflow.

The locally available AWS CLI session is the AWS account root principal. It is
forbidden for every compiler bootstrap, plan, push, and apply. Do not use it even
for the one-time ECR bootstrap. `terraform_data.operator_gate` and
`verify_aws_identity.py` accept only the exact environment-scoped assumed role;
an account-root ARN, IAM user, federated user, wrong account, wrong role, or
long-lived access-key user fails before an approved mutation.

## Supabase button readiness

Create two independent projects and configure these protected values separately
for staging and production:

| Name                                  | Kind                 | Requirement                                                    |
| ------------------------------------- | -------------------- | -------------------------------------------------------------- |
| `SUPABASE_PROJECT_REF`                | protected identifier | exact 20-character project ref                                 |
| `SUPABASE_ORGANIZATION_ID`            | protected identifier | owning Firelight organization                                  |
| `SUPABASE_PROJECT_NAME`               | protected identifier | exact reviewed project name                                    |
| `SUPABASE_ACCESS_TOKEN`               | secret               | short-lived/fine-grained Management API token                  |
| `SUPABASE_DB_PASSWORD`                | secret               | password for only that project's database                      |
| `FIRELIGHT_EXPECTED_SMTP_HOST`        | protected variable   | exact custom SMTP hostname, never Supabase's shared SMTP       |
| `FIRELIGHT_EXPECTED_SMTP_PORT`        | protected variable   | `465` or `587`                                                 |
| `FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL` | protected variable   | approved sender ending in `@auth.firelight.ie`                 |
| `FIRELIGHT_EXPECTED_SMTP_USER`        | protected variable   | exact environment SMTP username                                |
| `SUPABASE_SMTP_PASSWORD`              | secret               | SMTP password, used only by the explicit Auth-config apply job |

The read-only release verifier needs Management API `auth:read` and
`auth_config_read`. The separately protected config-apply action needs
`auth:write`, `auth_config_write`, and `project_admin_write`. Database preview,
migration, and pgTAP need only the target project's database permissions. Do not
give the Auth-read token database write access when provider token types permit
those scopes to be separated.

The repository owns the complete hosted Auth payload. A protected operator can
apply it only by setting all values above and typing the exact confirmation:

```text
staging:    FIRELIGHT_AUTH_CONFIG_CONFIRMATION=APPLY_STAGING_AUTH_CONFIG
production: FIRELIGHT_AUTH_CONFIG_CONFIRMATION=APPLY_PRODUCTION_AUTH_CONFIG
```

The protected job then runs `node scripts/apply-supabase-auth-config.mjs`. The
helper sends one bounded, redirect-failing Management API `PATCH`; the SMTP
password exists only in that request body. It sets:

- the canonical site URL and the single exact `/auth` redirect;
- email/password signup, email confirmation, no anonymous/phone/social login;
- one-hour JWT and OTP expiry, six-digit OTPs, eight-character
  letters-and-digits passwords, refresh rotation with a 10-second reuse window,
  double-confirmed email changes, and password-change reauthentication;
- the exact custom SMTP host, port, user, sender, password, Firelight sender
  name, and a 60-second send frequency;
- the exact confirmation/recovery subjects and repository HTML templates.

A successful PATCH is not acceptance. The helper immediately performs a
separate GET and runs the same verifier used by releases. It prints only
`auth_config_hash`. Routine releases run only
`scripts/verify-supabase-auth-config.mjs` and may bind the previewed hash through
`FIRELIGHT_EXPECTED_AUTH_CONFIG_HASH`; they never rewrite Auth settings or SMTP.

The logical staging/production mapping is anchored outside protected environment
secrets in `.github/supabase-project-anchors.json`. Its exact-schema canonical
JSON pins one organization hash and one distinct ref-only hash per logical
environment. A no-environment job validates it before any protected project is
opened. The checked-in `PENDING_*` organization/staging values deliberately
block hosted mutation until the second project is provisioned and the reviewed
anchors are committed.

Generate that reviewed candidate with
`scripts/generate-supabase-project-anchors.mjs` after two operators independently
confirm the raw staging ref, production ref, and organization ID. It emits only
the canonical domain-separated hashes and rejects equal refs; the raw
identifiers remain outside repository files and workflow artifacts.

Project proofs use three versioned, domain-separated SHA-256 identities: the
composite snapshot binds the project ref, organization ID, exact name,
`eu-west-1` region, and database host; a ref-only identity remains stable across
project renames and is the peer-collision key; and the organization identity
binds the Supabase organization boundary. After the complete staging canary
succeeds, the staging workflow writes all three fingerprints into a
versioned evidence JSON whose schema also binds the canonical repository,
workflow, commit, job, run ID, run attempt, and immutable artifact name. It
prints the exact staging run ID and evidence-file SHA-256 in the run summary.
None of the fingerprints discloses the protected project ref or organization
ID.

Every staging dispatch also proves the protected `production-preview` project
against the canonical production label before Worker bootstrap, link,
migration, or principal changes. Every production dispatch must supply that
exact `staging_run_id` and `staging_evidence_sha256`. Production verifies the
successful exact-commit run,
downloads only its run-and-attempt-specific artifact, checks the canonical JSON
and hash, requires its ref/organization fingerprints to match the source-pinned
staging label, and then proves that production matches the source-pinned
production label, remains in the same protected organization boundary, and has
a different ref-only project identity. The
composite identity remains the exact snapshot-drift gate. A missing,
expired, altered, cross-run, cross-commit, or same-project tuple fails before
`supabase link`, migration preview, or any hosted mutation.

The database release order is fixed:

1. Prove project ref, organization, name, region, database host, and hosted Auth
   configuration; record the project, organization, and Auth-config hashes.
2. Link that exact project and fingerprint its remote migration history.
3. Run `supabase db push --linked --dry-run`; obtain protected approval.
4. Re-prove the project, organization, peer-isolation, and Auth hashes and
   unchanged migration history immediately before the protected link/migration.
5. Run `supabase db push --linked`, then `supabase test db --linked` before the
   Worker deploy. Every pgTAP file is transaction-wrapped and rolls back.
6. Re-prove the protected project snapshot immediately before Worker deploy,
   run the complete canary, contract the progress-write boundary, rerun the
   canary, and retain the release tuple. Staging additionally retains the web
   promotion evidence and prints its exact promotion inputs.

Hosted prerequisites still requiring provider-console work are custom SMTP with
SPF/DKIM/DMARC and tracking disabled, separate backup/PITR policies, recovery
codes, a confirmed non-admin activated canary, and a restore drill. Those values
cannot be fabricated in source control.

## AWS compiler button readiness

### Organization bootstrap inputs

An organization administrator—not AWS account root—must provision the following
once per environment before the compiler release workflow can be enabled:

| Input                  | Staging                                        | Production                                        |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Region                 | `eu-west-1`                                    | `eu-west-1`                                       |
| Deploy role            | `FirelightCompilerStagingDeploy`               | `FirelightCompilerProductionDeploy`               |
| Terraform service name | `firelight-compiler-stg`                       | `firelight-compiler-prd`                          |
| State key              | `firelight/compiler/staging/terraform.tfstate` | `firelight/compiler/production/terraform.tfstate` |
| State bucket           | reviewed protected bucket                      | separately protected bucket or access boundary    |
| State KMS key          | environment key ARN                            | different environment key ARN                     |
| Compiler secret name   | `firelight/staging/compiler-auth-*`            | `firelight/production/compiler-auth-*`            |
| VPC CIDR               | `10.42.0.0/20`                                 | `10.43.0.0/20` in the same reviewed account       |

The state bucket must have public access blocked, ACLs disabled, versioning
enabled, default SSE-KMS with the reviewed key, TLS-only bucket policy, and no
lifecycle rule that can expire current state or lock files. The deploy role gets
only `ListBucket` on its state prefix, `GetObject`/`PutObject` on the exact state
object, `GetObject`/`PutObject`/`DeleteObject` on its `.tflock`, and the required
encrypt/decrypt/data-key operations on that environment's state key. It also
gets `GetObject`/`GetObjectVersion`/`PutObject`, but never `DeleteObject`, on only
`firelight/compiler/<environment>/saved-plans/*`. Each plan job derives an exact
`<run-id>/<run-attempt>/<phase>` key, uses conditional `PutObject` with
`If-None-Match: *`, supplies the reviewed state key explicitly as SSE-KMS, and
uploads the hash-bound manifest last. A retry therefore needs a new run attempt
and cannot replace an accepted key. Apply reads the exact version returned by
each verified `HeadObject`, so a later version cannot enter the checked handoff.
Bucket policy must reject a saved-plan write without that exact KMS key. Backend configuration sets `encrypt=true`,
`use_lockfile=true`, the exact KMS key, and a single `allowed_account_ids` entry.

GitHub OIDC trust must use audience `sts.amazonaws.com` and an exact subject:

```text
repo:<approved-owner>/<approved-repository>:environment:compiler-staging
repo:<approved-owner>/<approved-repository>:environment:compiler-production
```

Do not use branch wildcards, pull-request subjects, personal IAM users, account
root, stored `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` secrets, or a role shared
between environments. The workflow requests `id-token: write`, assumes only the
canonical role, writes `aws sts get-caller-identity` to a temporary file, and
runs:

```sh
python3 compiler-service/scripts/verify_aws_identity.py "$IDENTITY_FILE" \
  --environment "$ENVIRONMENT" \
  --expected-account-id "$AWS_ACCOUNT_ID"
```

The deployment role's infrastructure permissions are limited to the resources
declared in `compiler-service/terraform`: the environment-named ECR repository,
VPC/subnets/route tables/security groups/endpoints, log groups, internal ALB and
target group/listener, ECS cluster/service/task definitions, Lambda gateway and
Function URL/permissions, environment IAM execution roles and inline policies,
the compiler alert KMS alias/key and SNS topic/policy, alarms, and dashboard.
For the environment ECR repository, include the image push/read operations,
`ecr:StartImageScan` for an existing-tag retry, and
`ecr:BatchGetImage`/`ecr:PutImage` for exact-manifest commit retagging, plus
`ecr:GetRepositoryPolicy`, `ecr:SetRepositoryPolicy`, and
`ecr:DeleteRepositoryPolicy`; Terraform owns the sole repository statement and
must be able to reconcile it. The production role additionally has only the
documented read operations on `firelight-compiler-stg` so Skopeo can preserve
the accepted digest without staging write access. The repository statement
grants only `ecr:BatchGetImage`/`ecr:GetDownloadUrlForLayer` to
`lambda.amazonaws.com`, with
the reviewed account and exact unqualified environment gateway function ARN as
source conditions. Lambda must never auto-mutate a missing repository policy.
Restrict `iam:PassRole` to the two environment execution roles and their exact
Lambda/ECS service principals; restrict Secrets Manager reads to the one
compiler-token ARN; use request/resource Firelight tags wherever an AWS create
API cannot be ARN-scoped. The organization bootstrap role is not the runtime
gateway role and is never available to the compiler container.

The protected runner materializes the full-release inputs from environment
storage instead of constructing HCL or JSON in a shell. It supplies exactly:

```text
FIRELIGHT_COMPILER_ENVIRONMENT
AWS_ACCOUNT_ID
FIRELIGHT_TERRAFORM_STATE_BUCKET
FIRELIGHT_TERRAFORM_STATE_KMS_KEY_ARN
FIRELIGHT_COMPILER_IMAGE_DIGEST             (required for a full release)
FIRELIGHT_COMPILER_AUTH_SECRET_ARN
FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN  (optional; empty means null)
FIRELIGHT_COMPILER_VPC_CIDR
```

It then invokes `compiler-service/scripts/materialize_release_config.py` with
two new absolute paths under an ephemeral runner-owned directory. The helper
uses exclusive `0600` files, refuses existing targets and symlink parents,
derives the canonical service/role/state key, validates its own outputs, and
prints only a fixed success marker. The compiler token is not an input. Feed
the two resulting paths directly to `verify_release_config.py` and Terraform,
then delete the runner directory after the release job; never upload it as an
artifact.

For the first repository bootstrap, run the same helper with
`--ecr-bootstrap` and leave `FIRELIGHT_COMPILER_IMAGE_DIGEST` absent or empty.
That explicit mode writes the single canonical all-zero SHA-256 sentinel; it
rejects every other supplied digest and reports a distinct fixed success
marker. Use the resulting tfvars only for a saved plan/apply targeting exactly
`aws_ecr_repository.compiler` and `aws_ecr_lifecycle_policy.compiler`. The
normal release validator and `terraform_data.release_gate` both reject the
sentinel, so it cannot enter any runtime plan. After the image is pushed, create
new files in full-release mode with the registry-reported digest.

### Protected compiler release sequence

The compiler workflow is manual-only and takes `environment` plus the exact
`DEPLOY_STAGING_COMPILER` or `DEPLOY_PRODUCTION_COMPILER` confirmation. Production
requires an independent reviewer. Its ordered jobs are:

1. Run CI, compiler Python tests, Terraform format/validate/mock tests, export all
   six starter sketches, build the pinned `linux/amd64` image, run the six-sketch
   verifier under the production restrictions, and scan the image.
2. For production, verify the exact accepted staging run/artifact and its image,
   account, state, secret, and VPC fingerprints. In the protected environment,
   materialize the current configuration without AWS credentials, require the
   same-account and distinct-resource contract, and retain only its safe
   fingerprints as the workflow's isolation snapshot.
3. Re-materialize and match that snapshot, then assume the exact OIDC role and
   run the identity verifier before any AWS write. Only then initialize the
   partial S3 backend. A production ECR bootstrap must first read the accepted
   staging digest and canonical commit tag through the production role.
4. For an absent or partially applied bootstrap, invoke the materializer's
   explicit `--ecr-bootstrap` mode and converge the ECR repository with one
   reviewed saved, targeted plan/apply. The targets are exactly
   `aws_ecr_repository.compiler` and `aws_ecr_lifecycle_policy.compiler`; never
   target a runtime resource. The operator gate still executes and rejects root.
   The plan verifier permits only unique `create` or `no-op` entries for the
   repository, lifecycle policy, and operator gate; every other address or
   action, including update, destroy, replace, or read, fails. This permits a new
   dispatch with the same bootstrap confirmation to resume state safely after an
   interrupted partial apply. After apply, a second targeted plan must contain
   all three resources as `no-op`. This is the only sentinel-digest phase, and
   the normal release validator cannot accept its files. The saved plan, review
   text, and manifest move only through the environment's protected state
   bucket; no opaque Terraform file is uploaded to GitHub artifacts.
5. Push the commit-tagged image, read the registry-reported manifest digest, and
   require lowercase `sha256` plus 64 hex characters. Put that digest—not a tag—
   in the protected materializer environment. Review and clear the ECR scan
   gate.
6. Materialize fresh backend/tfvars files, then run
   `verify_release_config.py` against the pair. Staging acceptance retains only
   domain-separated fingerprints for its AWS account, backend location/state
   key, auth secret, and canonical VPC. Before production AWS access, require the
   account fingerprint to match and the state, secret, and VPC fingerprints to
   differ; recheck the resulting current-environment snapshot against each
   freshly materialized saved-plan input before Terraform init. Then create a
   saved full Terraform plan. Its process stdout and stderr stay in explicitly
   mode-`0600` files inside the runner's mode-`0700` configuration directory;
   detailed exit codes `0` and `2` remain valid without rendering either stream
   into the Actions log. Write its binary and separately rendered review text
   under the exact create-if-absent run/attempt S3 prefix and write the manifest
   last, all with the protected state KMS key. Retain only the commit, image digest, input
   fingerprints, plan hash, cost/security review, and previous digest outside
   that protected handoff; never retain token values or sensitive Terraform
   outputs.
7. Request the protected apply approval. Recheck the OIDC identity, commit,
   image digest, backend/tfvars fingerprints, remote-state serial, and the
   manifest's exact run/attempt object keys, SSE-KMS metadata, sizes, and hashes
   after OIDC before `terraform apply` consumes that exact plan. Constant-time
   comparison must prove the GitHub compiler token equals the current AWS secret
   before any ECR mutation and again immediately before each Terraform apply.
8. Read back the ECR repository policy and require its one exact account- and
   function-scoped Lambda retrieval statement. Wait for ECS desired/running
   parity, deployment completion, and every ALB target to become healthy. Read
   back the ECS task definition and Lambda image URI and require the approved
   digest. Require the `live` alias to reference the newly published immutable
   Lambda version.
9. Handle `compiler_gateway_function_url` as a masked, ephemeral value. Derive
   its exact origin and host without printing it, and install URL/origin/host and
   the matching token into only the target Worker's protected secret store.
   Store the accepted compiler build ID and image digest separately as protected
   web-release evidence values; do not upload either as a Worker binding.
10. In the full apply job, install dependencies and export First Spark from the
    typed lesson catalog before OIDC or secret material is available. Later run
    `compiler-service/scripts/probe_deployment.py --source-file <fixture>`. The
    bounded probe requires an exact unauthenticated 401 with no release identity,
    an authenticated 200 identity response matching environment, canonical
    service, protocol version 1, commit, and digest, and a real authorized Nano
    compile carrying that same identity through Lambda, internal ALB, and Fargate. It
    recomputes source/artifact hashes and validates Intel HEX; logs contain only
    the two hashes.
11. Confirm the encrypted SNS topic has named primary/backup responders, run the
    staging ALARM/OK drill, and retain the previous digest and Lambda version
    through the observation window.

`compiler-service/terraform/.gitignore` excludes backend files, tfvars, plans,
state, and Terraform working data. `backend.tf` deliberately uses a partial S3
backend. The environment examples are review templates, not deployable defaults:
their account IDs, KMS keys, buckets, secret ARNs, and image digests are rejected
until replaced.

### Sensitive output handoff

The compiler Function URL is a sensitive Terraform output. It must move directly
from the protected apply runner into masked environment storage and the target
Worker's secret input; it must not appear in a shell trace, plan summary,
artifact, issue, or chat. Terraform plan binaries, generated backend files, and
tfvars must likewise never enter a GitHub artifact; the plan handoff is only the
conditional, SSE-KMS state-bucket path above. Terraform plan and apply process
stdout/stderr are captured only in mode-`0600` runner files and deleted with the
ephemeral runner material; failures emit fixed messages rather than replaying
those streams. Only the explicit `terraform show` review text enters the
protected state-bucket handoff. The raw compiler token is created in the approved
secret store, with the same value provided to AWS Secrets Manager and the Worker
secret action. Fargate receives neither value.

After the repository checks pass, the irreducible external actions are therefore
limited to provisioning the OIDC/state/secret prerequisites, entering protected
identifiers and secrets, approving the saved staging plan, and pressing the
manual compiler deploy button. Production remains blocked until staging image,
gateway, alarm, browser, physical Nano, and rollback evidence is accepted.
