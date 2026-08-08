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

| Boundary | Staging | Production |
| --- | --- | --- |
| Cloudflare Worker | `firelight-staging` | `firelight-production` |
| Public host | `staging.firelight.ie` | `firelight.ie` |
| Runtime variable | `ENVIRONMENT=staging` | `ENVIRONMENT=production` |
| GitHub release environment | `staging` | `production` |
| GitHub preview environment | not separate | `production-preview` |
| First-deploy approval environment | `staging-database-bootstrap` | `production-database-bootstrap` |
| Supabase | dedicated `eu-west-1` project | separate dedicated `eu-west-1` project |
| AWS compiler | dedicated state, VPC, ECR, service, and secret | separate dedicated state, VPC, ECR, service, and secret |

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

## Secret inventory

Secret values are set separately in each environment and never committed. The
names below are an inventory, not example values.

### GitHub environment secrets

The `staging` and `production` release environments require:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_ORGANIZATION_ID`
- `SUPABASE_PROJECT_NAME`
- `FIRELIGHT_CANARY_EMAIL`
- `FIRELIGHT_CANARY_PASSWORD`

The first three credentials must be scoped to automation rather than a personal
administrator account where the provider supports it. The project reference is
an identifier, but it remains in the encrypted environment inventory to avoid
accidental cross-environment links. The canary credentials belong to one
confirmed, activated, non-admin account created only for release verification;
they must not belong to a learner or operator. Each deployment and rollback uses
one of that account's compile attempts, so monitor its bounded hourly/daily quota
and never use it for ordinary testing. Do not make environment secrets available
to pull-request jobs.

`production-preview` contains only `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, `SUPABASE_ORGANIZATION_ID`, and
`SUPABASE_PROJECT_NAME`, scoped to the production project. It has no Cloudflare,
compiler, service-role, pepper, or canary secret. Before linking, the workflow
uses the bounded Supabase Management API to require that protected ref,
organization, name, `eu-west-1` region, and database hostname. It then records a
SHA-256 identity value and the current remote migration-history fingerprint for
the later production approval without exposing their plaintext values.

`staging-database-bootstrap` contains the staging `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_REF`, `SUPABASE_ORGANIZATION_ID`, and
`SUPABASE_PROJECT_NAME`. `production-database-bootstrap` contains all five
Supabase preview values above. Protect each with a required reviewer who checks
the target project in the provider console. These environments are not a general
bypass: the Management API identity proof remains mandatory and a well-formed
deployed `/api/config` that names any different Supabase project fails even after
bootstrap approval.

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
URL. Readiness fails closed if these values disagree. The service-role key,
pepper, compiler URL, and compiler token must never enter a `VITE_*` variable,
browser response, log, ticket, or screenshot.

List names without values with:

```sh
npx wrangler secret list --env staging --format json
npx wrangler secret list --env production --format json
```

The release workflows run the repository's secret-inventory verifier before a
migration. Set or rotate a Worker secret through Wrangler's interactive prompt,
for example `npx wrangler secret put KIT_CODE_PEPPER --env staging`; never pass a
secret value as a command argument or through `echo`.

### AWS and Supabase provider secrets

The compiler gateway token is a raw high-entropy value stored in one AWS Secrets
Manager secret per environment. Terraform receives only that secret's ARN through
`auth_secret_arn`; the Fargate task receives neither the token nor a task role. If
the secret uses a customer-managed KMS key, keep its key ARN in the reviewed
Terraform input and restrict decrypt permission to the gateway role. Treat the
sensitive Function URL output as the corresponding Worker secret.

Supabase owns the hosted database password, access token, service-role key, and
SMTP credentials. Configure Auth redirect origins, email confirmation, recovery
templates, and SMTP separately for each project. Keep provider recovery codes and
break-glass credentials in the approved organizational vault, not GitHub.

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

A merge to `main` invokes `.github/workflows/deploy-staging.yml`. Before any
`supabase db push`, a bounded probe of canonical
`https://staging.firelight.ie/api/config` must report exactly
`https://<staging-project-ref>.supabase.co`, and a separate Management API proof
must match the protected project ref, organization, name, region, and database
host. The migration job rechecks those identities before linking the database.
After the configured `staging` environment approval, it builds, verifies Worker
secret names, previews and applies migrations, deploys the staging Worker/assets with
the commit SHA in the `BUILD_ID` binding and Cloudflare version metadata, and
probes health, readiness, public config, an authenticated bootstrap, and one
controlled First Spark compile. The canary requires the exact environment,
commit SHA, Supabase project reference, and signed-in canary user ID/email; it
signs the dedicated account out globally even on failure. Only after that canary
succeeds does the workflow capture the exact 100% Cloudflare deployment/version/
build tuple and retain it as a 90-day immutable workflow artifact.

