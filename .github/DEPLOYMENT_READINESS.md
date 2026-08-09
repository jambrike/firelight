# Deployment readiness: stop immediately before deploy

Firelight releases are deliberately manual. A push, merge, tag, or pull request
cannot deploy staging or production. Provider mutation begins only after an
operator dispatches a workflow from `main`, enters its exact confirmation, and
passes the matching protected-environment review.

This checklist contains names and identifiers, never secret values. Complete it
in the provider consoles, record the responsible owner and timestamp, and stop
before dispatching **Deploy staging** or **Deploy production**.

## Cloudflare

- [ ] Confirm the active `firelight.ie` zone is in the intended account. Store
  its 32-character account and zone identifiers as `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_ZONE_ID` in the protected environments that need them.
- [ ] Create a non-personal token scoped to that account/zone with **Workers
  Scripts Write**, **Workers Routes Write**, **Zone Read**, and **Pages Read**.
  Store it as `CLOUDFLARE_API_TOKEN`; do not grant DNS write or Pages write.
- [ ] Leave `firelight-staging` and `firelight-production` absent before their
  one-time bootstrap releases. The workflows prove absence, provision all nine
  secrets atomically with the first version, and then verify the remote secret
  inventory. A manually pre-created, partial Worker intentionally fails closed.
- [ ] Confirm `staging.firelight.ie` has no conflicting DNS record or Custom
  Domain. The first approved staging Worker release creates it.
- [ ] Keep the existing direct-upload Pages project `firelight`, its
  `firelight.ie` custom domain, and proxied DNS record. The reviewed retained
  production tuple is deployment
  `06b4410d-37ff-4526-ac71-5fc4e65bee91` at commit
  `38e05a32af5e8506e5f4f5d3b516b1f3c405d2c7`, with evidence hash
  `02b573aae8d9cfa71312a4e968d0e1f0cab049341519cc782128f5a68e989b4e`.
  These values are source-pinned and rechecked on every production release.
  Replacing the fallback requires a reviewed code change, not a dispatch input.
- [ ] Do not attach a Worker Custom Domain to `firelight.ie`. Production uses
  the exact `firelight.ie/*` zone route over the retained Pages origin.
- [ ] Keep the Pages project until the pilot rollback window closes. The manual
  **Restore production Pages** workflow verifies the current Worker version,
  deletes only that one route, and proves the retained Pages deployment owns
  traffic afterward.

## Protected GitHub environments

Create every environment below, restrict deployment branches to `main`, require
named reviewers, and prevent self-review where supported. Never expose these
secrets to pull-request jobs.

| Environment | Purpose |
| --- | --- |
| `staging-auth-config` | Explicit one-time or reviewed hosted Auth/SMTP apply |
| `production-auth-config` | Explicit protected production Auth/SMTP apply |
| `staging-worker-bootstrap` | First `firelight-staging` Worker, secrets, and Custom Domain |
| `staging-database-bootstrap` | One-time absent/uninitialized staging database-target approval |
| `staging` | Staging migration, principal proof, Worker release, and canary |
| `production-preview` | Read/preview proof before production approval |
| `production-database-bootstrap` | One-time legacy-Pages-bound production database approval |
| `production` | Production migration, Worker route cutover, canary, and Pages restore |
| `compiler-staging` | OIDC-only staging compiler ECR plan/apply and full release |
| `compiler-production` | OIDC-only production compiler ECR plan/apply and full release |

The logical Supabase mapping is source-pinned in
`.github/supabase-project-anchors.json`, outside every protected environment.
It contains only domain-separated organization and project-ref SHA-256 values,
never raw refs. The organization and production entries are provider-verified;
the staging entry intentionally remains `PENDING_*` until the second hosted
project exists, so every web or Auth mutation fails before entering a protected
target. Replace that placeholder only in a reviewed change after two operators
confirm both provider projects;
the strict verifier rejects placeholders, extra fields, noncanonical bytes,
zero values, and equal staging/production refs.

