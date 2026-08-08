# Firelight

Firelight is a pixel-campfire robotics learning platform for a controlled Arduino
Nano starter kit. The current foundation is a React 19 + TypeScript + Vite single
page application backed by a Hono Cloudflare Worker and Workers Static Assets.

## Milestone 6 status

Implemented:

- Supabase email/password signup, confirmation callbacks, login, logout,
  password recovery, and guarded learner/admin routes.
- Cross-device profiles, one-time kit activation, revision-safe progress,
  achievements, resume state, account export, and deletion boundaries.
- Versioned PostgreSQL migrations for profiles, kit inventory, progress,
  compile-job metadata, and admin audit history, with RLS and narrow grants.
- Worker-authenticated APIs for bootstrap, profile updates, HMAC kit claims,
  lesson progress, and account deletion.
- Owner-matched migration of only the legacy builder name and two completion
  flags; legacy booleans resume at compile rather than fabricating upload proof,
  and the old plaintext password is deleted locally without being read or uploaded.
- Local Supabase config, a documented demo-code seed, branded email templates,
  pgTAP security tests, and browser/Worker tests.
- A reusable, responsive, keyboard-friendly pixel design system with bundled
  fonts and reduced-motion support.
- A reusable lesson workspace with step navigation, accessible code editing,
  validation, quizzes, parts, pins, safety guidance, troubleshooting, authenticated
  compilation, Web Serial connection, verified upload, serial observation, and
  evidence-backed completion.
- Six complete, versioned pilot lessons targeting
  `arduino:avr:nano:cpu=atmega328old` at 57,600 baud: First Spark, personalized
  Morse Name, Button Reaction on D2, Distance Scout on D9/D10, Servo Gate on D6,
  and the TB6612FNG/HC-SR04 Trail Rover on D3–D10/D12. Each includes controlled
  parts, wiring and power guidance, editable source, knowledge checks, hardware
  and observation gates, troubleshooting, and an evidence-backed checkpoint.
- Runtime and build-time catalog validation for shared route/schema drift,
  duplicate IDs, prerequisite cycles, bad step references, unsupported pins,
  missing accessible labels, compiler-policy drift, and semantically invalid
  starter sketches. Lesson validators ignore comments and literals and reject
  task-specific near misses.
- Current-version prerequisite locking, accurate map/dashboard derivations,
  exact step/code resume, and public read-only lesson previews.
- Debounced autosave with offline recovery, bounded transient retries,
  durable user-scoped drafts, monotonic merging, optimistic revisions, and one
  cross-device conflict retry.
- Server-side checkpoint, percentage, version, activation, and prerequisite
  enforcement for every progress write.
- A Hono Worker with generated binding types, request IDs, structured errors,
  security headers, runtime config, SPA assets, and legacy URL redirects.
- An authenticated `/api/compile` proxy with activation/prerequisite checks, exact
  FQBN and 64 KiB bounds, one active job per learner, 20/hour and 100/day rolling
  limits, a 45-second end-to-end deadline, strict artifact integrity checks, and
  no browser-visible compiler credentials.
- An authenticated Lambda gateway and private no-task-role Fargate compiler in a
  no-NAT `eu-west-1` VPC, with pinned Arduino CLI/Servo dependencies, bounded
  subprocesses, sanitized diagnostics, immutable images, and narrow IAM/SG rules.
- A production-shaped Web Serial/STK500v1 transport with browser capability
  guidance, ATmega328P signature verification, cancellation/disconnect cleanup,
  128-byte page writes, full readback, bounded 9,600-baud serial observation,
  and stale-operation protection.
- PostgreSQL compile lifecycle and browser upload-evidence invariants. Terminal
  progress binds the exact user, lesson/version, source, and artifact and cannot
  be transplanted after completion.
- Strict TypeScript, type-aware ESLint, browser unit tests, Workers-runtime tests,
  a production build, and a pull-request CI gate.
- A role-checked support/admin console with service-only database RPCs for bounded
  learner/progress lookup, sanitized compile diagnostics, and audit history.
- Cryptographically random one-time kit-batch generation with plaintext displayed
  or exported once beside its stable revocation ID, HMAC-only storage, and audited
  idempotent revocation that immediately removes code-derived access and fails
  active compile jobs.
- A complete account area for profile and activation details, a schema-versioned
  server export of every bounded owner record (all progress versions, compile
  metadata, and browser-upload evidence), and irreversible hard deletion guarded
  by an exact Supabase session created within 15 minutes rather than token refresh
  or global sign-in time.
