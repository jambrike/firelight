# Firelight operations and release runbook

This runbook is the operator boundary for the controlled Firelight pilot. It
describes approved actions; reading it, running local checks, or merging a
documentation change does not deploy a Worker, change DNS, apply Terraform,
mutate Supabase, rotate a secret, or operate physical hardware.

Use a change record for every hosted migration, release, rollback, secret
rotation, kit revocation, restore, and exceptional data operation. Record only
identifiers, versions, timestamps, approvals, and outcomes. Never put passwords,
bearer tokens, kit plaintext, learner source, raw request bodies, or compiler
artifacts in the record.

## Environment boundary

Staging and production must never share an identity store, kit-code pepper,
compiler credential, database password, deployment approval, or mutable
infrastructure state.

| Boundary                          | Staging                                        | Production                                              |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Cloudflare Worker                 | `firelight-staging`                            | `firelight-production`                                  |
| Public host                       | `staging.firelight.ie`                         | `firelight.ie`                                          |
| Cloudflare route                  | Worker Custom Domain                           | `firelight.ie/*` route over retained Pages DNS          |
| Runtime variable                  | `ENVIRONMENT=staging`                          | `ENVIRONMENT=production`                                |
| GitHub release environment        | `staging`                                      | `production`                                            |
| GitHub preview environment        | not separate                                   | `production-preview`                                    |
| First-deploy approval environment | `staging-database-bootstrap`                   | `production-database-bootstrap`                         |
| Supabase                          | dedicated `eu-west-1` project                  | separate dedicated `eu-west-1` project                  |
| AWS compiler                      | dedicated state, VPC, ECR, service, and secret | separate dedicated state, VPC, ECR, service, and secret |

The top-level Wrangler configuration is development-only. Named Wrangler
environments repeat their variables and required secret names because those
fields are not inherited. `BUILD_ID` is the deployed commit SHA in release
workflows and lets an operator correlate probes, logs, and a rollback version.
Local values belong only in ignored `.dev.vars`; never point local development
at production.

Configure the `staging` and `production` GitHub environments with deployment
branch/tag restrictions and required reviewers. Production must require an
independent reviewer who did not author the release. `production-preview` is a
separate environment whose job must finish before the protected production job
can request approval. The two database-bootstrap environments require separate
named reviewers and are used only for an explicitly confirmed first deployment.
Limit the Cloudflare token to the intended account and Workers, the Supabase
token to the intended organization/projects, and any AWS identity to the
compiler stack in `eu-west-1`. Prefer short-lived GitHub OIDC or operator
sessions over long-lived AWS access keys.

Both release workflows are manual-only. A push, merge, or tag cannot start a
deployment. The operator must dispatch the workflow from `main` and type the
environment's exact release confirmation before CI or a protected environment
can be reached. The complete provider-console checklist is
[`DEPLOYMENT_READINESS.md`](../.github/DEPLOYMENT_READINESS.md).

## Secret inventory

Secret values are set separately in each environment and never committed. The
names below are an inventory, not example values.

### GitHub environment secrets

The `staging` and `production` release environments require:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID` (production Pages/route proof)
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_ORGANIZATION_ID`
- `SUPABASE_PROJECT_NAME`
- `FIRELIGHT_CANARY_EMAIL`
- `FIRELIGHT_CANARY_PASSWORD`
- `FIRELIGHT_CANARY_USER_ID`
- `FIRELIGHT_SUPPORT_ADMIN_USER_ID`
- `FIRELIGHT_SUPPORT_ADMIN_EMAIL`
- `FIRELIGHT_SUPPORT_ADMIN_DISPLAY_NAME`
- `FIRELIGHT_EXPECTED_SMTP_HOST`
- `FIRELIGHT_EXPECTED_SMTP_PORT`
- `FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL`
- `FIRELIGHT_EXPECTED_SMTP_USER`

The Cloudflare token must be non-personal and limited to Workers Scripts Write,
Workers Routes Write, Zone Read, and Pages Read for the intended account/zone.
The Supabase access token must likewise be scoped to automation. The project reference is
an identifier, but it remains in the encrypted environment inventory to avoid
accidental cross-environment links. The canary credentials belong to one
confirmed, activated, non-admin account created only for release verification;
they must not belong to a learner or operator. Each deployment and rollback uses
one of that account's compile attempts, so monitor its bounded hourly/daily quota
and never use it for ordinary testing. Do not make environment secrets available
to pull-request jobs.