After both projects exist, generate the candidate canonical file locally with
`scripts/generate-supabase-project-anchors.mjs`, using the two exact project
refs and organization ID as process environment values. The helper writes only
domain-separated hashes to stdout and rejects a same-project mapping. Compare
the candidate with both provider consoles, replace the checked-in placeholder
through a reviewed change, and rerun the strict verifier; do not paste raw refs
or the organization ID into an issue, artifact, or run summary.

```sh
SUPABASE_ORGANIZATION_ID='<reviewed-organization-id>' \
FIRELIGHT_STAGING_SUPABASE_PROJECT_REF='<reviewed-staging-ref>' \
FIRELIGHT_PRODUCTION_SUPABASE_PROJECT_REF='<reviewed-production-ref>' \
node scripts/generate-supabase-project-anchors.mjs > supabase-project-anchors.candidate.json
node scripts/verify-release-environment-anchors.mjs supabase-project-anchors.candidate.json
```

Inspect the candidate locally, copy its canonical JSON into
`.github/supabase-project-anchors.json` through review, and remove the local
candidate; the repository ignores `*.candidate.json` files.

Provision independent staging and production values. The exact workflow is the
source of truth; use these groups to audit completeness:

- Supabase project proof: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
  `SUPABASE_ORGANIZATION_ID`, `SUPABASE_PROJECT_NAME`, and where migrations run,
  `SUPABASE_DB_PASSWORD`.
- Hosted Auth expectation: `FIRELIGHT_EXPECTED_SMTP_HOST`,
  `FIRELIGHT_EXPECTED_SMTP_PORT` (`465` or `587`),
  `FIRELIGHT_EXPECTED_SMTP_ADMIN_EMAIL` (under `auth.firelight.ie`), and
  `FIRELIGHT_EXPECTED_SMTP_USER`. The separately protected Auth-config
  environments also hold `SUPABASE_SMTP_PASSWORD`.
- Release principals: `SUPABASE_SERVICE_ROLE_KEY`,
  `FIRELIGHT_CANARY_USER_ID`, `FIRELIGHT_CANARY_EMAIL`,
  `FIRELIGHT_CANARY_PASSWORD`, `FIRELIGHT_SUPPORT_ADMIN_USER_ID`,
  `FIRELIGHT_SUPPORT_ADMIN_EMAIL`, and
  `FIRELIGHT_SUPPORT_ADMIN_DISPLAY_NAME`. IDs are the exact confirmed Auth user
  UUIDs; canary and support admin must be distinct.
- Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and for
  production Pages/route proof, `CLOUDFLARE_ZONE_ID`.
