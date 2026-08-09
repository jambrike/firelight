# Firelight platform foundation

Milestone 6 keeps the product split across six typed boundaries:

- `src/` owns Supabase browser sessions, guarded routing, accessible account and
  activation flows, and synchronized learner views. It never receives a service key.
- `worker/` owns `/api/*`, online bearer verification, request validation,
  activation HMACs, role-checked support operations, Supabase data calls, exact
  recent-session account deletion, request IDs, security headers, health/readiness,
  redacted logs, and legacy redirects. Credentials exist only as runtime bindings.
- `supabase/` owns relational invariants, atomic kit claims, RLS, grants, signup
  and deletion triggers, local configuration, and database tests.
- `shared/` owns stable curriculum IDs and browser/Worker response contracts,
  including bounded support projections that never expose code HMACs or source.
- `compiler-service/` owns the authenticated Lambda gateway plus pinned Arduino
  CLI image and private no-task-role Fargate service. Its `eu-west-1` Terraform
  provides a no-NAT VPC, internal ALB, endpoint-only egress, and exact IAM/SG rules.
- `wrangler.jsonc` binds the compiled Vite output through Workers Static Assets.
  SPA fallback is handled by the asset runtime and hashed assets bypass the Worker.

The browser uses Supabase directly only for auth session lifecycle. Learner data
flows through the Worker, and the learner JWT is forwarded to PostgREST so RLS
remains authoritative. The Worker uses the service role only for service-only
claim/hardware RPCs and Auth Admin deletion. Kit plaintext is normalized and
HMACed before it reaches PostgreSQL; stored hashes are not redeemable through a
browser RPC.

`GET /api/account/export` is a dedicated learner-JWT path with a versioned shared
schema. It reads strict owner-marked projections through PostgREST/RLS, verifies
every returned owner ID, and includes every stored progress version, compile-job
record, and browser-upload attestation within explicit bounds. Activation uses a
separate owner-only RLS policy with column grants limited to ID, batch, kind, and
claim time. Large owner datasets are read sequentially with field-specific page
sizes, and every validated row is charged to one UTF-8 JSON budget before it is
retained. The export excludes kit plaintext/HMACs, service credentials, raw source,
and HEX artifacts. If any category exceeds its maximum or the response would exceed
4 MiB, the Worker fails the whole request instead of truncating it.

Admin requests pass two authorization gates: the Worker reads the caller's own
profile role through their JWT, then a service-only database RPC rechecks the
actor's current admin role before returning a bounded projection or changing kit
state. Batch plaintext exists only in the one generation response, paired with
the database UUID needed to revoke that exact code; PostgreSQL receives only the
UUID and peppered HMAC. Revocation and compile creation share a per-user
transaction lock, so access cannot be revoked concurrently with a newly admitted
compile job.

Hosted configuration fails closed unless the Supabase URL matches the separately
bound project reference, the compiler URL matches its separately bound origin and
`eu-west-1` Function URL hostname, and `BUILD_ID` is a full lowercase commit SHA.
After service-token authentication and valid identity loading, the gateway
reports environment, canonical service, protocol version, build, and digest
identity on every response. The Worker requires its exact environment, canonical
service, and protocol version, and validates canonical nonzero build/digest
shapes without coupling them to the web release before accepting either success
or error semantics. It rejects a missing identity.
Unauthenticated responses disclose no release identity.
Every credentialed Supabase request also rejects redirects so bearer, publishable,
and service-role credentials cannot be forwarded to a second origin. The browser
removes the obsolete local plaintext-password key before starting configuration or
authentication work; later legacy synchronization repeats that best-effort purge.
Cloudflare automatic invocation logs and traces are disabled; the Worker emits a
small redacted completion event. Release workflows use a dedicated activated
canary account to prove config, authentication, bootstrap, and compilation after
deployments and rollbacks.

Compilation and Web Serial uploading use typed boundaries end to end. The Worker
authenticates, validates, rate-gates, hashes, and records compile jobs before
returning a strictly checked artifact. The browser independently binds that
artifact to the current source, verifies ATmega328P bootloader identity, writes
and reads back flash, and records browser upload evidence before terminal progress.
Neither raw source nor HEX is persisted in compile-job records.

The lesson catalog is repository-owned, versioned TypeScript. Its runtime assertion
also runs through `npm run validate:lessons` before every production build. The
workspace treats lesson instructions as public preview content, but only an online
session with activated kit access and satisfied prerequisites can edit or save.

Progress writes use a monotonic database `revision`. A new checkpoint sends
`expectedRevision: null`; later writes send the last observed positive revision.
The Worker performs a conditional PostgREST update and returns
`PROGRESS_REVISION_CONFLICT` rather than overwriting a newer device. If a response
is lost after commit, only the exact checkpoint at `expectedRevision + 1` is
recognized as an idempotent replay; a different checkpoint still conflicts. The
browser refreshes bootstrap data, merges only forward-moving state, and retries
once.
The same endpoint rejects unknown lesson steps, checkpoint-inconsistent percentages,
and progress for lessons whose current-version prerequisites are incomplete.

The revision migration accepts both revision-aware writes and the preceding
Worker's omitted revision during cutover; omitted values advance in the trigger.
Explicit stale revisions still fail. This compatibility branch keeps progress
writable while the Worker rolls forward and can be tightened in a later migration
after every environment is revision-aware.

## Local commands

- `npm run dev` starts the Vite UI server.
- `npm run validate:lessons` evaluates and validates the complete catalog.
- `npm run dev:worker` builds the UI and starts the complete local Worker.
- `npm run db:start`, `db:reset`, `db:test`, and `db:lint` manage the local
  Supabase stack; they require Docker.
- `npm run check` runs generated-binding checks, types, lint, tests, and build.
- Every production build enforces raw/gzip limits on the initial browser module
  graph and verifies that the lesson workspace and admin console remain deferred chunks.
- `npm run deploy:dry-run` validates the Worker bundle without deploying it.
- `python3 -m unittest discover -s compiler-service/tests -p 'test_*.py'`
  verifies compiler-service bounds, protocol, redaction, and supply-chain pins.

Staging and production release workflows are manual-only and accept only the
current commit on `main`. Production deliberately overlays the retained legacy
Pages hostname with a `firelight.ie/*` Worker route so the Pages deployment and
DNS record remain available during the rollback window. No deployment command is
run automatically outside an explicitly confirmed, approved release workflow.
See `docs/hardware-pipeline.md` and `docs/compiler-service.md` before promoting
the hardware path or interpreting browser upload evidence.