`production-preview` contains `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, `SUPABASE_ORGANIZATION_ID`, and
`SUPABASE_PROJECT_NAME`, plus the four non-password hosted SMTP expectation
values, scoped to the production project. It has no Cloudflare, compiler,
service-role, pepper, or canary credential. Before linking, the workflow
uses the bounded Supabase Management API to require that protected ref,
organization, name, `eu-west-1` region, and database hostname. It then records a
domain-separated SHA-256 composite project identity, a separate domain-separated
ref-only project identity, and an organization-boundary value plus the current
remote migration-history fingerprint for the later production approval without
exposing their plaintext values. The composite identity detects metadata drift;
the ref-only identity is the rename-stable peer-collision key.

The authoritative logical labels live in the reviewed canonical
`.github/supabase-project-anchors.json`, not in any environment-scoped value.
Its provider-verified organization, staging, and production hashes are distinct,
and the strict no-environment anchor job rejects placeholders or mapping drift.
Staging opens `production-preview` read-only and proves that peer against the
production anchor before any staging mutation;
production binds accepted staging evidence back to the staging anchor before
opening a link. A complete staging/production secret swap therefore fails even
though the two raw projects remain distinct.

`staging-database-bootstrap` contains the staging `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_REF`, `SUPABASE_ORGANIZATION_ID`, and
`SUPABASE_PROJECT_NAME` and hosted SMTP expectations.
`production-database-bootstrap` contains the production preview values plus the
Cloudflare token/account/zone identifiers needed for the retained Pages proof.
Protect each with a required reviewer who checks
the target project in the provider console. These environments are not a general
bypass: the Management API identity proof remains mandatory and a well-formed
deployed `/api/config` that names any different Supabase project fails even after
bootstrap approval.

Create `staging-auth-config` and `production-auth-config` as separately reviewed
environments containing the Supabase project identity, hosted SMTP expectations,
and `SUPABASE_SMTP_PASSWORD`. Only the manual **Configure Supabase Auth**
workflow can use that password after its exact `APPLY_*_AUTH_CONFIG`
confirmation. Every dispatch first snapshots both protected Auth projects,
requires each snapshot to match its own source-pinned logical label and the
shared organization, then rechecks the selected snapshot and canonical peer
immediately before mutation. Routine releases only read and hash hosted
settings. Create `staging-worker-bootstrap` for the first staging Worker and all
nine runtime bindings. Do not pre-create a partial Worker: the bootstrap job proves absence,
uploads secrets with the first version, removes its owner-only temporary file,
and verifies the remote secret names.

### Worker runtime secrets

Wrangler requires these names independently for `staging` and `production`:

- `SUPABASE_URL`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `KIT_CODE_PEPPER`
- `COMPILER_SERVICE_URL`
- `COMPILER_SERVICE_ORIGIN`
- `COMPILER_SERVICE_HOST`
- `COMPILER_SERVICE_TOKEN`

The Supabase URL and publishable key are intentionally returned to the signed-out
browser by `/api/config`; they are configuration, not authorization secrets. They
remain Worker bindings so one bundle can be promoted without rebuilding against
the wrong project. The project reference pins the hosted Supabase hostname. The
compiler origin and hostname independently pin the `eu-west-1` Lambda Function
URL. Readiness fails closed if any binding is missing or malformed. Compiler
responses must carry the exact environment, canonical service, and protocol
version plus canonical nonzero compiler build and digest values; compiler release
probes separately match the build and digest to the deployed AWS release. Every
Worker deployment carries the complete nine-binding file atomically. The
service-role key, pepper, compiler URL, and compiler token must never enter a
`VITE_*` variable, browser response, log, ticket, or screenshot.

The protected `staging-worker-bootstrap`, `staging`, and `production`
environments also hold `COMPILER_SERVICE_BUILD_ID` and
`COMPILER_SERVICE_IMAGE_DIGEST` as release-only compiler acceptance metadata.
They are supplied to the authenticated compiler probe and retained in accepted
release evidence, but are deliberately excluded from Wrangler's runtime secret
file. Before database mutation, each web workflow performs bounded direct reads
with the prospective Supabase publishable and service-role credentials, checks
the URL/ref and pepper contract, and compiles the source-pinned First Spark
fixture through the protected compiler. The compiler probe repeats after
database acceptance immediately before Worker deployment.

List names without values with:

```sh
npx wrangler secret list --env staging --format json
npx wrangler secret list --env production --format json
```

The release workflows run the repository's secret-inventory verifier before a
Worker release. Set or rotate an existing Worker secret through Wrangler's interactive prompt,
for example `npx wrangler secret put KIT_CODE_PEPPER --env staging`; never pass a
secret value as a command argument or through `echo`.

### AWS and Supabase provider secrets

The compiler gateway token is a raw high-entropy value stored in one AWS Secrets
Manager secret per environment. Terraform receives only that secret's ARN through
`auth_secret_arn`; the Fargate task receives neither the token nor a task role. If
the secret uses a customer-managed KMS key, keep its key ARN in the reviewed
Terraform input and restrict decrypt permission to the gateway role. Treat the
sensitive Function URL output as the corresponding Worker secret.

Create protected `compiler-staging` and `compiler-production` GitHub
environments for the manual **Deploy compiler** workflow. Each holds the exact
environment variables `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`,
`FIRELIGHT_TERRAFORM_STATE_BUCKET`,
`FIRELIGHT_TERRAFORM_STATE_KMS_KEY_ARN`,
`FIRELIGHT_COMPILER_AUTH_SECRET_ARN`, `FIRELIGHT_COMPILER_VPC_CIDR`, and the
optional `FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN`, plus only the encrypted
`COMPILER_SERVICE_TOKEN`. The jobs reject ambient access keys and account root,
assume the canonical environment role through GitHub OIDC, and independently
approve the saved ECR-bootstrap and full infrastructure plans. See
`docs/backend-release-readiness.md` for the exact role, state, and policy
contract.

Supabase owns the hosted database password, access token, service-role key, and
SMTP credentials. Configure Auth redirect origins, email confirmation, recovery
templates, and SMTP separately for each project. Keep provider recovery codes and
break-glass credentials in the approved organizational vault, not GitHub.

Hosted Auth mutation is not part of routine deployment. Dispatch **Configure
Supabase Auth** from `main`, select one environment, type its exact
`APPLY_*_AUTH_CONFIG` confirmation, and approve the dedicated Auth-config
environment. The job PATCHes the versioned settings and templates only after
read-only staging and production snapshots prove their canonical labels, the
same organization, and distinct ref-only project identities. It rechecks the
selected composite, organization, and ref-only snapshot immediately before
PATCH, then reads them back and emits only a non-secret hash. Every
release independently rechecks that hashable contract, including the exact SMTP
user; it never receives `SUPABASE_SMTP_PASSWORD`.

Pin one confirmed canary Auth UUID/email and one distinct confirmed support-admin
UUID/email/display name per environment. Routine releases prove Auth identity,
learner activation, support role, and database state before publishing a Worker.
On the first schema release only, the optional
`BOOTSTRAP_*_RELEASE_PRINCIPALS` confirmation runs after migrations and linked
pgTAP, promotes only that pinned support profile, and immediately reruns the
normal verifier. It is not a general role-edit facility.

## Secret rotation

For a routine credential rotation:

1. Open a change record, identify every consumer, and confirm a rollback value is
   available in the approved vault without copying it into the record.
2. Rotate staging first. Update the provider and consumer in the order supported
   by their overlap window, then probe health, readiness, authentication, and one
   representative operation.
3. Confirm the old credential is rejected only after the new path succeeds.
4. Repeat under production approval, then close the record with names, versions,
   timestamps, and test outcomes only.

The compiler token needs a coordinated window: update AWS Secrets Manager and the
Worker secret, publish a fresh gateway version or wait longer than the gateway's
five-minute warm-cache maximum, verify rejected-old and accepted-new probes, and
then retire the old token. Never print either token. Supabase key rotation must
include login, bootstrap, learner RLS, admin denial, and service-only RPC smoke
tests. Rotate the GitHub Cloudflare/Supabase automation credentials independently
after verifying their least-privilege replacements.

### Kit-code pepper rotation

`KIT_CODE_PEPPER` is not an ordinary credential. Only HMACs are stored, and each
16-character Crockford code is shown once, so existing issued hashes cannot be
converted to a new pepper.

- A planned, non-disruptive rotation requires a reviewed application and schema
  release that supports a new hash version plus a temporary previous-pepper
  lookup. New batches use the new version; the previous pepper remains available
  only until every old issued code is claimed, revoked, or replaced. Remove the
  compatibility path and old pepper in a later release.
- With the current single-pepper implementation, changing the pepper immediately
  invalidates every unclaimed code from the old version. In an emergency, freeze
  claims and generation, inventory old `issued` rows without exposing hashes,
  rotate the pepper, revoke those rows through the audited admin boundary with
  reason `security`, issue replacements, and notify their custodians. Already
  claimed code access is row-based and remains active unless separately revoked.
- Never restore an old pepper merely to redeem one code after a compromise. Never
  log, export, compare, or send stored HMACs to a browser.

Test a newly generated staging code and a deliberately retired code after either
path. Production rotation requires security and data-owner approval.

## Release paths

Pull requests run checks only. They validate lesson content and policy, generated
Worker types, TypeScript, lint, browser and Worker tests, production build,
dependency audit, both Wrangler dry runs, local Supabase migrations/RLS tests,
Python compiler tests, Terraform format/validate/mock plan, and a container build.
Pull-request jobs have read-only repository permission and no deployment
environment secrets.

Before any hosted release:

1. Identify the immutable commit or `v*` tag and review the complete diff.
2. Confirm CI is green and the exact staging/production dry run passed.
3. Confirm the target environment's secret-name inventory is complete.
4. Confirm a recent usable database recovery point and the last restore-drill
   result. Record the expected recovery point and rollback owner.
5. Confirm the database migration is additive or otherwise compatible with the
   currently deployed Worker. Do not proceed if the old Worker would fail after
   the migration.
6. Confirm dashboards, alerts, on-call ownership, and the previous verified
   Worker version/build ID.
7. Recheck the unresolved hardware and provider gates at the end of this runbook.

### Staging

Manually invoke `.github/workflows/deploy-staging.yml` from `main` and type
`DEPLOY_STAGING`. On the first release also type `BOOTSTRAP_STAGING_WORKER`;
the separately approved bootstrap job requires the Worker to be absent, uploads
all protected bindings with its first version, creates the Custom Domain, removes
the temporary owner-only secret file, and proves the exact build is reachable.
Before any
`supabase db push`, a bounded probe of canonical
`https://staging.firelight.ie/api/config` must report exactly
`https://<staging-project-ref>.supabase.co`, and a separate Management API proof
must match the protected project ref, organization, name, region, and database
host. A separately protected, read-only `production-preview` snapshot must also
match the source-pinned production label while staging matches its own anchor.
The migration job rechecks those identities and the canonical peer before
linking the database.
After the configured `staging` environment approval, it builds, verifies Worker
secret names, proves the prospective Supabase bindings and current authenticated
compiler with a real First Spark compile, previews and applies migrations,
repeats the compiler proof, deploys the staging Worker/assets with
the commit SHA in the `BUILD_ID` binding and Cloudflare version metadata, and
probes health, readiness, public config, an authenticated bootstrap, and one
controlled First Spark compile. The canary requires the exact environment,
commit SHA, Supabase project reference, and signed-in canary user ID/email; it
signs the dedicated account out globally even on failure. For the progress-write
boundary release, the applied migration is still in its compatible expand state.
After the first complete canary succeeds, the workflow calls the postgres-only,
idempotent finalizer through an exact bounded Supabase Management API query. It
then runs the complete canary a second time against the contracted boundary.
Only after both proofs succeed does the workflow capture the exact 100%
Cloudflare deployment/version/build tuple and retain it as a 90-day immutable
workflow artifact. It also re-proves the current protected Supabase snapshot,
captures a versioned staging web promotion artifact bound to the canonical
repository, workflow, exact commit, run, attempt, composite project snapshot,
ref-only project identity, and organization boundary, and prints the exact run
ID/evidence SHA-256 pair needed by production.

