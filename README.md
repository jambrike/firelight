# Firelight

Firelight is a pixel-campfire robotics learning platform for a controlled Arduino
Nano starter kit. The current foundation is a React 19 + TypeScript + Vite single
page application backed by a Hono Cloudflare Worker and Workers Static Assets.

## Milestone 1 status

Implemented:

- Product routes for home, kit, auth, activation, camp, curriculum, lesson,
  account, and pilot admin previews.
- A reusable, responsive, keyboard-friendly pixel design system with bundled
  fonts and reduced-motion support.
- Typed boundaries for versioned lesson definitions and the future Arduino
  compile/connect/upload transport.
- Six fixed curriculum previews targeting
  `arduino:avr:nano:cpu=atmega328old` at 57,600 baud.
- A Hono Worker with generated binding types, request IDs, structured errors,
  security headers, runtime config, SPA assets, and legacy URL redirects.
- Strict TypeScript, type-aware ESLint, browser unit tests, Workers-runtime tests,
  a production build, and a pull-request CI gate.

Intentionally deferred to later milestones: Supabase authentication and schema,
kit-code claiming, synchronized progress, the executable lesson engine, remote
compilation, Web Serial/STK500 uploading, admin data, and deployment automation.

## Commands

```sh
npm install
npm run dev            # Vite UI development
npm run dev:worker     # Full local Worker after a UI build
npm run check          # binding types, TypeScript, lint, tests, and build
npm run deploy:dry-run # validate the Cloudflare bundle without deploying
```

`wrangler.jsonc` is the source of truth for non-secret runtime configuration.
Run `npm run cf-typegen` after changing bindings. Put local secrets in ignored
`.dev.vars`; never commit them or add them to `vars`.

## Repository map

- `src/` — React application, design system, previews, and typed feature contracts.
- `worker/` — Hono API shell and canonical legacy redirects.
- `public/_headers` — security and immutable asset caching policy.
- `prototype-archive/` — exact checkpoint reference from commit `98ff7fc`.
- `docs/architecture.md` — milestone boundaries and local workflow.

No deploy or domain migration is part of this milestone.
