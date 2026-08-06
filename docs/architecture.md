# Firelight platform foundation

Milestone 1 separates the product into three typed boundaries:

- `src/` is the React learner/admin shell. It owns routing, accessible visual
  components, preview curriculum metadata, and feature placeholders.
- `worker/` is a Hono Cloudflare Worker. It owns `/api/*`, request IDs, structured
  errors, security headers, and legacy redirects. It does not contain credentials.
- `wrangler.jsonc` binds the compiled Vite output through Workers Static Assets.
  SPA fallback is handled by the asset runtime and hashed assets bypass the Worker.

Authentication, database access, compilation, and Web Serial uploading are
deliberately represented only by contracts in this milestone. Later milestones
must implement those contracts without reintroducing browser-stored passwords or
false hardware state.

## Local commands

- `npm run dev` starts the Vite UI server.
- `npm run dev:worker` builds the UI and starts the complete local Worker.
- `npm run check` runs generated-binding checks, types, lint, tests, and build.
- `npm run deploy:dry-run` validates the Worker bundle without deploying it.

No deployment command is run automatically outside an approved release workflow.
