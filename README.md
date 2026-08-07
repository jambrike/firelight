# Firelight

Firelight is a pixel-campfire robotics learning platform for a controlled Arduino
Nano starter kit. The current foundation is a React 19 + TypeScript + Vite single
page application backed by a Hono Cloudflare Worker and Workers Static Assets.

## Milestone 3 status

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
  flags; the old plaintext password is deleted locally and never read or uploaded.
- Local Supabase config, a documented demo-code seed, branded email templates,
  pgTAP security tests, and browser/Worker tests.
- A reusable, responsive, keyboard-friendly pixel design system with bundled
  fonts and reduced-motion support.
- A reusable lesson workspace with step navigation, accessible code editing,
  validation, quizzes, parts, pins, safety guidance, troubleshooting, and
  honest deferred compile/connect/upload states.
- Six versioned structured lesson shells targeting
  `arduino:avr:nano:cpu=atmega328old` at 57,600 baud, with fixed pin maps and
  every narrative, wiring, code, knowledge, hardware, observation, and
  completion step type represented.
- Runtime and build-time catalog validation for shared route/schema drift,
  duplicate IDs, prerequisite cycles, bad step references, unsupported pins,
  and missing accessible labels.
- Current-version prerequisite locking, accurate map/dashboard derivations,
  exact step/code resume, and public read-only lesson previews.
- Debounced autosave with offline recovery, bounded transient retries,
  durable user-scoped drafts, monotonic merging, optimistic revisions, and one
  cross-device conflict retry.
- Server-side checkpoint, percentage, version, activation, and prerequisite
  enforcement for every progress write.
- A Hono Worker with generated binding types, request IDs, structured errors,
  security headers, runtime config, SPA assets, and legacy URL redirects.
- Strict TypeScript, type-aware ESLint, browser unit tests, Workers-runtime tests,
  a production build, and a pull-request CI gate.

Intentionally deferred to later milestones: the real Arduino compiler,
Web Serial/STK500 uploading, final curriculum content and physical validation,
admin mutations and kit batch tooling, and deployment automation. Hardware
buttons stay disabled and `/api/compile` remains an authenticated, activated
`COMPILER_NOT_READY` boundary until the hardware pipeline milestone.

## Commands

```sh
npm install
npm run dev            # Vite UI development
npm run dev:worker     # Full local Worker after a UI build
npm run validate:lessons # Execute catalog/schema validation
npm run db:start       # Start the local Supabase stack (Docker required)
npm run db:reset       # Apply migrations and the local-only seed
npm run db:test        # Run pgTAP RLS/migration tests
npm run db:lint        # Run Supabase database linting
npm run check          # binding types, TypeScript, lint, tests, and build
npm run deploy:dry-run # validate the Cloudflare bundle without deploying
```

Before `npm run dev:worker`, copy `.dev.vars.example` to `.dev.vars`, run
`supabase status -o env`, and fill in the local publishable and service-role
keys. The local kit code is `ABCD-EFGH-JKMP-NRST`. Its seed hash matches the
example-only pepper in `.dev.vars.example`; neither value is for hosted use.

`wrangler.jsonc` is the source of truth for binding names and non-secret runtime
configuration. Run `npm run cf-typegen` after changing bindings. Put hosted
Supabase credentials and a distinct high-entropy `KIT_CODE_PEPPER` in encrypted
Worker secrets; never commit them or add them to `vars`.

## Repository map

- `src/` — React application, design system, session provider, and learner UI.
- `worker/` — authenticated Hono API, Supabase repository, and legacy redirects.
- `supabase/` — local config, email templates, migrations, seed, and pgTAP tests.
- `shared/` — curriculum and API types used at the browser/Worker boundary.
- `scripts/validate-lessons.mjs` — build gate for typed curriculum content.
- `public/_headers` — security and immutable asset caching policy.
- `prototype-archive/` — exact checkpoint reference from commit `98ff7fc`.
- `docs/architecture.md` — milestone boundaries and local workflow.

See `docs/identity.md` and `docs/lessons.md` before applying these migrations to staging. No deploy,
remote database mutation, or domain migration is performed by repository scripts.
