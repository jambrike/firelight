# Identity and data operations

## Local setup

1. Start Docker, then run `npm run db:start` and `npm run db:reset`.
2. Run `supabase status -o env`.
3. Copy `.dev.vars.example` to ignored `.dev.vars` and replace the local key
   placeholders. Keep the example local pepper unchanged if using the seed.
4. Run `npm run dev:worker` and open the Wrangler URL, normally
   `http://127.0.0.1:8787`.
5. Create an account. Local confirmation is disabled; hosted environments must
   enable it. Activate with `ABCD-EFGH-JKMP-NRST`.

`npm run db:test` exercises table RLS, column grants, signup profiles, activation,
claim idempotency, admin audit visibility, and deletion cascades. `npm run db:lint`
runs the Supabase database linter. Both require the local stack.

## Hosted environment checklist

- Use separate Supabase projects for staging and production in `eu-west-1`.
- Review and apply migrations through the release pipeline; never run them from
  an unreviewed local shell against production.
- Set hosted `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, and a unique high-entropy `KIT_CODE_PEPPER` with
  encrypted Worker secrets. The service key and pepper must never enter a Vite
  variable, response, log, or source file.
- `SUPABASE_URL` must be the root HTTPS origin of a 20-character
  `*.supabase.co` project with no credentials, port, path, query, or fragment.
  Hosted requests also bind that exact origin to the authenticated JWT `iss`
  claim before sending either learner or service credentials. Only the explicit
  loopback HTTP origin is accepted while `ENVIRONMENT=development`.
- Set Supabase Auth site/redirect URLs to the exact staging or production hosts,
  enable email confirmations, configure production SMTP, and install the branded
  confirmation/recovery templates.
- Generate production kit codes with 80 CSPRNG bits encoded as exactly 16
  Crockford Base32 characters. Show/export plaintext once; store only versioned
  HMAC-SHA-256 values produced with the environment pepper.
- Run the pgTAP suite and HTTP smoke tests after migration, then verify two real
  accounts cannot read or mutate each other's rows.

## Deletion and legacy behavior

Code activation is authoritative only while a matching `kit_codes` row remains
`claimed`, belongs to that learner, and has no revocation timestamp. The database
rechecks this invariant when compilation begins and finishes, when upload evidence
is recorded, and on every progress insert/update. Revoking, reassigning, or
deleting the final active claim atomically clears the profile's code-derived
access. A revocation that wins a race with an in-flight compile fails that job as
`ACCESS_REVOKED`; the Worker returns no artifact. Grandfathered pilot access is
the only profile-only entitlement.

`DELETE /api/account` verifies the session online and requires a sign-in within
15 minutes. The Worker calls the Supabase Auth Admin API. Deleting `auth.users`
cascades the profile, progress, and compile records; a database trigger revokes
and de-identifies any claimed kit while keeping it consumed. Audit records retain
no email or request body.

After the first successful authenticated bootstrap, Firelight deletes the old
local plaintext-password key without reading it. Once an activated account has
successfully synchronized, it compares the legacy email locally with the signed-in
email, then may migrate only `firelight-student-name`,
`firelight-first-tutorial-complete`, and
`firelight-second-tutorial-complete`. A failed sync leaves those keys for an
idempotent retry; an ownership mismatch leaves them untouched. The legacy email
is never uploaded, and the email/unlock flags are removed only after a successful
owner-matched migration. A legacy completion boolean resumes at the compile
checkpoint; it never fabricates current-version compile/upload evidence or unlocks
a prerequisite. A pending Morse flag remains local until evidence-backed First
Spark completion makes that lesson eligible. Legacy values never grant identity
or kit access.
