# Firelight platform foundation

Milestone 2 keeps the product split across four typed boundaries:

- `src/` owns Supabase browser sessions, guarded routing, accessible account and
  activation flows, and synchronized learner views. It never receives a service key.
- `worker/` owns `/api/*`, online bearer verification, request validation,
  activation HMACs, Supabase data calls, account deletion, request IDs, security
  headers, and legacy redirects. Credentials exist only as runtime bindings.
- `supabase/` owns relational invariants, atomic kit claims, RLS, grants, signup
  and deletion triggers, local configuration, and database tests.
- `shared/` owns stable curriculum IDs and browser/Worker response contracts.
- `wrangler.jsonc` binds the compiled Vite output through Workers Static Assets.
  SPA fallback is handled by the asset runtime and hashed assets bypass the Worker.

The browser uses Supabase directly only for auth session lifecycle. Learner data
flows through the Worker, and the learner JWT is forwarded to PostgREST so RLS
remains authoritative. The service role is restricted to the service-only claim
function and Auth Admin deletion. Kit plaintext is normalized and HMACed before
it reaches PostgreSQL; stored hashes are not redeemable through a browser RPC.

Compilation and Web Serial uploading remain typed boundaries. Later milestones
must implement those contracts without reintroducing browser-stored passwords,
raw source logging, or false hardware state.

## Local commands

- `npm run dev` starts the Vite UI server.
- `npm run dev:worker` builds the UI and starts the complete local Worker.
- `npm run db:start`, `db:reset`, `db:test`, and `db:lint` manage the local
  Supabase stack; they require Docker.
- `npm run check` runs generated-binding checks, types, lint, tests, and build.
- `npm run deploy:dry-run` validates the Worker bundle without deploying it.

No deployment command is run automatically outside an approved release workflow.
