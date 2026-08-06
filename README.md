# Firelight

Firelight is a pixel-campfire robotics learning prototype with email/password auth and Arduino Nano tutorials.

## Commands

```sh
npm run build
npm run deploy
```

The Cloudflare Pages project is `firelight`.
The Supabase project is `firelight` in `eu-west-1`.

## Login

The signup screen uses email/password auth. Supabase email confirmations are disabled in `supabase/config.toml` so signup does not depend on confirmation emails for the demo flow.

`functions/config.js` serves runtime config from Cloudflare Pages env vars:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The production Cloudflare Pages project has these values configured as secrets. If they are missing in another environment, the site falls back to local prototype login in the browser.