There is one explicit first-deploy path when no valid `/api/config` exists. Run
the staging workflow manually and type `BOOTSTRAP_STAGING_DATABASE`. The target
job enters the separately protected `staging-database-bootstrap` environment;
after its reviewer confirms the project in Supabase, it may accept an absent
endpoint only when the canonical config request returns HTTP 404 or 410. Network
failures, malformed/non-Firelight responses, redirects, 5xx responses, and a
valid config naming another project all fail closed. The target job does not
apply a migration. The normal `staging` environment must then be approved
independently before the migration job can repeat the proof and continue. Do not use this confirmation
for an outage or routine release.

Run fresh-account, activation, progress, admin-denial, admin support, account
deletion, compile failure, compile success, serial disconnect/reconnect, and
legacy-migration smoke tests. A successful readiness response is necessary but
not sufficient; it checks required bindings, not Supabase or AWS reachability.

### Production

Production is invoked by an approved `v*` tag or manual dispatch. The workflow
requires its commit to be on `main`, reruns CI, and fails closed unless GitHub has
a successful staging deployment run whose `head_sha` is the exact release commit.
A separate `preview-production-migrations` job enters `production-preview`,
proves the protected Management API project identity and currently deployed
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
deploys, and runs the complete production canary. A successful canary is followed
by the same exact Cloudflare release-tuple artifact used for rollback eligibility.

For the first production database-bound deployment only, manually type
`BOOTSTRAP_PRODUCTION_DATABASE`. The preview then enters the separately protected
`production-database-bootstrap` environment instead of `production-preview` and
uses the same absence-only bootstrap rules as staging. The later `production`
approval remains mandatory. A live config naming a different project is never
overridden, and a 5xx response is not treated as an uninitialized endpoint.

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

## Compiler image and infrastructure rollout

The AWS compiler is deliberately outside the web deployment workflows. Release
it separately under AWS and security approval:

1. Run the Python, Terraform, and supply-chain tests. Build the pinned
   `linux/amd64` image, inspect embedded Arduino CLI/core/Servo versions, run an
   exact-target smoke compile, and scan the image.
2. Push to the target environment's immutable ECR repository and obtain the
   registry-reported `sha256` digest. Never deploy `latest` or a mutable tag.
3. Put only that digest in the environment's Terraform input. Review a saved plan
   for the no-NAT VPC, private tasks, absent task role/secrets/public IP, bounded
   gateway, exact IAM/endpoint/security-group rules, and expected cost.
4. Apply staging first. Wait for ECS desired/running counts and all ALB targets to
   become healthy; the ECS deployment circuit breaker must remain enabled.
5. Probe unauthorized, authorized, invalid-source, compile-error, timeout/busy,
   and valid Nano artifact paths. Then exercise the Worker compile proxy.
6. Promote the identical reviewed image content to production by immutable digest
   and repeat the plan, health, and protocol checks before web release approval.

Keep the previous reviewed digest and Lambda version until the observation window
closes. For a bad image, restore the previous digest through a reviewed Terraform
plan/apply; verify ECS target health, publish or select the matching gateway
version, and validate the `live` alias. Do not add a NAT route, public task IP, or
broad IAM rule to work around an outage. The web Worker rollback workflow does
not roll back ECS, Lambda, Terraform, or Supabase.

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
ECR keeps a bounded image history, but that is not a database backup. Protect and
back up Terraform state using the approved encrypted remote backend with locking;
never commit state or copy sensitive outputs into the repository.

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
   `.github/workflows/rollback-worker.yml`. Choose the environment, enter the
   version ID and its expected lowercase commit SHA, type `ROLLBACK`, obtain that
   environment's approval, and require the complete identity/compiler canary to
   match that build before declaring recovery. Before mutation, the workflow
   requires the entered SHA to be a commit on `main`, finds the exact successful
   environment release run, downloads its immutable release-evidence artifact,
   and binds the selected version to that artifact's account, Worker, environment,
   build, deployment, and version IDs. It then checks Cloudflare's deployable
   inventory, version metadata/bindings, and deployment history to prove that
   version was previously deployed alone at 100%. The accepted commit is checked
   out separately so the post-rollback canary compiles that release's First Spark
   content, not the current branch's lesson. Evidence is retained for 90 days;
   an older version without that artifact is not eligible for automated rollback.
5. If the database changed, leave the migrated schema in place and ship a forward
   repair. Use PITR only for confirmed data damage, first in isolation. If the
   compiler changed, use the immutable-digest rollback above; Worker rollback does
   not change AWS.
6. Monitor through the agreed observation window, communicate learner impact
   without exposing personal data, then complete root cause and corrective tests.

The last-resort web recovery is the previously verified static/Worker release;
keep its version and domain rollback procedure available until pilot acceptance.
Never combine a Worker rollback with an unreviewed database downgrade.

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
  monitoring, backup/PITR, DNS, and approval configuration; complete a restore
  drill and an incident rollback rehearsal.
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

The detailed hardware evidence matrix is in
[`curriculum-verification.md`](./curriculum-verification.md), and the compiler
trust boundary is in [`compiler-service.md`](./compiler-service.md).
