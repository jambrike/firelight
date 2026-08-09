# Browser acceptance

Firelight's browser acceptance lane exercises the production React session,
routing, authorization boundary, lesson workspace, and responsive layout in the
Chromium revision pinned by the exact `@playwright/test` version and lockfile. It
does not add a production test route, role switch, authentication bypass, or
test-only application flag.

## Hermetic test boundary

The tests serve the production Vite build at `http://127.0.0.1:4173` and intercept
network traffic at the browser boundary:

- `/api/config` returns a deterministic local Supabase origin and build ID.
- Authenticated scenarios seed Supabase's normal `sb-127-auth-token` persisted
  session shape with obviously fake, far-future credentials. The recovery journey
  starts anonymous and becomes authenticated only after its PKCE token exchange.
- `/api/bootstrap` and allowed learner/admin APIs require the exact fake bearer
  token for that scenario before returning typed deterministic envelopes.
- The normal local Supabase Auth protocol is handled explicitly. Unexpected
  Auth, REST, Realtime, Storage, Functions, application API, and off-origin
  requests are aborted and fail the test.
- Supported hardware state is represented only by a context-local
  `navigator.serial` surface. Tests never open a device picker, contact a board,
  use a hosted account, or read repository secrets.

This isolation verifies browser behavior without weakening the Worker and RLS
authorization checks covered by Worker and database tests.

## Automated coverage

`e2e/accessibility-visual.spec.ts` and `e2e/high-risk-flows.spec.ts` contain
nineteen scenarios:

1. Public home at 1440 × 1000.
2. Anonymous auth entry at 390 × 844.
3. Activated learner camp with an in-progress First Spark resume action.
4. Authenticated administrator support console and its four initial API reads.
5. First Spark at its compile step with Web Serial available.
6. The same lesson with Web Serial unavailable and desktop Chrome/Edge guidance.
7. Learner denial at `/admin`, with no privileged API request.
8. Skip-link and client-route focus movement to the main landmark.
9. Keyboard operation and close-on-navigation behavior for the mobile menu.
10. Narrow lesson step selection moving focus to the newly displayed stage heading.
11. Account creation through the normal Supabase `/auth/v1/signup` protocol, including
    the exact metadata and PKCE request shape and the confirmation-required notice.
12. A signed-in, unactivated learner making the exact authenticated kit-claim request,
    refreshing bootstrap, and reaching the connected-kit state.
13. An activated owner downloading the versioned account export while permanent deletion
    stays disabled until `DELETE` is entered exactly.
14. A structured compiler error envelope reaching the enabled First Spark compile action
    and its accessible hardware error state.
15. One continuous anonymous password-recovery journey: the configured PKCE callback,
    stored verifier and SHA-256 challenge binding, authorization-code exchange, verifier
    cleanup, authenticated password update, recovery-query cleanup, and authenticated reload.
16. An aborted production `KitPage` route chunk reaching the accessible route-error alert
    while the header and footer remain available, with reload and campfire recovery controls
    and no uncaught page error.
17. Legacy completion remaining in local storage until its server checkpoint succeeds,
    while the legacy plaintext password is deleted immediately and never transmitted.
18. Confirmed account deletion calling the application API, signing out locally, removing
    the persisted session, and closing the protected route.
19. Morse Name remaining read-only with no autosave until the current First Spark
    prerequisite is complete, then enabling builder autosave after a reload.

Every key visual state runs axe against WCAG 2 A/AA, WCAG 2.1 A/AA, and WCAG
2.2 AA tags with no rule or element exclusions. The six key states also assert no
document-level horizontal overflow and compare a zero-tolerance full-page image:

- `public-home.png`
- `mobile-auth.png`
- `activated-camp.png`
- `admin-console.png`
- `first-spark-supported.png`
- `first-spark-unsupported.png`

The configuration fixes locale to `en-IE`, timezone to `Europe/Dublin`, clock to
a repository timestamp, device scale to 1, explicit viewports, dark color scheme,
reduced motion, local bundled fonts, hidden carets, and disabled animation during
capture. Service workers are blocked. One pinned Chromium worker runs at a time.

## Local commands

Install the locked browser once, then build before running acceptance:

```sh
npm ci
npx playwright install chromium
npm run typecheck:e2e
npm run build
npm run test:e2e
```

When an intentional visual change is approved:

```sh
npm run build
npm run test:e2e:update
npm run test:e2e
```

Review all six changed PNGs before accepting them. Never update snapshots merely
to clear a failure: first inspect axe output, the failure screenshot, trace, video,
and `playwright-report/`. `playwright-report/` and `test-results/` are ignored
locally and uploaded by CI for seven days only when the browser job fails.

The ordinary unit `npm test` remains browser-free. `npm run check` typechecks the
acceptance sources but does not install or execute a browser. CI has a separate,
secrets-free `browser-acceptance` job on the `macos-26` arm64 image that matches
the baseline capture platform. It installs the lockfile's Chromium, typechecks
the acceptance sources, builds, and runs Playwright. Moving this job to another
OS requires reviewed baselines captured on that exact platform; do not compare
these zero-tolerance images against a different operating system.

## Acceptance still requiring real hardware

Hermetic Chromium confirms supported/unsupported UI behavior; it is not evidence
that Web Serial, the old Nano bootloader, upload, or a physical circuit works.
Before pilot release, complete the documented physical matrix on the exact
controlled kit:

- Current stable desktop Chrome on macOS and Windows.
- Current stable desktop Microsoft Edge on macOS and Windows.
- Fresh account through all six builds on the ATmega328P Nano-compatible board
  using `arduino:avr:nano:cpu=atmega328old` at 57,600 baud.
- Compile, connect, upload, disconnect/reconnect recovery, observation, and resume
  on each required browser/OS combination.
- Separate unsupported/mobile read-only guidance checks and manual keyboard,
  zoom/reflow, screen-reader, contrast, and reduced-motion review.

Record those results in the controlled hardware acceptance evidence. Do not infer
physical approval from Playwright screenshots or browser upload attestations.