- Separate Wrangler staging/production Workers, explicit runtime secret
  inventories, independently pinned Supabase/compiler targets, redacted custom
  request logs, health/readiness endpoints, and generated environment bindings.
- PR-only CI plus environment-gated staging-on-main and production tag/manual
  workflows, protected project and migration-state proofs, migration-first
  deployment, exact-commit staging evidence, signed-in compile canaries,
  immutable accepted-release artifacts, and exact-content verified Worker
  rollback. No
  release workflow is triggered by local checks.
- An operations/release runbook covering secrets and pepper rotation, migrations,
  immutable compiler rollout, monitoring, revocation, deletion, backup/restore,
  incidents, audit retention, and outstanding external acceptance gates.

All six repository starter sketches compile for the exact Nano old-bootloader
target with the pinned Arduino CLI 1.5.1, AVR core 1.8.6, and Servo 1.3.0
toolchain. Still gated outside this repository: hosted account/project/secret creation,
environment approvals, DNS cutover, SMTP, monitoring, backup/PITR restore drills,
AWS Terraform apply and compiler-image build/scan, physical
validation of all six builds across the documented browser/OS/kit matrix, and
procurement/electrical signoff of the exact servo supply, rover motor pack, TT
motors, and TB6612FNG carrier. The servo and rover must not be powered until that
controlled BOM is signed. Browser upload evidence is an honest authenticated
browser assertion, not cryptographic telemetry signed by the board; see
`docs/operations-runbook.md`, `docs/hardware-pipeline.md`, and
`docs/curriculum-verification.md` before pilot rollout.

## Commands

```sh
npm install
npm run dev            # Vite UI development
npm run dev:worker     # Full local Worker after a UI build
npm run validate:lessons # Execute catalog/schema validation
npm run verify:arduino  # Compile all lesson sketches when pinned arduino-cli is installed
npm run db:start       # Start the local Supabase stack (Docker required)
npm run db:reset       # Apply migrations and the local-only seed
npm run db:test        # Run pgTAP RLS/migration tests
npm run db:lint        # Run Supabase database linting
npm run test:operations # Verify release secret-inventory tooling
npm run check          # binding types, TypeScript, lint, tests, and build
npm run deploy:dry-run # validate the Cloudflare bundle without deploying
npx wrangler deploy --env staging --dry-run
npx wrangler deploy --env production --dry-run
python3 -m unittest discover -s compiler-service/tests -p 'test_*.py'
```

Before `npm run dev:worker`, copy `.dev.vars.example` to `.dev.vars`, run
`supabase status -o env`, and fill in the local publishable and service-role
keys and add the loopback compiler URL/origin/token. The local kit code is
`ABCD-EFGH-JKMP-NRST`. Its seed hash matches the example-only pepper in
`.dev.vars.example`; none of those example values are for hosted use.

`wrangler.jsonc` is the source of truth for binding names and non-secret runtime
configuration. Run `npm run cf-typegen` after changing bindings. Put hosted
Supabase credentials and a distinct high-entropy `KIT_CODE_PEPPER` in encrypted
Worker secrets; never commit them or add them to `vars`.

## Repository map

- `src/` — React application, design system, session provider, and learner UI.
- `worker/` — authenticated Hono API, Supabase repository, and legacy redirects.
- `compiler-service/` — authenticated gateway, isolated Fargate compiler image,
  tests, and Terraform.
- `supabase/` — local config, email templates, migrations, seed, and pgTAP tests.
- `shared/` — curriculum and API types used at the browser/Worker boundary.
- `scripts/validate-lessons.mjs` — build gate for typed curriculum content.
- `public/_headers` — security and immutable asset caching policy.
- `prototype-archive/` — exact checkpoint reference from commit `98ff7fc`.
- `docs/architecture.md` — milestone boundaries and local workflow.
- `docs/hardware-pipeline.md` — compile/upload trust model, operations, and gates.
- `docs/curriculum-verification.md` — deterministic checks, unresolved actuator-power
  BOM gate, and physical acceptance matrix.
- `docs/operations-runbook.md` — environment isolation, secrets, releases,
  monitoring, recovery, data operations, and external rollout gates.

See `docs/identity.md`, `docs/lessons.md`, `docs/hardware-pipeline.md`, and
`docs/compiler-service.md`, then follow `docs/operations-runbook.md` before
applying migrations to staging. Local verification performs no deploy, remote
database mutation, AWS change, secret rotation, or domain migration.
