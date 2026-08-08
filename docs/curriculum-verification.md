# Curriculum verification and physical release gate

Milestone 5 finishes the repository-owned instructional content for all six
Firelight builds. The controlled target remains an ATmega328P Nano-compatible
board using `arduino:avr:nano:cpu=atmega328old`; uploads use STK500v1 at 57,600
baud and lesson serial checks use 9,600 baud.

## What local verification proves

`npm run validate:lessons` checks the catalog graph and every starter sketch
against its comment/string-aware semantic validator and the compiler source
policy. Unit tests additionally lock the pin maps, required lesson steps,
electrical-supply language, serial settings, Morse generation, quiz answers,
observation gates, and the browser upload-evidence completion boundary.

`npm run verify:arduino` writes each repository starter sketch to a fresh
temporary sketch directory and compiles all six with Arduino CLI for the exact
FQBN. The machine running it must first install the exact CLI, AVR core, and
Servo library versions pinned by `compiler-service/Dockerfile` and its install
scripts. This command does not upload, deploy, or contact Firelight services.

Repository-source compilation was completed on 2026-08-08 with the official,
checksum-verified Arduino CLI 1.5.1, Arduino AVR core 1.8.6, and checksum-pinned
Servo 1.3.0 library used by the compiler image. All six starter sketches compiled
successfully for the exact `arduino:avr:nano:cpu=atmega328old` FQBN. First Spark
emitted only the AVR core's upstream unused-parameter warnings; no Firelight
sketch failed or introduced another diagnostic.

This closes the repository starter-source compile gate only. The immutable
compiler image still needs to be built and scanned, and the deployed compiler,
browser upload, wiring, electrical behavior, and every physical result below
remain explicit staging acceptance gates. Do not translate the source compile
result into a claim that a board was uploaded, wired, or operated successfully.

## Unresolved controlled actuator-power BOM gate

The repository does not contain a signed procurement specification for the exact
servo supply, motor pack, TT motor model, or TB6612FNG carrier variant. Before any
powered Servo Gate or Rover test or pilot shipment, procurement and electrical
reviewers must record and sign:

- servo-supply manufacturer/model, regulated output under the intended load,
  current capability and protection, connector polarity, lead adapter, and the
  supplied SG90's matching electrical requirements;
- battery chemistry/cell count, maximum charged or fresh voltage, current
  capability/protection, connector polarity, wire gauge, and switch rating;
- motor manufacturer/model, rated voltage, and measured or datasheet stall current
  at the pack's maximum voltage; and
- carrier manufacturer/model, VM range, per-channel continuous and peak current,
  and the thermal conditions under which those ratings apply.

The review must demonstrate adequate voltage, current, connector, wiring, protection,
and thermal margin for the servo and for both motors, including stall. A matching
voltage label alone is not approval. Until that record exists, the lessons' servo
and motor-power connections, servo movement, raised-wheel run, and floor run are
unsigned and must not be performed or described as validated.

## Build acceptance matrix

| Build | Fixed connections | Required physical observation |
| --- | --- | --- |
| First Spark | Built-in LED only | Built-in LED completes at least three steady on/off cycles. |
| Morse Name | Built-in LED only | Personalized dots and dashes complete in the intended order, with visibly distinct symbol and letter gaps. |
| Button Reaction | Button from D2 to GND with `INPUT_PULLUP` | One press turns off the cue once; the 9,600-baud capture shows one non-negative reaction time. |
| Distance Scout | HC-SR04 TRIG D9, ECHO D10, 5V, GND | 9,600-baud readings move in the correct direction at two measured distances and timeouts remain bounded. |
| Servo Gate | SG90 signal D6; approved Firelight-supplied regulated 5V; supply and Nano grounds joined | After actuator-power BOM signoff, an unloaded/lightweight gate reaches both angles without buzz, stall, or Nano reset. |
| Trail Rover | TB6612FNG D3–D8/D12; HC-SR04 D9/D10; separate motor supply; all grounds common | Raised-wheel direction/stop tests pass before the rover stops before a broad obstacle three consecutive times in a clear floor area. Sensor timeout must fail stopped. |

For every breadboard or chassis change, disconnect USB and turn off external or
motor power first. Never drive a motor from a Nano pin, never join the servo or
motor positive supply to an unintended Nano rail, and establish common ground
before applying a control signal. Stop immediately on heat, smell, repeated
reset, buzzing, stalled motion, or unexpected movement.

## Browser and hardware signoff

Use a fresh activated staging learner for each supported browser/OS path:

- Current stable Chrome on macOS and Windows.
- Current stable Microsoft Edge on macOS and Windows.
- The exact pilot Nano old-bootloader board, including the intended USB-serial
  adapter/cable combination.

For each path, complete signup through Trail Rover and record: compile result,
port enumeration, ATmega328P signature verification, page write/readback,
9,600-baud serial capture where present, cable removal and reconnect behavior,
cancellation cleanup, observation confirmation, and terminal progress resume on
a second browser session. Also confirm mobile and non-Web-Serial browsers retain
readable lessons while hardware actions stay unavailable.

Completion requires the Milestone 4 upload-evidence record bound to the same
user, lesson/version, source, compile job, and artifact. That record prevents
compile-only or stale-code completion; it remains an authenticated browser
assertion, not cryptographic telemetry signed by the microcontroller.

Record tester, date, OS/browser versions, board/USB adapter identifiers, kit
batch, and any deviation for every matrix run. Promote only after every row is
signed off with no critical accessibility, electrical-safety, upload/reconnect,
or cross-user progress defect.