For the first database-bound release, also type `BOOTSTRAP_STAGING_DATABASE` so
the target proof enters the separately protected
`staging-database-bootstrap` environment. After the first Worker bootstrap, its
canonical `/api/config` must name the exact protected project. The verifier's
absence-only fallback accepts only HTTP 404/410 under this explicit approval;
network failures, redirects, malformed content, 5xx responses, and a valid
config naming another project fail closed. The normal `staging` environment is
approved independently before migrations. If the pinned roles still need their
one-time database state, also type
`BOOTSTRAP_STAGING_RELEASE_PRINCIPALS`; never use any bootstrap confirmation for
an outage or routine release.

Run fresh-account, activation, progress, admin-denial, admin support, account
deletion, compile failure, compile success, serial disconnect/reconnect, and
legacy-migration smoke tests. A successful readiness response is necessary but
not sufficient; it checks required bindings, not Supabase or AWS reachability.

### Production

Production is invoked only by a manual dispatch from `main`. Type both
`DEPLOY_PRODUCTION` and `CUTOVER_FIRELIGHT_IE_TO_WORKER`, and copy the exact
`staging_run_id` and `staging_evidence_sha256` from the accepted staging run
summary. The workflow requires its commit to be on `main`, reruns CI, verifies
that explicit successful exact-commit staging run, downloads only its
run-and-attempt-specific artifact, and validates the canonical evidence JSON and
hash. It does not select a mutable "latest successful" run.
A separate `preview-production-migrations` job enters `production-preview`,
first requires accepted evidence to match the source-pinned staging label, then
proves that the protected Management API project matches the source-pinned
production label, differs from staging, and shares the protected organization
boundary. It separately freezes the composite project snapshot. It then proves
the deployed
`/api/config` project, links that exact project, fingerprints its remote migration
history, runs `supabase db push --dry-run`, and records the release SHA, Git
migration-tree hash, project identity, and migration-state hashes as job
evidence. Only after that job succeeds does the `apply-and-deploy` job request
the protected `production` approval. The
independent reviewer inspects the preview log, ordered migration filenames, and
hash before approval. The protected job checks out the exact previewed SHA,
recomputes the migration tree, matches its environment's project-reference hash,
rechecks the Management API and live `/api/config`, and requires that remote
migration history still matches the preview. It then reruns the dry-run, applies,
deploys, and runs the complete production canary while the progress migration is
in its compatible expand state. The workflow then executes the postgres-only
progress-boundary finalizer through the Management API and repeats the complete
production canary against the contracted state. Only the twice-proved release is
followed by the same exact Cloudflare release-tuple artifact used for rollback
eligibility.

