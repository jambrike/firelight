# Firelight

Firelight is a pixel-campfire robotics learning prototype with a kit-code gate and Arduino Nano tutorial.

## Commands

```sh
npm run build
npm run deploy
```

The Cloudflare Pages project is `firelight`.
The Supabase project is `firelight` in `eu-west-1`.

## Kit Login

The current prototype kit key is `123456`.

`functions/config.js` serves runtime config from Cloudflare Pages env vars:

- `KIT_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The production Cloudflare Pages project has these values configured as secrets. If they are missing in another environment, the site falls back to local unlock mode with the prototype kit key.
