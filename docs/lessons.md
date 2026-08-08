# Lesson engine and curriculum authoring

Milestone 4 connects the executable lesson UI to the authenticated compiler,
Web Serial transport, upload verification, serial observation, and evidence-backed
completion. All six builds remain structured shells; Milestone 5 owns final
instructional copy, diagrams, validator depth, and physical signoff.

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
labels. The command runs automatically before `npm run build`.

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