Before any production database or role mutation, the protected job also proves
that the Worker target is absent only under the explicit bootstrap confirmation
or already exists for a routine release, and validates the complete first-version
binding file or existing remote secret inventory. It repeats the target proof
immediately before deployment to close the approval-to-cutover race. It also
validates the prospective Supabase credentials/pepper and compiles First Spark
through the exact protected compiler before migration, then repeats that
compiler probe immediately before traffic cutover.

Both preview and protected apply re-fetch the production Management API project
snapshot immediately before their Supabase link. The protected job repeats the
same composite/ref-only/organization peer-isolation proof immediately before
either Worker deploy path. Project renames cannot change the ref-only collision
result. If staging and production secrets ever resolve to the same hosted
project, all production paths fail before link, preview, migration, or cutover.

Staging applies the same ordering: whether the Worker was just bootstrapped or
already existed, the protected staging job proves the target and complete secret
inventory before migrations, then repeats the target proof immediately before
the routine Worker release.

The production Wrangler environment intentionally configures a zone route for
`firelight.ie/*`, not a Worker Custom Domain. The existing legacy Pages custom
domain owns the proxied DNS record and remains the rollback origin. The Worker
route takes precedence only after the approved deploy; it does not replace that
record or require the Pages project to be deleted. Immediately before approval,
the workflow proves the retained direct-upload project, active custom domain,
production deployment UUID, full commit SHA, and exact immutable favicon bytes.
The deployment UUID, commit, and evidence hash are pinned in the reviewed
workflow source and rechecked on every production release; the dispatcher cannot
substitute a different fallback. Accepting a newer Pages fallback first requires
a reviewed code change. If the cutover must be abandoned, dispatch **Restore
production Pages** with the current Worker version/build. It proves the Worker
is the current 100% deployment and that exactly one route points to it, deletes
only `firelight.ie/*`, then proves the source-pinned Pages asset and HTML fallback
own traffic. Do not remove the Pages custom domain or delete its project during
the pilot observation window.

For the first production database-bound deployment only, manually type
`BOOTSTRAP_PRODUCTION_DATABASE`. The preview then enters the separately protected
`production-database-bootstrap` environment instead of `production-preview` and
requires the retained Pages proof before accepting its legacy HTML
`/api/config`: the public immutable asset must byte-match the pinned Pages
deployment. The later `production` approval repeats the same proof. A live JSON
config naming a different project, changed asset, redirect, network failure, or
5xx response is never overridden. On the first principal setup, also type
`BOOTSTRAP_PRODUCTION_RELEASE_PRINCIPALS`.

Do not bypass the workflow with a local `wrangler deploy`, `supabase db push`, or
Terraform apply. Record the GitHub run, migration list, deployed Worker version,
build ID, probes, and acceptance owner. No command in this document performs that
release automatically.

## Database migration and recovery order

Supabase migrations are forward-only release artifacts:

1. Add compatible schema/functions/policies first. Avoid destructive renames,
   removals, or newly mandatory data in the same release that changes callers.
