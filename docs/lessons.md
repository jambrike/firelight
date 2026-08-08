# Lesson engine and pilot curriculum

Milestone 5 completes the instructional content layered on the Milestone 4
compiler, Web Serial transport, upload verification, serial observation, and
evidence-backed completion. All six builds now carry controlled parts and exact pin maps,
power-safe wiring prose, an accurate generated signal table, accessible connection
descriptions, editable starter source, semantic checks, knowledge and observation
gates, and troubleshooting. Physical kit signoff remains a release activity; see
`curriculum-verification.md` for the honest boundary and acceptance matrix.

## Authoring contract

Every catalog entry uses lesson schema version 1 and matches the ID, title, version,
order, and `/learn/:lesson` route declared by the shared curriculum. A lesson includes
objectives, parts, supported pin assignments, safety notes, troubleshooting, starter
code, prerequisites, and a discriminated sequence of steps.

The supported step types are narrative, wiring, code edit, code validation, quiz,
compile, connect, upload, serial check, manual observation, and completion. References
between steps must point backward to the expected step type. Every visible step needs
an accessible navigation label; wiring steps also need a useful diagram alternative.

`npm run validate:lessons` executes the catalog in Vite's server-side module runner.
It fails for duplicates, shared-schema/route drift, missing or cyclic prerequisites,
bad step references, unsupported pins, invalid quiz references, or missing accessible
labels. It also runs each starter sketch through its comment/string-aware lesson
validator and the compiler source policy. The command runs automatically before
`npm run build`.

The six controlled builds are:

- First Spark using only `LED_BUILTIN`.
- Morse Name using a bounded, safely generated pattern from supported characters
  in the signed-in learner's display name, with a deterministic fallback.
- Button Reaction using D2 to GND with `INPUT_PULLUP` and 9,600-baud timing output.
- Distance Scout using HC-SR04 trigger D9 and echo D10 at 9,600 baud.
- Servo Gate using the pinned Servo library on D6, externally regulated 5V, and
  a common signal ground without joining the external positive rail to Nano power.
  The exact Firelight-supplied servo source and connectors require signed electrical
  approval before the servo is powered.
- Trail Rover using TB6612FNG signals D3–D8/D12, HC-SR04 D9/D10, separate motor
  power, common ground, bounded speed, and fail-safe stop on a near or invalid echo.
  The exact motor pack, TT motor model, and carrier variant remain behind the signed
  procurement/electrical BOM gate in `curriculum-verification.md`; powered rover
  tests and pilot shipment are prohibited until that gate passes.

## Learner state

The map and camp derive lock state, resume destination, aggregate percentage, and
achievements from current-version bootstrap progress. Stale lesson versions never
unlock prerequisites or earn achievements. A lesson remains readable when anonymous,
unactivated, prerequisite-locked, mobile, or outside a Web Serial browser; editing,
saving, and hardware actions stay gated.

Autosave waits briefly after a change, serializes writes, queues while offline, retries
transient failures with bounded backoff, and exposes a polite or assertive status to
assistive technology. A bounded user/lesson/version-scoped browser draft survives
navigation and expires after 30 days; it is removed only after the server confirms a
save. Saves include the last database revision. On conflict, Firelight refreshes the
lesson record, preserves terminal completion, pairs the furthest checkpoint with its
percentage, keeps the latest local code edit, and retries once. A second conflict
requires an explicit learner retry. The Worker independently checks step IDs,
checkpoint-consistent percentages, lesson versions, activation, and current-version
prerequisites.

## Hardware pipeline

The shared workspace implements the `CompilerClient` and `ArduinoTransport` ports
for the exact Nano old-bootloader target. Compile, connect, upload, bounded serial
observation, and physical-observation gates share one explicit state machine. Editing
invalidates compiled/uploaded state; compilation alone cannot complete a lesson.
Unsupported browsers retain readable lesson content and receive specific mobile,
insecure-context, or missing-Web-Serial guidance. See `hardware-pipeline.md` for
trust boundaries, operational setup, evidence semantics, and unverified physical gates.

When the pinned Arduino CLI/core/Servo supply is installed, run
`npm run verify:arduino` to compile every repository starter sketch for the exact
Nano old-bootloader FQBN. This is intentionally separate from `npm run check` so
machines without the compiler image do not misrepresent static checks as a real
Arduino build.