- Worker runtime bindings: `SUPABASE_URL`, `SUPABASE_PROJECT_REF`,
  `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `KIT_CODE_PEPPER`,
  `COMPILER_SERVICE_URL`, `COMPILER_SERVICE_ORIGIN`,
  `COMPILER_SERVICE_HOST`, and `COMPILER_SERVICE_TOKEN`.
- Web-release compiler evidence: `COMPILER_SERVICE_BUILD_ID` and
  `COMPILER_SERVICE_IMAGE_DIGEST`. These are the exact accepted AWS release
  values used by protected preflight probes and release evidence; they are not
  uploaded as Worker runtime bindings.

`staging-worker-bootstrap`, `staging`, and `production` require the relevant
Cloudflare and Worker-runtime groups. `production-database-bootstrap` also
requires the Cloudflare group so it can prove the exact retained Pages project,
domain, immutable favicon bytes, and public HTML fallback before accepting the
first database target. Database preview/bootstrap environments require the
Supabase project and Auth-expectation values used by their jobs; the routine
`production-preview` environment deliberately receives no service-role or
canary credential. Release-principal secrets remain in `staging`/`production`,
where their proof or one-time bootstrap runs.

Each compiler environment contains these protected GitHub environment
variables: `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`,
`FIRELIGHT_TERRAFORM_STATE_BUCKET`,
`FIRELIGHT_TERRAFORM_STATE_KMS_KEY_ARN`,
`FIRELIGHT_COMPILER_AUTH_SECRET_ARN`, `FIRELIGHT_COMPILER_VPC_CIDR`, and,
when the compiler token secret uses a customer-managed key,
`FIRELIGHT_COMPILER_AUTH_SECRET_KMS_KEY_ARN`. Its sole encrypted GitHub secret
is `COMPILER_SERVICE_TOKEN`, which must equal the exact AWS Secrets Manager
value. Staging and production use different roles, state objects, secrets,
VPCs, tokens, reviewers, and accepted evidence. No long-lived AWS access key is
allowed; the workflow accepts only its canonical GitHub OIDC assumed role.
The two compiler repositories must be in the same reviewed AWS account. The
staging VPC is fixed at `10.42.0.0/20` and production at `10.43.0.0/20`.
Accepted staging evidence contains only domain-separated fingerprints for the
AWS account, state location/KMS key, auth secret, and VPC CIDR. Before any
production AWS session, the workflow materializes the current protected
production inputs, requires the account fingerprint to match, requires every
isolation fingerprint to differ, and binds that snapshot into each saved-plan
job. Raw ARNs, bucket names, and CIDRs are not retained in the staging evidence
artifact. Terraform plan binaries, review text, manifests, generated backend
files, and tfvars never enter GitHub artifacts. Each saved plan instead uses
create-if-absent, run-and-attempt-bound objects in the matching protected state
bucket with explicit SSE-KMS; apply verifies the manifest, exact keys, encryption
metadata, version IDs, and hashes only after OIDC, then downloads those exact
verified versions. The
production deploy role receives read-only `DescribeImages`, `BatchGetImage`,
`BatchCheckLayerAvailability`, and `GetDownloadUrlForLayer` access to only
`firelight-compiler-stg`, so production can copy the accepted digest with
`skopeo copy --preserve-digests` into its own repository; it receives no staging
write access. The workflow verifies the destination digest before testing or
tagging it, then creates the canonical commit tag from the exact ECR manifest
with `BatchGetImage`/`PutImage` rather than a second Docker push. A retry that
finds the immutable canonical commit tag reuses, retests, and re-scans that
digest without rebuilding it. The GitHub compiler token must match the current
AWS secret by constant-time comparison before any of those ECR writes and again
immediately before each Terraform apply.

## Supabase and release identities

- [ ] Run **Configure Supabase Auth** separately for staging and production,
  entering `APPLY_STAGING_AUTH_CONFIG` or
  `APPLY_PRODUCTION_AUTH_CONFIG`. Each dispatch obtains read-only snapshots from
  both Auth-config environments, proves the same organization and distinct
  rename-stable project-ref fingerprints, then rechecks the selected snapshot
  immediately before mutation. Confirm email verification, password recovery,
  exact redirect URL, SMTP, and branded templates by readback.
- [ ] Create and email-confirm the dedicated canary and support-admin Auth users
  in each project. Record their UUIDs in the protected environment; do not reuse
  credentials across environments.
- [ ] On the first migration only, the release workflow may run the explicitly
  confirmed `BOOTSTRAP_*_RELEASE_PRINCIPALS` step after linked pgTAP acceptance.
  It promotes only the pinned support user and then runs the normal verifier.
- [ ] Confirm the canary is activated/grandfathered, is a non-admin learner, and
  can authenticate with `FIRELIGHT_CANARY_PASSWORD`; confirm the support
  identity has only the intended admin role.
- [ ] Confirm hosted backups, recovery ownership, alerts, and Management API
  token scope for both projects.
- [ ] Replace the pending source-pinned staging project-ref fingerprint,
  reverify the organization fingerprint and that both canonical project labels
  are distinct, and require review for every future anchor change. Do not copy
  these anchors into environment-scoped variables, where they could be swapped
  with the secrets.

## Compiler and application evidence

- [ ] Complete the compiler image, immutable digest, Terraform plan, AWS health,
  smoke compile, and compiler canary gates in `docs/operations-runbook.md`.
- [ ] Confirm the authenticated compiler identity exactly matches the selected
  environment, canonical service name, protocol version 1, current release
  commit, and approved registry digest; confirm an unauthenticated response
  discloses none of it.
- [ ] Confirm the release commit is the current commit on `main`, CI is green,
  both strict Wrangler dry runs pass, and staging/production values are
  independent.
- [ ] Confirm the exact release has passed fresh-account, activation, progress,
  admin-denial/support, deletion, compile success/failure, reconnect, legacy
  migration, accessibility, and physical hardware acceptance.
- [ ] Assign an incident operator who has the current Worker version UUID/build
  SHA and retained Pages tuple required by **Restore production Pages**.

## The buttons to press later

After every checkbox above is complete:

1. Configure both hosted Auth projects with **Configure Supabase Auth**, then
   dispatch **Deploy compiler** for `staging`. On its first run include
   `BOOTSTRAP_STAGING_COMPILER_ECR`; use the same confirmation in a fresh
   dispatch if that bootstrap was interrupted. After the separate saved-plan
   approvals,
   complete the protected Function URL/origin/host/token handoff into the
   staging Worker runtime values, and store the accepted compiler build ID and
   image digest as web-release-only evidence values. Leave `staging_run_id` and
   `staging_evidence_sha256` empty. Retain the accepted staging summary's exact
   run ID and evidence JSON SHA-256; the artifact is available for 30 days.
2. First staging web release: dispatch **Deploy staging** from `main` with
   `DEPLOY_STAGING`, `BOOTSTRAP_STAGING_WORKER`,
   `BOOTSTRAP_STAGING_DATABASE`, and, if the pinned users still need their
   one-time database roles, `BOOTSTRAP_STAGING_RELEASE_PRINCIPALS`.
3. Routine staging web releases: use only `DEPLOY_STAGING`.
4. After staging compiler acceptance, dispatch **Deploy compiler** for
   `production` from the same current `main` commit. Enter the accepted staging
   values as `staging_run_id` and `staging_evidence_sha256`; the workflow proves
   the exact successful staging run/artifact, same-account binding, and distinct
   state/secret/VPC fingerprints before AWS access, then promotes only an
   identical registry digest. Include `BOOTSTRAP_PRODUCTION_COMPILER_ECR`
   only when its ECR repository/state is absent or its prior bootstrap was
   interrupted. Complete the independently
   protected production Worker runtime handoff after compiler acceptance.
5. First production web release after accepted staging: dispatch **Deploy
   production** from the same commit with `DEPLOY_PRODUCTION`,
   `CUTOVER_FIRELIGHT_IE_TO_WORKER`, `BOOTSTRAP_PRODUCTION_WORKER`,
   `BOOTSTRAP_PRODUCTION_DATABASE`, and, if needed,
   `BOOTSTRAP_PRODUCTION_RELEASE_PRINCIPALS`. Also enter the exact *web staging*
   run ID and evidence JSON SHA-256 printed by the accepted **Deploy staging**
   run in step 2 or 3. Those are distinct from the compiler staging tuple used
   by **Deploy compiler** in step 4; never substitute one tuple for the other.
   The retained Pages tuple is not an operator input; review and merge a source
   change before accepting a newer fallback.
6. Routine production web releases: use `DEPLOY_PRODUCTION` and
   `CUTOVER_FIRELIGHT_IE_TO_WORKER`, plus the matching exact web staging run ID
   and evidence hash for the same commit.

For a Worker rollback, retain the exact successful staging or production web
release run ID printed by each accepted release alongside its Worker version ID
and lowercase commit SHA. Dispatch **Roll back Worker** from `main` with all
three exact values and `ROLLBACK`; the workflow fetches only that selected run
and refuses to infer one when the same commit has been released more than once.

Do not run local `wrangler deploy`, `supabase db push`, Terraform apply, Auth
PATCH, route deletion, or DNS mutation as a shortcut.