2. Run local reset, lint, and all pgTAP suites against a disposable database.
3. Apply the exact files to staging through the workflow's `db push --dry-run`
   and approved `db push`; rerun pgTAP/security and HTTP smoke tests there.
4. Confirm old and new Worker behavior against the migrated schema.
5. Preview the same ordered migration set against production, approve, apply,
   deploy the Worker, and verify request/RLS/admin/audit behavior.
6. Remove compatibility branches only in a later migration after every live
   Worker version that needs them is retired.

Never use `db reset`, local seed data, or an ad-hoc SQL editor against a hosted
project. A failed Worker release does not justify reversing an already-used
migration: roll the Worker back to a schema-compatible version and repair the
database with a reviewed forward migration. For suspected corruption, stop
writes, preserve evidence, and restore into an isolated recovery project before
deciding whether to promote a recovery point.

### Progress-write expand/contract boundary

The progress-write cutover is one forward-only release with two explicit states:

1. **Expand:** `db push` installs the service grants and locked finalizer while
   retaining authenticated owner `INSERT`/`UPDATE` grants and policies. The old
   and new Worker paths remain compatible at this point.
2. **Deploy:** publish the Worker version that validates progress and persists it
   with service credentials. Do not contract before that exact build is live.
3. **Prove:** run `scripts/postdeploy-canary.mjs` in full, including an
   authenticated progress mutation and its controlled compile.
4. **Contract:** run `scripts/finalize-progress-write-boundary.mjs` with only the
   protected environment's `SUPABASE_ACCESS_TOKEN` and exact 20-character
   `SUPABASE_PROJECT_REF`. The token needs database-write permission for that one
   Management API query. The script accepts only HTTP 201 JSON containing the
   finalizer's exact canonical boundary result and prints no provider response.
5. **Prove again:** rerun the complete post-deploy canary after contraction.
   Capture release evidence only after this second proof passes.

The finalizer takes an exclusive table lock, removes every `FOR ALL`, `INSERT`,
`UPDATE`, and `DELETE` progress policy, revokes `PUBLIC`, anonymous, and
authenticated `INSERT`/`UPDATE`/`DELETE`, retains authenticated owner `SELECT`,
and verifies effective anonymous mutation access is false and service
`SELECT`/`INSERT`/`UPDATE` remains available with service `DELETE` revoked. It is
idempotent, so a workflow retry can safely repeat the contract step. No API role
can execute the database function directly.

Before contraction, a failed deploy may use a previously verified direct-write
Worker because the expand state is compatible. After contraction, any release
that depends on authenticated direct progress writes is schema-incompatible and
must not be selected by the Worker rollback procedure. Restore service by
deploying a previously verified service-write version or by shipping a reviewed
forward repair. If an emergency truly requires compatibility to be reopened,
use a new reviewed migration with the narrow owner policies and grants, prove
both paths, then contract again; never delete, rewrite, or mark the original
migration unapplied, and never issue ad-hoc grants in the SQL editor.

## Compiler image and infrastructure rollout

The AWS compiler is deliberately outside the web deployment workflows. Dispatch
the manual **Deploy compiler** workflow from the current `main` commit, enter
`DEPLOY_STAGING_COMPILER` or `DEPLOY_PRODUCTION_COMPILER`, and release it under
the matching AWS and security approvals. Staging leaves `staging_run_id` and
`staging_evidence_sha256` empty. After its live First Spark probe succeeds, copy
the run ID and evidence JSON SHA-256 from the accepted staging summary.
Production requires those exact two values and the same current `main` commit;
it rejects a missing, expired, failed, cross-commit, or altered staging artifact
before assuming an AWS role. The evidence also binds domain-separated
fingerprints of the accepted staging AWS account, state location/KMS key, auth
secret, and fixed `10.42.0.0/20` VPC. Production must use the same AWS account,
a distinct state/secret, and the fixed `10.43.0.0/20` VPC. Its current protected
inputs are materialized before AWS access and the resulting safe snapshot is
rechecked by every saved-plan job before Terraform initialization:

1. Run the Python, Terraform, and supply-chain tests. If the current commit does
   not already have an immutable environment-local ECR tag, build the pinned
   `linux/amd64` image and inspect the embedded Arduino CLI/core/Servo versions.
   An existing canonical tag is reused without rebuilding. In both cases, pull
   the exact registry digest, run an exact-target smoke compile, and recheck its
   scan gate.
2. For an absent repository or an interrupted partial bootstrap, also enter the
   environment's exact `BOOTSTRAP_*_COMPILER_ECR` confirmation. A protected
   targeted saved plan may contain only unique `create` or `no-op` actions for
   the immutable ECR repository, lifecycle policy, and operator identity gate;
   any other address, update, destroy, replacement, or read fails. If an apply is
   interrupted after Terraform persists only part of the state, start a new
   dispatch with the same bootstrap confirmation. The new run/attempt produces a
   fresh reviewed plan for only the missing subset. A post-apply targeted plan
   must then prove all three resources present with zero drift. Its binary,
   review text, and hash-bound manifest use only
   create-if-absent keys under
   `firelight/compiler/<environment>/saved-plans/<run-id>/<run-attempt>/ecr-bootstrap`
   in the protected state bucket. Every object explicitly uses the state KMS key,
   and the apply job downloads and verifies that exact manifest and its hashes
   only after OIDC, then reads the exact verified S3 versions; GitHub artifacts
   never carry the Terraform files. The normal
   staging release pushes a unique immutable candidate. Production copies the
   accepted staging digest with
   `skopeo copy --preserve-digests`; it must fail if ECR does not report that
   identical destination digest. The workflow pulls and tests the exact registry
   image and clears its HIGH/CRITICAL scan before binding the canonical commit
   tag with the candidate's exact `BatchGetImage` manifest and `PutImage`. It
   never performs a second Docker push for that tag. Never deploy `latest` or a
   mutable tag.
   Before a production bootstrap plan initializes state, the production role
   must read the accepted digest and canonical commit tag from the fixed staging
   repository. This proves the same-account staging read path before any
   bootstrap apply can write.
