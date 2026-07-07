# Firelight

Firelight is a pixel-campfire robotics learning prototype with a kit-code gate and Arduino Nano tutorial.

## Commands

```sh
npm run build
npm run deploy
```

The Cloudflare Pages project is `firelight`.

## Kit Login

The current prototype kit key is `123456`.

`functions/config.js` serves runtime config from Cloudflare Pages env vars:

- `KIT_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Until Supabase values are added, the site falls back to local unlock mode with the prototype kit key.
