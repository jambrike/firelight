# Firelight

Firelight is a pixel-campfire robotics learning platform for a controlled Arduino
Nano starter kit. The current foundation is a React 19 + TypeScript + Vite single
page application backed by a Hono Cloudflare Worker and Workers Static Assets.

## Milestone 5 status

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

Intentionally deferred to later milestones: physical validation of all six builds
across the documented browser/OS/kit acceptance matrix, procurement/electrical
signoff of the exact servo supply, rover motor pack, TT motors, and TB6612FNG
carrier, admin mutations and kit-batch tooling, and deployment automation. The
servo and rover must not be powered until that controlled BOM is signed. Browser
upload evidence is an honest authenticated browser assertion, not cryptographic
telemetry signed by the board;
see `docs/hardware-pipeline.md` and `docs/curriculum-verification.md` before pilot
rollout.

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
npm run check          # binding types, TypeScript, lint, tests, and build
npm run deploy:dry-run # validate the Cloudflare bundle without deploying
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

See `docs/identity.md`, `docs/lessons.md`, `docs/hardware-pipeline.md`, and
`docs/compiler-service.md` before applying these migrations to staging. No deploy,
remote database mutation, or domain migration is performed by repository scripts.