3. Put only that digest in the environment's Terraform input. Review a saved plan
   for the no-NAT VPC, private tasks, absent task role/secrets/public IP, bounded
   gateway, exact IAM/endpoint/security-group rules, and expected cost. The full
   plan uses the corresponding `.../<run-id>/<run-attempt>/full` state-bucket prefix,
   conditional writes, SSE-KMS, and a manifest uploaded last. After OIDC, apply
   re-derives every key and verifies encryption metadata, object sizes, manifest,
   and hashes before consuming the saved plan. Terraform plan/apply stdout and
   stderr remain only in mode-`0600` runner files and are never replayed into
   Actions logs; the separately rendered review text is the only human-readable
   plan sent through the protected S3 handoff. Generated backend and tfvars files
   remain runner-local and are never artifacts.
4. Apply staging first. Wait for ECS desired/running counts and all ALB targets to
   become healthy; the ECS deployment circuit breaker must remain enabled.
5. Before any ECR mutation and immediately before both the bootstrap and full
   Terraform applies, read only the protected AWS compiler secret and compare it
   with the GitHub environment token using `hmac.compare_digest`; stop without
   writing when parity fails. In the full apply job, run `npm ci` and export the
   fixed lesson fixture before OIDC or either token is available. Require the deployed ECS tasks and Lambda version to resolve the approved
   digest, the `live` alias to target that immutable Lambda version, all internal
   ALB targets to be healthy, and the alias-qualified Function URL policy to
   contain only the provider-managed public URL invocation and URL-scoped Lambda
   invocation grants. Require the protected token to equal the AWS secret. The
   authenticated gateway GET and compile response must report the exact
   environment, canonical service name, protocol version 1, release commit, and
   registry digest; the unauthenticated response must disclose no identity. Then
   require a real First Spark Nano compilation and exercise the Worker compile proxy, which
   fails closed on identity drift for successful and error responses alike.
6. The staging acceptance artifact binds the successful workflow run, commit,
   registry digest, and safe isolation fingerprints for 30 days. Production
   must prove that exact artifact,
   read that digest from the fixed `firelight-compiler-stg` repository using
   narrowly scoped read-only ECR permission in the same reviewed AWS account,
   and copy it into the production candidate with Skopeo digest preservation. It
   does not rebuild the promotion image. Production requires the candidate
   digest to equal staging before it may bind the production commit tag from the
   same manifest. Repeat the plan, health, and protocol checks before web release
   approval.

Keep the previous reviewed digest and Lambda version until the observation window
closes as recovery evidence. For a bad image, merge a reviewed revert or forward
repair to `main`, then run the normal protected compiler workflow through staging
acceptance and exact-digest production promotion. This is the only automated AWS
recovery path: there is deliberately no local Terraform apply or unverified
previous-digest input. Verify ECS target health, the new immutable gateway
version, the `live` alias, token parity, and the live compile probe before closing
the incident. Do not add a NAT route, public task IP, or broad IAM rule to work
around an outage. The web Worker rollback workflow does not roll back ECS,
Lambda, Terraform, or Supabase.

## Monitoring and alerts

The unauthenticated probes intentionally disclose only status, environment, and
build ID:

```sh
curl --fail --silent --show-error https://staging.firelight.ie/api/health
curl --fail --silent --show-error https://staging.firelight.ie/api/readiness
curl --fail --silent --show-error https://firelight.ie/api/health
curl --fail --silent --show-error https://firelight.ie/api/readiness
```

`/api/health` proves the Worker can answer. `/api/readiness` additionally checks
the exact hosted environment, commit-shaped build ID, Supabase project/hostname,
compiler URL/origin/hostname, and bounded secret shapes. It intentionally makes
no dependency request. The release canary checks public config, performs a
non-persistent Supabase sign-in, confirms the dedicated account is activated,
compiles First Spark through the Worker, validates the returned artifact shape,
and signs out globally. It does not upload to a board or exercise SMTP, so those
remain separate acceptance gates.

Workers observability records only the application's redacted JSON
request-completion events with request ID, method, path, status, and duration.
Automatic invocation logs and traces are disabled because they can retain raw
query strings or path identifiers before application redaction. Inspect a live
incident with read-only tails:

```sh
npx wrangler tail --env staging --format json --status error
npx wrangler tail --env production --format json --status error
npx wrangler versions list --env production --json
```

Do not broaden logs to authorization headers, cookies, origins, request/response
bodies, emails, kit codes/HMACs, source, HEX, service URLs/tokens, or exception
messages. Search by request ID or safe error code and keep copied excerpts inside
the restricted incident record.

Create provider alerts before pilot traffic. Initial low-volume pilot triggers
should include two consecutive failed health/readiness probes; Worker 5xx rate;
Supabase Auth/PostgREST/database availability, connection, storage, and backup
failures; Lambda errors, throttles, and duration approaching the 45-second bound;
ECS running count below desired; unhealthy ALB targets; target 5xx/latency; and
compiler `UNAVAILABLE`, `TIMEOUT`, or internal-error clusters. Route alerts to a
named primary and backup. Tune thresholds from observed pilot traffic without
silencing a dependency outage or learner-data isolation failure.

## Kit-code operations

