# Firelight platform foundation

Milestone 4 keeps the product split across five typed boundaries:

- `src/` owns Supabase browser sessions, guarded routing, accessible account and
  activation flows, and synchronized learner views. It never receives a service key.
- `worker/` owns `/api/*`, online bearer verification, request validation,
  activation HMACs, Supabase data calls, account deletion, request IDs, security
  headers, and legacy redirects. Credentials exist only as runtime bindings.
- `supabase/` owns relational invariants, atomic kit claims, RLS, grants, signup
  and deletion triggers, local configuration, and database tests.
- `shared/` owns stable curriculum IDs and browser/Worker response contracts.
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
- `npm run deploy:dry-run` validates the Worker bundle without deploying it.
- `python3 -m unittest discover -s compiler-service/tests -p 'test_*.py'`
  verifies compiler-service bounds, protocol, redaction, and supply-chain pins.

No deployment command is run automatically outside an approved release workflow.
See `docs/hardware-pipeline.md` and `docs/compiler-service.md` before promoting
the hardware path or interpreting browser upload evidence.
