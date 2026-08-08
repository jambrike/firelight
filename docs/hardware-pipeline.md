# Hardware compilation and upload operations

Milestone 4 implements one deliberately narrow path: a current desktop Chrome
or Microsoft Edge browser compiles and uploads a repository-defined lesson
sketch to an ATmega328P Nano-compatible board using the old bootloader profile.
The fixed target is `arduino:avr:nano:cpu=atmega328old`; STK500v1 uses 57,600
baud. Other boards, mobile browsers, arbitrary FQBNs, and custom hardware are
not supported.

## Trust boundaries and request flow

1. The authenticated browser sends the lesson ID/version, exact FQBN, and at
   most 64 KiB of source to `POST /api/compile`. It never receives the gateway
   URL, service token, Supabase service role, or kit-code pepper.
2. The Cloudflare Worker verifies the Supabase session online, rejects anonymous
   or unconfirmed accounts, checks activation and current prerequisites, runs
   the repository validator, hashes the source, and asks PostgreSQL to atomically
   open a compile job.
3. PostgreSQL permits only one active job per user and applies rolling limits of
   20 attempts per hour and 100 per 24 hours. A 90-second lease fails abandoned
   active jobs so a terminated Worker cannot lock a learner out indefinitely.
4. The Worker calls the HTTPS Lambda gateway with a server-only credential and
   a 45-second end-to-end deadline. The gateway authenticates and forwards to an
   internal ALB; only private no-task-role Fargate containers run Arduino CLI.
   Those containers have no application secret, usable AWS credentials, public
   IP, NAT route, or general egress. The Worker bounds the response, checks the
   exact
   target and source hash, strictly parses the Intel HEX below the 30,720-byte
   bootloader boundary, recomputes the artifact hash, sanitizes diagnostics, and
   records a terminal compile-job state before returning anything to the browser.
5. The browser independently binds the source hash to the current editor text,
   validates the artifact hash and strict Intel HEX, opens Web Serial, resets and
   synchronizes the bootloader, verifies the ATmega328P signature, writes
   128-byte pages, and reads every page back before reporting upload success.
   Lessons that require serial observation then reopen the retained port at the
   lesson-controlled 9,600 baud, capture at most 10 seconds/8 KiB by default,
   and require the learner to confirm the displayed observation.
6. Only after upload verification does the browser register upload evidence.
   A terminal progress save must reference that same user's succeeded compile
   job, lesson/version, source hash, artifact hash, and exact code snapshot.

Compile-job records contain the source SHA-256, bounded sanitized diagnostics,
and artifact SHA-256. They never contain the raw sketch. The HEX is returned
synchronously and is not persisted by the Worker or PostgreSQL.

## What upload evidence means

`browser-web-serial-v1` is an authenticated browser assertion. It is strong
enough to stop accidental completion after compile-only or after uploading stale
code, and database triggers prevent moving evidence to another user, lesson,
version, or source. It is not a cryptographic statement signed by the physical
microcontroller: a learner who deliberately scripts the authenticated evidence
endpoint can forge the browser assertion after a valid compile. Support and
admin tooling must not describe it as tamper-proof device telemetry.

Closing or physically unplugging the board after recorded success does not erase
the evidence. Editing code immediately invalidates the artifact and evidence.
Terminal progress content is immutable; grandfathered pre-migration completions
without evidence remain readable but cannot be repurposed.

## Configuration and deployment order

The Worker requires these encrypted secrets in addition to the identity values:

- `COMPILER_SERVICE_URL`: the HTTPS Lambda Function URL. Treat the URL as
  sensitive even though the token is the authorization boundary.
- `COMPILER_SERVICE_ORIGIN`: the independently configured exact scheme/host
  origin of that same eu-west-1 Function URL, with no path or trailing slash.
- `COMPILER_SERVICE_TOKEN`: 32–512 characters of high-entropy secret material,
  identical to the value stored in the compiler service's Secrets Manager secret.

See `docs/compiler-service.md` for image, Terraform, IAM, rotation, and recovery
details. Deploy in this order:

1. Build and scan the pinned compiler image, smoke-compile the exact target, push
   by immutable digest, apply reviewed Terraform in `eu-west-1`, and run authorized
   and unauthorized Function URL probes.
2. Apply the Supabase hardware migration and run pgTAP against the target staging
   project.
3. Set the three Worker compiler bindings, deploy the Worker/UI to staging, and run
   fresh-account browser and physical-board acceptance.
4. Promote only after staging evidence, compile-rate, disconnect, and rollback
   checks pass. Keep the prior Worker and static prototype release available.

Never expose the gateway URL/origin/token through `/api/config`, Vite variables, browser
logs, Terraform non-sensitive outputs, or diagnostic messages.

## Failure and recovery behavior

- Code edits abort any active operation and discard stale artifacts/evidence.
- Compiler, response-body, serial, and bootloader operations have bounded timeouts.
- Cancellation and physical disconnect release reader/writer locks before closing
  the port. A failed close retains a cleanup handle so disconnect can be retried.
- A stale compiler or evidence response cannot mutate a replacement operation.
- Compile errors return stable safe codes and bounded learner-facing diagnostics;
  raw request bodies, source, bearer tokens, and service credentials are never logged.
- `COMPILE_ALREADY_RUNNING` clears automatically after the 90-second database
  lease. Repeated `COMPILE_STATE_UNAVAILABLE` requires checking Supabase health
  before retrying the compiler itself.
- Rotate the compiler token by updating Secrets Manager and the Worker secret in
  a coordinated maintenance window, then verify both rejected-old and accepted-new
  probes without printing either token.

## Verification gates

Automated gates cover lesson validation, TypeScript, lint, browser state-machine
tests, strict Intel HEX parsing, STK500 fragmentation/timeouts/cancellation/readback,
Worker authorization and response bounds, Python compiler limits/sanitization,
Terraform validation, and migration/pgTAP definitions. CI also builds the pinned
compiler container without deploying it.

Release still requires gates that this implementation environment cannot perform:

- Run migrations, RLS/pgTAP, and database lint against a disposable Supabase stack.
- Build and smoke-run the Lambda image, scan it, and validate AWS IAM/Function URL
  behavior without applying to production first.
- Complete all six builds with the exact kit on current Chrome and Edge on macOS
  and Windows, including CH340/clone enumeration, ATmega328P signature rejection,
  serial observation at the lesson baud, cancellation, cable removal, reconnect,
  and fresh-account terminal progress.

No deployment, AWS mutation, remote database migration, or physical acceptance is
performed by the repository's local verification commands.