An administrator generates 1–100 cryptographically random 16-character
Crockford codes from `/admin`. The page displays/export plaintext once; only
peppered HMAC-SHA-256 values are stored. Every display and CSV row pairs the
plaintext with its stable database kit ID; preserve that exact pair in the
approved issuance store because revocation uses the ID, not the plaintext.
Verify the count and pairing, clear the page, and never attach the file to chat,
email, analytics, or a ticket. If either plaintext or its pairing is lost, it
cannot be reconstructed from the database; revoke the recorded ID where known
and issue a replacement.

To revoke a code:

1. Verify the exact kit ID, claimant, reason category, and support authorization.
2. In `/admin`, select the kit, choose the bounded reason, and type `REVOKE`.
3. Verify the state is `revoked`, code-derived learner access is gone, any queued
   or running compile is failed with `ACCESS_REVOKED`, and the first transition
   produced one `kit.revoke` audit event.
4. Confirm a retry is idempotent and does not create another transition event.
5. Issue a new code when replacement is approved; a revoked code is never reused.

Revocation removes code-derived access only. A grandfathered entitlement requires
a separate reviewed data operation; the pilot admin console does not silently
remove it. Never identify a kit in operations by its plaintext code or stored HMAC.

## Learner data export and account deletion

The account page downloads schema version 2 from authenticated
`GET /api/account/export`; it does not compose an export from cached bootstrap
state. The file contains the Auth email and profile, a safe activation projection,
every stored lesson/version progress row and optional code snapshot, compile-job
metadata, and browser-upload evidence. It excludes kit plaintext/HMACs, service
credentials, raw compile source, and HEX artifacts. Firelight does not retain a
separate server-side export artifact.

The export is complete within hard limits: 256 progress records, 10,000 compile
jobs, 10,000 upload-evidence records, and 4 MiB total JSON. The API returns
`ACCOUNT_EXPORT_TOO_LARGE` rather than silently truncating any category. Escalate
that error before retrying; do not manually assemble a partial file. Support must
not ask a learner to attach the export to a ticket or chat; the learner should
store it privately and delete unneeded copies.

### Hard deletion

Self-service deletion is a hard delete, not deactivation. The learner must sign
out and sign in with the password immediately before the request, then type
`DELETE`. The Worker binds the request to that exact Supabase `session_id` and
accepts only an `auth.sessions.created_at` within 15 minutes. JWT refresh time and
the account-wide last-sign-in field do not satisfy the guard, so an old stolen
session cannot appear fresh because another device signed in.

Successful deletion removes the Auth user and cascades the profile, lesson
progress/code snapshots, compile jobs, and upload evidence. It purges this
browser's owner-scoped drafts, revokes and de-identifies the claimed kit, and
nulls the deleted actor reference in retained audit events. The kit cannot be
reused. The account and progress cannot be restored through the application.

If the API returns `RECENT_SIGN_IN_REQUIRED`, sign out locally, sign back in, and
retry; do not weaken the window or use a refreshed token. The admin console has no
support-user deletion shortcut. Exceptional legal/support deletion needs verified
authority, a reviewed procedure, and the same downstream checks—never direct
table deletion.

Backups may retain deleted rows until their provider retention expires. A restored
database must not silently resurrect an account. The current self-service path
does not create an external restore-suppression ledger, so production restore
promotion requires a recovery point after the deletion or an approved restricted
reconciliation source that replays deletions and revocations before traffic. This
is a production recovery gate, not a reason to retain extra learner data in logs.

## Backup and restore drills

Enable and verify hosted backups and point-in-time recovery separately on both
Supabase projects; record the provider's actual retention, recovery-point
objective, and recovery-time objective in the private service inventory. Do not
assume production settings apply to staging.

At least quarterly and before the first pilot:

1. Select a recovery point and restore it into an isolated, access-restricted
   recovery project. Never overwrite the live project for a drill.
2. Keep production DNS, SMTP, webhooks, Worker secrets, and compiler credentials
   disconnected so the restore cannot contact learners or production services.
3. Apply only later forward migrations, then run database lint, pgTAP/RLS/admin
   denial tests, row-count/invariant checks, and representative API reads.
4. Reconcile account deletions and kit revocations after the selected recovery
   point before any promotion decision.
5. Destroy the drill copy under the approved data-retention process and record
   timing, evidence, gaps, and remediation without exporting row contents.

Also retain the previous verified Cloudflare Worker version and compiler digest.
ECR expires only abandoned untagged manifests; immutable candidate and commit
tags are retained so the running and accepted rollback digests cannot be removed
by count-based lifecycle churn. That image history is not a database backup.
Protect and back up Terraform state using the approved encrypted remote backend
with locking; never commit state or copy sensitive outputs into the repository.

## Incident triage and rollback

1. Declare severity and owner; record UTC start time, environment, build ID,
   request IDs, and safe error codes.
2. Check `/api/health` and `/api/readiness`, Cloudflare error rate/tail, Supabase
   status/logs, then Lambda/ECS/ALB metrics. Determine whether the fault is edge,
   identity/database, compiler, or physical/client-side.
3. Contain the narrowest boundary. Pause release approvals; for credential or
   source-isolation concerns, disable the compiler gateway, rotate credentials,
   and preserve redacted evidence. Do not expose internal services to recover.
4. If the Worker is faulty and the current schema is backward compatible, list
   versions, select a previously verified ID, and invoke
   `.github/workflows/rollback-worker.yml` from `main`. The workflow pins its
   implementation to the exact dispatched commit before approval-gated tools or
   dependencies run. Choose the environment, enter the
   version ID, its expected lowercase commit SHA, and the exact accepted release
   run ID retained from that release's summary, type `ROLLBACK`, obtain that
   environment's approval, and require the complete identity/compiler canary to
   match that build before declaring recovery. Before mutation, the workflow
   requires the entered SHA to be a commit on `main`, fetches and verifies that
   explicitly selected successful environment release run, downloads its
   immutable release-evidence artifact,
   and binds the selected version to that artifact's account, Worker, environment,
   build, deployment, and version IDs. Version 3 evidence also requires the
   current source-pinned anchor set, selected Supabase project-ref/organization
   identities, compiler connection fingerprint, and compiler protocol to match
   the accepted release. The compiler build and image digest recorded by that
   older release remain audit metadata: they need only be canonical and are not
   required to equal the compiler currently deployed in AWS. Instead, the
   workflow authenticates to the current compiler and directly proves its exact
   protected build, digest, environment, service, protocol, and a real compile,
   then rechecks the selected Supabase composite identity and source-pinned peer
   isolation immediately before `wrangler rollback`. Any mismatch fails before
   traffic changes, and only safe codes and non-secret hashes are printed. It
   then checks Cloudflare's deployable inventory, version metadata/bindings, and
   deployment history to prove that version was previously deployed alone at
   100%. The accepted commit is checked out separately so the post-rollback
   canary compiles that release's First Spark content, not the current branch's
   lesson. Evidence is retained for 90 days;
   an older version without that artifact is not eligible for automated rollback.
   After the progress-write finalizer has run, only a version recorded as using
   the service progress-write boundary is schema-compatible; a direct browser
   writer is not a rollback candidate even if its static pages still render.
5. If the database changed, leave the migrated schema in place and ship a forward
   repair. Use PITR only for confirmed data damage, first in isolation. If the
   compiler changed, use the protected revert/forward-repair release above;
   Worker rollback does not change AWS.
6. Monitor through the agreed observation window, communicate learner impact
   without exposing personal data, then complete root cause and corrective tests.

The last-resort web recovery is a previously verified schema-compatible
static/Worker release; keep its version and domain rollback procedure available
until pilot acceptance. After progress-write contraction, an older direct-write
static release may be used only as a read-only outage page, not to record learner
progress. Never combine a Worker rollback with an unreviewed database downgrade.

Compiler alarms, dashboard signals, public probes, notification routing, and the
staging drill procedure are defined in
[`monitoring.md`](./monitoring.md). Repository definitions are not hosted
acceptance: confirm both responders, ALARM and OK delivery, metric ingestion, and
the public build identity before relying on them during an incident.

## Audit handling and retention

Admin reads are paginated and service-mediated. Database RPCs independently
verify the actor's current admin role. Learners cannot call them or directly read
support projections. Kit-batch creation and first revocation transitions are
audited; an idempotent retry does not fabricate another event.

Audit metadata is an object capped at 4 KiB and rejects known plaintext-code,
hash, and source keys. Keep metadata to bounded categories, counts, version,
result, and opaque target IDs. Treat actor and target IDs as restricted personal
data. Do not enrich events with email, display name, source/artifact hashes,
diagnostic bodies, secrets, free-text notes, IP addresses, or full request data.

The data owner must approve the audit retention window before production. The
controlled-pilot default is 180 days unless legal/security policy requires a
different period. The schema currently has no automatic expiry, so a reviewed,
tested purge mechanism and backup-expiry behavior are an operations gate before
the first event exceeds that window. A purge records only cutoff, count, approver,
and outcome in the restricted change system; it never exports deleted rows.

CloudWatch compiler logs default to 14 days through Terraform. Set Cloudflare and
Supabase log retention in their provider controls to the shortest period that
meets incident needs and the approved data policy. Access to all logs and audit
history is least-privilege, reviewed periodically, and removed promptly when an
operator's role ends.

## External release gates

Automated checks do not satisfy these gates. Record named owners and evidence
before pilot rollout:

- Create separate hosted Cloudflare, Supabase, AWS, GitHub environment, SMTP,
  backup/PITR, DNS, and approval configuration. Apply the repository monitoring
  definitions, confirm primary and backup alert recipients, complete the staged
  notification/metric drill, then complete a restore drill and incident rollback
  rehearsal.
- Build and scan the exact compiler image, verify its embedded toolchain and
  compile path, apply reviewed AWS Terraform, and test the gateway/ALB/ECS
  isolation and failure paths. Repository-source compilation with the pinned
  toolchain is recorded in `curriculum-verification.md`; image, hosted, and
  physical acceptance remain separate gates.
- Obtain signed procurement/electrical approval for the exact regulated SG90
  supply, motor battery pack, TT motors, connectors/wiring/protection, and
  TB6612FNG carrier. Do not power Servo Gate or Trail Rover before approval.
- Complete every build with the controlled kit on current Chrome and Edge on
  macOS and Windows. Include clone/CH340 enumeration, wrong-signature rejection,
  upload/readback, serial observation, cancellation, unplug/reconnect, sensor
  timeout, raised-wheel rover tests, and a fresh account through Rover.
- Resolve every critical accessibility/security issue, cross-user isolation
  failure, serial cleanup failure, or compiler artifact-integrity failure. Keep
  the previous site release available until the observation window closes.
- Complete every unchecked item in
  [`.github/DEPLOYMENT_READINESS.md`](../.github/DEPLOYMENT_READINESS.md),
  including the manual-only workflow confirmations and retained Pages rollback
  route, before the first hosted release.

The detailed hardware evidence matrix is in
[`curriculum-verification.md`](./curriculum-verification.md), and the compiler
trust boundary is in [`compiler-service.md`](./compiler-service.md). Hosted
monitoring acceptance is in [`monitoring.md`](./monitoring.md).
