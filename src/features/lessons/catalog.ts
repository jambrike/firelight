import { lessonSlugs } from "../../../shared/curriculum";
import type { LessonSlug } from "../../../shared/curriculum";
import { LESSON_SCHEMA_VERSION } from "./contracts";
import type {
  LessonDefinition,
  LessonPinAssignment,
  LessonStep,
  QuizChoice,
} from "./contracts";
import { createMorseNameStarterCode } from "./morse";
import { assertValidLessonCatalog } from "./validation";

export { lessonSlugs };
export type { LessonSlug };

export type LessonMigrationStage = "prototype-ready" | "planned";

/**
 * The compatibility fields at the end of this interface are still consumed by
 * the foundation route cards. New lesson-engine code should prefer the fields
 * inherited from LessonDefinition.
 */
export interface LessonCatalogEntry extends LessonDefinition<LessonSlug> {
  readonly order: number;
  readonly shortTitle: string;
  readonly concepts: readonly string[];
  readonly migrationStage: LessonMigrationStage;
  readonly parts: readonly string[];
  readonly pins: readonly LessonPinAssignment[];
}

interface LessonShellConfig {
  readonly narrative: string;
  readonly wiringInstructions: readonly string[];
  readonly wiringDiagramAlt: string;
  readonly codePrompt: string;
  readonly validatorId: string;
  readonly validationSuccess: string;
  readonly quizPrompt: string;
  readonly quizChoices: readonly QuizChoice[];
  readonly correctChoiceId: string;
  readonly observationPrompt: string;
  readonly serialObservation?: string;
  readonly completionSummary: string;
}

function createLessonSteps(config: LessonShellConfig): readonly LessonStep[] {
  const serialStep: readonly LessonStep[] = config.serialObservation
    ? [
        {
          id: "check-serial",
          type: "serial-check",
          title: "Read the signal",
          ariaLabel: "Check the board's serial output",
          uploadStepId: "upload-sketch",
          baudRate: 9_600,
          expectedObservation: config.serialObservation,
        },
      ]
    : [];
  const requiredStepIds = config.serialObservation
    ? ["check-understanding", "upload-sketch", "check-serial", "observe-build"]
    : ["check-understanding", "upload-sketch", "observe-build"];

  return [
    {
      id: "meet-the-build",
      type: "narrative",
      title: "Meet the build",
      ariaLabel: "Read the build introduction",
      body: config.narrative,
    },
    {
      id: "wire-build",
      type: "wiring",
      title: "Wire the build",
      ariaLabel: "Follow the wiring instructions",
      instructions: config.wiringInstructions,
      diagramAlt: config.wiringDiagramAlt,
    },
    {
      id: "edit-code",
      type: "code-edit",
      title: "Shape the sketch",
      ariaLabel: "Edit the Arduino sketch",
      prompt: config.codePrompt,
    },
    {
      id: "validate-code",
      type: "code-validation",
      title: "Check the idea",
      ariaLabel: "Validate the edited Arduino sketch",
      codeStepId: "edit-code",
      validatorId: config.validatorId,
      successMessage: config.validationSuccess,
    },
    {
      id: "check-understanding",
      type: "quiz",
      title: "Trail check",
      ariaLabel: "Answer the lesson knowledge check",
      prompt: config.quizPrompt,
      choices: config.quizChoices,
      correctChoiceId: config.correctChoiceId,
    },
    {
      id: "compile-sketch",
      type: "compile",
      title: "Build the sketch",
      ariaLabel: "Compile the validated Arduino sketch",
      validationStepId: "validate-code",
    },
    {
      id: "connect-board",
      type: "connect",
      title: "Connect the Nano",
      ariaLabel: "Connect an Arduino Nano through Web Serial",
    },
    {
      id: "upload-sketch",
      type: "upload",
      title: "Send to the board",
      ariaLabel: "Upload the compiled sketch to the connected Arduino Nano",
      compileStepId: "compile-sketch",
      connectStepId: "connect-board",
    },
    ...serialStep,
    {
      id: "observe-build",
      type: "manual-observation",
      title: "Watch it work",
      ariaLabel: "Confirm the physical build behavior",
      uploadStepId: "upload-sketch",
      prompt: config.observationPrompt,
    },
    {
      id: "finish-lesson",
      type: "completion",
      title: "Bank the spark",
      ariaLabel: "Complete the lesson and save progress",
      requiredStepIds,
      summary: config.completionSummary,
    },
  ];
}

type LessonCatalogSource = Omit<LessonCatalogEntry, "parts" | "pins">;

function defineLesson(source: LessonCatalogSource): LessonCatalogEntry {
  return {
    ...source,
    parts: source.hardwareParts,
    pins: source.pinAssignments,
  };
}

const lessonCatalogSource: readonly LessonCatalogEntry[] = [
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "first-spark",
    route: "/learn/first-spark",
    version: 1,
    order: 1,
    title: "First Spark",
    shortTitle: "Blink",
    summary: "Make the Nano's built-in LED blink, then compile and upload your first sketch.",
    estimatedMinutes: 35,
    prerequisites: [],
    hardwareParts: [
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
    ],
    pinAssignments: [
      {
        component: "Built-in LED",
        signal: "Blink output",
        pin: "LED_BUILTIN",
        note: "The LED is already connected on the board; do not add an external LED.",
      },
    ],
    concepts: ["Digital outputs", "setup()", "loop()", "timing", "compile and upload"],
    objectives: [
      "Describe why setup() runs once and loop() repeats while the Nano has power.",
      "Configure LED_BUILTIN as an output and drive it HIGH and LOW.",
      "Choose an even, visible blink interval and upload it to the supported Nano target.",
    ],
    safetyNotes: [
      "Rest the bare Nano on a dry, non-conductive surface; metal underneath can short its exposed pins.",
      "Inspect the USB socket and cable before use, and disconnect immediately if the board or cable becomes hot.",
      "Leave every external pin unconnected for this build and unplug USB before later wiring changes.",
    ],
    troubleshooting: [
      {
        problem: "The board does not appear in the browser picker.",
        guidance:
          "Use desktop Chrome or Edge, connect the cable directly, and try a known USB data cable rather than a charge-only cable.",
      },
      {
        problem: "Compilation succeeds but upload cannot begin.",
        guidance:
          "Choose the Nano serial device, close any other serial monitor, and reconnect USB before trying once more.",
      },
      {
        problem: "Upload succeeds but the built-in LED does not blink evenly.",
        guidance:
          "Confirm both writes use LED_BUILTIN, HIGH and LOW are both present, and both delay calls use the same BLINK_MS value.",
      },
    ],
    starterCode: `const unsigned int BLINK_MS = 500;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(BLINK_MS);
  digitalWrite(LED_BUILTIN, LOW);
  delay(BLINK_MS);
}
`,
    steps: createLessonSteps({
      narrative:
        "A sketch is the program on an Arduino. setup() prepares the hardware once; loop() then repeats. In this build those two functions turn the Nano's built-in LED into a steady camp signal.",
      wiringInstructions: [
        "Place the Nano component-side up on a dry, non-conductive surface with no loose wire or metal touching its pins.",
        "Check that every header pin, including 5V, 3V3, VIN, GND, and the digital pins, remains unconnected.",
        "Insert the small end of the USB data cable fully into the Nano's USB socket without forcing it.",
        "Connect the other end directly to the computer; the board's power light may turn on, but the built-in LED is the only controlled output in this lesson.",
      ],
      wiringDiagramAlt:
        "Connection diagram viewed from above: a USB data cable runs from the computer to the Nano USB socket. The on-board LED labelled L is highlighted as LED_BUILTIN, and every external header pin is shown unconnected.",
      codePrompt:
        "Change BLINK_MS to one value from 200 through 1,500 milliseconds. Both delay calls must keep using that same named value so the on and off times stay even.",
      validatorId: "first-spark-v1",
      validationSuccess:
        "setup() configures the built-in output, and loop() now has an ordered HIGH-delay-LOW-delay blink with one safe interval.",
      quizPrompt: "Which function repeats for as long as the board has power?",
      quizChoices: [
        { id: "setup", label: "setup()" },
        { id: "loop", label: "loop()" },
        { id: "pin-mode", label: "pinMode()" },
      ],
      correctChoiceId: "loop",
      observationPrompt:
        "After upload succeeds, watch the on-board L LED through at least three complete on-and-off cycles. Confirm that it changes at an even pace matching your BLINK_MS choice.",
      completionSummary:
        "Your saved upload evidence and physical observation show that you configured a digital output and ran your first sketch on the Nano.",
    }),
    migrationStage: "prototype-ready",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "morse-name",
    route: "/learn/morse-name",
    version: 1,
    order: 2,
    title: "Morse Name",
    shortTitle: "Morse",
    summary: "Encode your name as short and long flashes using reusable functions and precise Morse timing.",
    estimatedMinutes: 45,
    prerequisites: ["first-spark"],
    hardwareParts: [
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
    ],
    pinAssignments: [
      {
        component: "Built-in LED",
        signal: "Morse light output",
        pin: "LED_BUILTIN",
        note: "The on-board LED supplies every dot and dash; no external wiring is used.",
      },
    ],
    concepts: ["Functions", "parameters", "Morse timing", "patterns", "personalized code"],
    objectives: [
      "Use dot(), dash(), and spacing functions to name repeated behavior.",
      "Relate a dash, letter gap, and word gap to the one-unit dot timing standard.",
      "Translate an A-Z/0-9 name into a repeatable LED message and verify it on the Nano.",
    ],
    safetyNotes: [
      "Keep the Nano on a dry, non-conductive surface and leave every external header pin disconnected.",
      "Unplug USB before moving the board, and disconnect immediately if the board or cable becomes hot.",
      "Keep UNIT_MS at 200 milliseconds or slower so the repeating LED pattern stays below three flashes per second.",
    ],
    troubleshooting: [
      {
        problem: "Dots and dashes look identical.",
        guidance:
          "Keep dot() at pulse(1), dash() at pulse(3), and UNIT_MS between 200 and 500 milliseconds.",
      },
      {
        problem: "Letters run together.",
        guidance:
          "Keep the one-unit low pause inside pulse(), then add two units with letterGap() for three units total.",
      },
      {
        problem: "Words or repeated messages run together.",
        guidance:
          "Use wordGap() between words and messageGap() at the end. Each adds six units after pulse() already supplied the first low unit.",
      },
      {
        problem: "The flashes do not match the intended name.",
        guidance:
          "Check one letter at a time against an International Morse A-Z/0-9 chart, preserving dot and dash order before checking the gaps.",
      },
    ],
    starterCode: createMorseNameStarterCode("ADA"),
    steps: createLessonSteps({
      narrative:
        "International Morse code turns dots and dashes into letters. Firelight safely prepares an A-Z/0-9 pattern from your profile name, and the sketch expresses that pattern as small functions you can read and change.",
      wiringInstructions: [
        "Place the Nano component-side up on a dry, non-conductive surface.",
        "Verify that every external header pin remains unconnected; this build reuses only the LED already fitted to the Nano.",
        "Connect the USB data cable from the Nano USB socket directly to the computer.",
        "Locate the on-board L LED identified in First Spark; that LED will carry the complete message.",
      ],
      wiringDiagramAlt:
        "Connection diagram viewed from above: the computer connects only to the Nano USB socket. The built-in L LED is labelled LED_BUILTIN and highlighted as the Morse output; all breadboard and external header connections are absent.",
      codePrompt:
        "Read the generated calls inside loop() one letter at a time. Adjust the dot() and dash() sequence to spell the A-Z/0-9 name you want, using letterGap() between letters, wordGap() between words, and one final messageGap().",
      validatorId: "morse-name-v1",
      validationSuccess:
        "The LED setup, one-to-three dot/dash timing, total three/seven-unit gaps, and executable name calls are ready to compile.",
      quizPrompt: "How long should a dash stay on compared with a dot?",
      quizChoices: [
        { id: "same", label: "The same length" },
        { id: "twice", label: "Twice as long" },
        { id: "three", label: "Three times as long" },
      ],
      correctChoiceId: "three",
      observationPrompt:
        "After upload, follow one complete message from its first flash through the long final pause. Confirm at least one letter dot-by-dot and dash-by-dash against the intended name pattern.",
      completionSummary:
        "Your upload evidence and observed flash pattern show that reusable functions and precise timing now carry your personal message.",
    }),
    migrationStage: "prototype-ready",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "button-reaction",
    route: "/learn/button-reaction",
    version: 1,
    order: 3,
    title: "Button Reaction",
    shortTitle: "Button",
    summary: "Wire an active-LOW pushbutton and use program state to measure one reaction at a time.",
    estimatedMinutes: 60,
    prerequisites: ["morse-name"],
    hardwareParts: [
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
      "Momentary four-leg pushbutton",
      "Solderless breadboard",
      "2 male-to-male jumper wires",
    ],
    pinAssignments: [
      {
        component: "Pushbutton",
        signal: "Active-LOW input",
        pin: "D2",
        note: "D2 connects to GND only while pressed and is configured with INPUT_PULLUP; no external resistor or 5V wire is used.",
      },
      {
        component: "Built-in LED",
        signal: "Reaction cue output",
        pin: "LED_BUILTIN",
        note: "The on-board LED turns HIGH to start timing and LOW after one accepted press.",
      },
    ],
    concepts: ["INPUT_PULLUP", "active-LOW logic", "conditions", "state", "millis()"],
    objectives: [
      "Wire D2 to GND through a momentary button and explain why INPUT_PULLUP reads LOW when pressed.",
      "Use named states so one physical press produces one reaction result and release rearms the timer.",
      "Subtract two millis() readings and print the elapsed reaction time at 9,600 baud.",
    ],
    safetyNotes: [
      "Disconnect USB before inserting, rotating, or moving the pushbutton or either jumper wire.",
      "This circuit uses D2 and GND only: do not connect the button to 5V, VIN, or any output pin.",
      "Inspect for jumpers touching adjacent Nano pins before reconnecting USB, and unplug immediately if anything becomes hot.",
    ],
    troubleshooting: [
      {
        problem: "The button always reads as pressed.",
        guidance:
          "Disconnect USB, rotate the four-leg button 90 degrees, and make sure D2 and GND reach opposite switched sides rather than two legs that are already joined.",
      },
      {
        problem: "Pressing the button never changes the reading.",
        guidance:
          "Confirm the button straddles the breadboard center gap, D2 reaches one switched side, GND reaches the other, and the code uses INPUT_PULLUP.",
      },
      {
        problem: "A held button prints several reaction times.",
        guidance:
          "Keep the WAITING_FOR_RESULT_RELEASE state so the program accepts no new result until the button returns HIGH.",
      },
      {
        problem: "No reaction number appears after the LED lights.",
        guidance:
          "Open the lesson's 9,600-baud serial capture after upload and check that Serial.begin(9600) and Serial.println(reactionTime) remain in the sketch.",
      },
    ],
    starterCode: `const int BUTTON_PIN = 2;
const unsigned long CUE_DELAY_MS = 2000;

enum ReactionState {
  READY_TO_ARM,
  WAITING_FOR_ARM_RELEASE,
  WAITING_FOR_CUE,
  WAITING_FOR_PRESS,
  WAITING_FOR_RESULT_RELEASE
};

ReactionState state = READY_TO_ARM;
unsigned long waitStartedAt = 0;
unsigned long cueStartedAt = 0;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.begin(9600);
}

void loop() {
  const bool pressed = digitalRead(BUTTON_PIN) == LOW;

  if (state == READY_TO_ARM && pressed) {
    state = WAITING_FOR_ARM_RELEASE;
  } else if (state == WAITING_FOR_ARM_RELEASE && !pressed) {
    waitStartedAt = millis();
    state = WAITING_FOR_CUE;
  } else if (
    state == WAITING_FOR_CUE &&
    millis() - waitStartedAt >= CUE_DELAY_MS
  ) {
    digitalWrite(LED_BUILTIN, HIGH);
    cueStartedAt = millis();
    state = WAITING_FOR_PRESS;
  } else if (state == WAITING_FOR_PRESS && pressed) {
    const unsigned long reactionTime = millis() - cueStartedAt;
    digitalWrite(LED_BUILTIN, LOW);
    Serial.println(reactionTime);
    state = WAITING_FOR_RESULT_RELEASE;
  } else if (state == WAITING_FOR_RESULT_RELEASE && !pressed) {
    state = READY_TO_ARM;
  }
}
`,
    steps: createLessonSteps({
      narrative:
        "Outputs let code affect the world; inputs let the world answer back. INPUT_PULLUP holds D2 HIGH without an external resistor, the button pulls it LOW, and named states ensure a press is counted only at the right moment.",
      wiringInstructions: [
        "Disconnect the Nano's USB cable before touching the breadboard circuit.",
        "Place the four-leg momentary button so it straddles the breadboard's center trench; the two legs on each short side are internally joined.",
        "Use one jumper to connect Nano D2 to a breadboard row holding a button leg on one switched side.",
        "Use the second jumper to connect a Nano GND pin to a row holding a button leg on the opposite switched side.",
        "Do not add a 5V wire or resistor: INPUT_PULLUP supplies the resting HIGH state inside the Nano.",
        "Check that D2 and GND are not directly joined when the button is released, then reconnect USB.",
      ],
      wiringDiagramAlt:
        "Connection diagram viewed from above: a four-leg pushbutton straddles the breadboard center trench. One jumper runs from Nano D2 to a row on one switched side; a second runs from Nano GND to the opposite switched side. Pressing closes D2 to GND. No 5V wire or external resistor is present.",
      codePrompt:
        "Tune CUE_DELAY_MS to a value from 1,500 through 5,000 milliseconds. Preserve the active-LOW pressed reading, millis() subtraction, and WAITING_FOR_RESULT_RELEASE path so each cue produces at most one result.",
      validatorId: "button-reaction-v1",
      validationSuccess:
        "D2 is an active-LOW INPUT_PULLUP, the cue and elapsed-time logic are scoped to loop(), and release-to-rearm state protects each serial result.",
      quizPrompt: "What value does D2 read while the wired INPUT_PULLUP button is pressed?",
      quizChoices: [
        { id: "high", label: "HIGH" },
        { id: "low", label: "LOW" },
        { id: "analog", label: "An analog number" },
      ],
      correctChoiceId: "low",
      serialObservation:
        "Press and release once to arm the timer. After the cue LED turns on and the button is pressed, one non-negative integer reaction time appears. Holding the button produces no additional line.",
      observationPrompt:
        "Press and release once to arm the timer, wait for the built-in LED cue, then press and hold for the result. Confirm the LED turns off and only one line prints. Release, then press and release once more to arm a second round; wait for the next cue and press once to produce one new result.",
      completionSummary:
        "Upload evidence, a captured serial result, and your physical check show that an active-LOW input now drives measured, one-shot program state.",
    }),
    migrationStage: "prototype-ready",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "distance-scout",
    route: "/learn/distance-scout",
    version: 1,
    order: 4,
    title: "Distance Scout",
    shortTitle: "Distance",
    summary: "Measure an ultrasonic echo, read live centimetres, and calibrate a useful safety threshold.",
    estimatedMinutes: 60,
    prerequisites: ["button-reaction"],
    hardwareParts: [
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
      "HC-SR04 ultrasonic sensor",
      "Breadboard",
      "4 male-to-male jumper wires",
      "Ruler or tape measure",
      "Broad, flat test object",
    ],
    pinAssignments: [
      {
        component: "HC-SR04 TRIG",
        signal: "Trigger output",
        pin: "D9",
        note: "HC-SR04 VCC also connects to Nano 5V and GND connects to Nano GND.",
      },
      {
        component: "HC-SR04 ECHO",
        signal: "Echo input",
        pin: "D10",
        note: "The supported 5 V Nano can read the HC-SR04 echo directly.",
      },
    ],
    concepts: ["Ultrasonic sensing", "pulse duration", "Serial at 9600 baud", "calibration"],
    objectives: [
      "Send the HC-SR04 a 10 microsecond trigger pulse on D9 and time its D10 echo safely.",
      "Convert the sound pulse's round-trip duration into approximate centimetres.",
      "Compare 9600-baud readings with known distances and choose a repeatable threshold.",
    ],
    safetyNotes: [
      "Disconnect USB before inserting, removing, or moving any sensor wire.",
      "Read the labels printed on this HC-SR04 before wiring it; pin order can differ between sensor boards.",
      "Connect VCC only to Nano 5V and GND only to Nano GND. Reversed power can permanently damage the sensor.",
      "Keep the sensor dry and do not press on its two metal transducers.",
    ],
    troubleshooting: [
      {
        problem: "The serial monitor says no echo or never shows a positive number.",
        guidance: "Set the monitor to 9600 baud, then recheck TRIG D9, ECHO D10, VCC 5V, and GND before aiming at a broad hard surface 10–100 cm away.",
      },
      {
        problem: "Readings jump or are much longer than the measured distance.",
        guidance: "Hold the sensor square to a hard, flat target, keep hands out of its cone, and leave at least 60 ms between pings so echoes do not overlap.",
      },
      {
        problem: "The values look like nonsense characters.",
        guidance: "Use the lesson serial reader at 9600 baud; a different baud rate makes otherwise correct output unreadable.",
      },
    ],
    starterCode: `const int TRIG_PIN = 9;
const int ECHO_PIN = 10;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (duration == 0) {
    return -1.0;
  }

  return duration * 0.0343 / 2.0;
}

void setup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.begin(9600);
}

void loop() {
  float distance = readDistanceCm();
  if (distance > 0) {
    Serial.println(distance);
  } else {
    Serial.println("No echo");
  }
  delay(100);
}
`,
    steps: createLessonSteps({
      narrative:
        "The HC-SR04 sends a burst of sound above human hearing and times its return. Because the pulse travels to the target and back, the sketch divides the travelled distance by two to estimate the one-way distance.",
      wiringInstructions: [
        "Disconnect the Nano's USB cable, identify the VCC, TRIG, ECHO, and GND labels on your sensor, and place it so both metal transducers face clear space.",
        "Connect HC-SR04 VCC to the Nano 5V pin and HC-SR04 GND to a Nano GND pin.",
        "Connect HC-SR04 TRIG to Nano D9 and HC-SR04 ECHO to Nano D10.",
        "Trace all four paths from the sensor labels to the Nano, check that no bare jumpers touch, and only then reconnect USB.",
      ],
      wiringDiagramAlt:
        "Connection map: HC-SR04 VCC to Nano 5V, GND to Nano GND, TRIG to Nano digital pin D9, and ECHO to Nano digital pin D10; the sensor's two round transducers face the test object unobstructed.",
      codePrompt: "Keep TRIG on D9 and ECHO on D10, use a bounded pulseIn() echo wait, convert the round trip to centimetres, and report readings through Serial at 9600 baud no faster than every 60 milliseconds.",
      validatorId: "distance-scout-v1",
      validationSuccess: "D9/D10, the 10 microsecond trigger, bounded echo, round-trip conversion, 9600-baud output, and safe ping interval are ready.",
      quizPrompt: "Why is the measured sound travel distance divided by two?",
      quizChoices: [
        { id: "voltage", label: "The sensor runs at half voltage" },
        { id: "round-trip", label: "The pulse travels to the object and back" },
        { id: "two-pins", label: "The sensor uses two signal pins" },
      ],
      correctChoiceId: "round-trip",
      serialObservation: "At 9600 baud, positive centimetre values decrease as the broad target moves nearer and increase as it moves farther; an absent echo is reported instead of blocking forever.",
      observationPrompt: "Hold a flat target at 15 cm, 30 cm, and 60 cm, record one stable reading at each mark, and confirm the values are ordered correctly and close enough to choose a safe threshold.",
      completionSummary: "Your recorded upload evidence, live serial check, and three-distance observation show that you turned a bounded echo into calibrated distance data.",
    }),
    migrationStage: "prototype-ready",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "servo-gate",
    route: "/learn/servo-gate",
    version: 1,
    order: 5,
    title: "Servo Gate",
    shortTitle: "Servo",
    summary: "Power an SG90 safely and move a lightweight gate between two controlled angles.",
    estimatedMinutes: 60,
    prerequisites: ["distance-scout"],
    hardwareParts: [
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
      "SG90 micro servo",
      "Firelight-supplied regulated 5V servo supply rated for at least 1 A (exact model, polarity, and connectors require signed pilot BOM)",
      "3 servo-compatible jumper leads",
      "Lightweight gate arm",
    ],
    pinAssignments: [
      {
        component: "SG90 signal lead",
        signal: "Angle-control pulse",
        pin: "D6",
        note: "Servo +5V goes to the external regulated supply; servo ground, supply ground, and Nano GND must join. Lead colours vary, so use the servo label or datasheet.",
      },
    ],
    concepts: ["Servo library", "angles", "mechanisms", "external power and common ground"],
    objectives: [
      "Use the pinned Servo library to attach one SG90 signal lead to D6.",
      "Command two distinct target angles between 10 and 170 degrees with time to reach each one.",
      "Power the servo from regulated external 5V while sharing only ground and the D6 control signal with the Nano.",
      "Test a lightweight gate without forcing, buzzing, or stalling its mechanism.",
    ],
    safetyNotes: [
      "Do not connect servo power until the pilot BOM records the exact supply's regulated 5V output under load, current capability and protection, connector polarity, and lead adapter, and an electrical reviewer has signed the pairing with the supplied SG90.",
      "Never power the SG90 from the Nano's 5V pin in this build; use only the approved Firelight-supplied regulated 5V supply rated for at least 1 A.",
      "Turn off external power and unplug Nano USB before wiring. Never connect the external supply's positive lead to Nano 5V or VIN.",
      "Join servo ground, external-supply ground, and Nano GND before connecting the D6 signal so they share a reference.",
      "Fit only a lightweight arm, keep fingers and wires out of its sweep, and remove power immediately if the servo buzzes, stalls, heats, or strikes an end stop.",
    ],
    troubleshooting: [
      {
        problem: "The servo jitters or resets the Nano.",
        guidance: "Switch everything off, confirm the approved Firelight supply provides regulated external 5V with at least 1 A available, reconnect all grounds together, and remove any heavy load before retrying.",
      },
      {
        problem: "The servo does not move even though upload succeeds.",
        guidance: "Check the servo's own lead identification rather than assuming colours, confirm its signal reaches D6, and make sure the external supply is switched on.",
      },
      {
        problem: "The gate moves the wrong way or touches a stop.",
        guidance: "Power off, detach or reposition the lightweight horn, then narrow or swap the open and closed angle constants; never force the shaft by hand.",
      },
    ],
    starterCode: `#include <Servo.h>

const int SERVO_PIN = 6;
const int CLOSED_ANGLE = 20;
const int OPEN_ANGLE = 100;
Servo gate;

void setup() {
  gate.attach(SERVO_PIN);
  gate.write(CLOSED_ANGLE);
  delay(1000);
}

void loop() {
  gate.write(OPEN_ANGLE);
  delay(1200);
  gate.write(CLOSED_ANGLE);
  delay(1200);
}
`,
    steps: createLessonSteps({
      narrative:
        "An SG90 contains a motor and position controller: the Nano requests an angle on D6 while a separate regulated supply provides the changing motor current. A common ground lets the servo interpret the D6 control pulse correctly.",
      wiringInstructions: [
        "After the signed pilot BOM has been checked, unplug Nano USB, turn off the approved Firelight supply, and identify the servo's +5V, ground, and signal leads from its label or datasheet; do not rely on colour alone.",
        "Connect servo +5V only to external regulated +5V, and connect servo ground to the external supply ground.",
        "Connect that same external supply ground to Nano GND. Do not connect external +5V to Nano 5V or VIN.",
        "Connect only the servo signal lead to Nano D6, fit the lightweight arm with room to sweep, and trace every connection before restoring USB and then external power.",
      ],
      wiringDiagramAlt:
        "Connection map: SG90 signal lead to Nano D6; SG90 positive lead to the approved Firelight-supplied regulated 5V supply rated at least 1 A; SG90 ground and supply negative joined to Nano GND; external positive is not connected to any Nano power pin; a lightweight gate arm has a clear sweep.",
      codePrompt: "Keep the Servo library and D6 signal, define two distinct open and closed angles from 10 through 170 degrees, and pause long enough after each write for the unloaded gate to arrive.",
      validatorId: "servo-gate-v1",
      validationSuccess: "The pinned Servo library, D6 attachment, two distinct safe angles, and settling pauses are ready.",
      quizPrompt: "Why must the external servo supply ground connect to Nano ground?",
      quizChoices: [
        { id: "charge", label: "To charge the Nano" },
        { id: "signal-reference", label: "To give the control signal a shared reference" },
        { id: "faster", label: "To make the sketch compile faster" },
      ],
      correctChoiceId: "signal-reference",
      observationPrompt: "With the arm unloaded and its sweep clear, confirm three complete open-and-close cycles reach both angles smoothly without buzzing, striking a stop, heating, or resetting the Nano.",
      completionSummary: "Your recorded upload evidence and three-cycle observation show that you powered and controlled a moving gate safely.",
    }),
    migrationStage: "prototype-ready",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "trail-rover",
    route: "/learn/trail-rover",
    version: 1,
    order: 6,
    title: "Trail Rover",
    shortTitle: "Rover",
    summary: "Combine a TB6612FNG drive stage and ultrasonic sensing into a rover that stops before obstacles.",
    estimatedMinutes: 100,
    prerequisites: ["servo-gate"],
    hardwareParts: [
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
      "Firelight-supplied TB6612FNG motor-driver carrier (exact carrier rating requires signed pilot BOM)",
      "Two Firelight-supplied TT motors (exact voltage and stall current require signed pilot BOM)",
      "Two wheels and caster",
      "HC-SR04 ultrasonic sensor",
      "Firelight-supplied switched motor battery pack (no substitutions; exact voltage/current pairing requires signed pilot BOM)",
      "Two-motor chassis",
      "Breadboard and jumper wires",
      "Small non-slip stand for raised-wheel testing",
    ],
    pinAssignments: [
      { component: "TB6612FNG PWMA", signal: "Left-motor speed PWM", pin: "D3" },
      { component: "TB6612FNG AIN1", signal: "Left-motor direction 1", pin: "D4" },
      { component: "TB6612FNG AIN2", signal: "Left-motor direction 2", pin: "D5" },
      { component: "TB6612FNG PWMB", signal: "Right-motor speed PWM", pin: "D6" },
      { component: "TB6612FNG BIN1", signal: "Right-motor direction 1", pin: "D7" },
      { component: "TB6612FNG BIN2", signal: "Right-motor direction 2", pin: "D8" },
      {
        component: "HC-SR04 TRIG",
        signal: "Distance trigger output",
        pin: "D9",
        note: "Sensor VCC connects to Nano 5V and sensor GND joins the common ground.",
      },
      { component: "HC-SR04 ECHO", signal: "Distance echo input", pin: "D10" },
      {
        component: "TB6612FNG STBY",
        signal: "Driver standby enable",
        pin: "D12",
        note: "Driver VCC connects to Nano 5V; VM connects only to motor-battery positive; every ground joins together.",
      },
    ],
    concepts: ["Dual motor driver", "bounded PWM", "staged movement", "fail-safe autonomy"],
    objectives: [
      "Control two TT motors through fixed TB6612FNG signals on D3–D8 and standby on D12.",
      "Separate USB/logic power from motor power while joining Nano, sensor, driver, and battery grounds.",
      "Verify low-speed direction and stopping with the wheels raised before a floor test.",
      "Read the HC-SR04 on D9/D10 and stop both motor PWM channels for a near or invalid reading.",
    ],
    safetyNotes: [
      "Do not connect motor power until the pilot BOM records the pack's maximum voltage/current capability, each motor's stall current at that voltage, and the exact carrier's continuous/peak/thermal limits, and an electrical reviewer has signed the pairing.",
      "Remove the motor battery and unplug USB before every wiring change. Never work on an energized rover.",
      "Never connect a motor or motor-battery positive lead to a Nano pin. Motor-battery positive goes only to driver VM; driver logic VCC and sensor VCC use Nano 5V.",
      "Join battery negative, both driver ground pins, Nano GND, and HC-SR04 GND. Do not join the battery's positive lead to Nano 5V or VIN.",
      "Secure the rover on a non-slip stand with both wheels clear for the first powered test; keep fingers, hair, clothing, and jumper wires away from the drivetrain.",
      "Remove power immediately if a wire, motor, driver, or battery heats, smells, stalls, or behaves unexpectedly.",
      "Run floor tests at low speed in a clear pen away from stairs, table edges, feet, pets, and fragile objects. Restrain the USB cable with generous slack so the rover cannot snag it or pull the computer, and keep one hand ready at the motor-battery switch.",
    ],
    troubleshooting: [
      {
        problem: "One wheel runs backward.",
        guidance: "Power off and swap that motor's two driver output leads, then repeat the raised-wheel test.",
      },
      {
        problem: "Neither motor moves.",
        guidance: "Remove power, then check motor-battery polarity at VM/GND, driver VCC at Nano 5V, the common ground, D12 standby HIGH, and PWM on D3 and D6.",
      },
      {
        problem: "The Nano resets or serial values become erratic when motors start.",
        guidance: "Stop the test and confirm motor power goes only through VM, all grounds are secure, motor leads are kept away from sensor leads, and the battery can supply both motors.",
      },
      {
        problem: "The rover stops too late or drives when the sensor has no echo.",
        guidance: "Keep no-echo behavior fail-safe, lower MOTOR_SPEED, and increase STOP_DISTANCE_CM before repeating the raised-wheel test and then the clear-floor test.",
      },
    ],
    starterCode: `const int PWMA = 3;
const int AIN1 = 4;
const int AIN2 = 5;
const int PWMB = 6;
const int BIN1 = 7;
const int BIN2 = 8;
const int TRIG_PIN = 9;
const int ECHO_PIN = 10;
const int STANDBY = 12;
const int MOTOR_SPEED = 120;
const float STOP_DISTANCE_CM = 25.0;

void stopMotors() {
  analogWrite(PWMA, 0);
  analogWrite(PWMB, 0);
  digitalWrite(AIN1, LOW);
  digitalWrite(AIN2, LOW);
  digitalWrite(BIN1, LOW);
  digitalWrite(BIN2, LOW);
}

void driveForward(int speedValue) {
  int safeSpeed = constrain(speedValue, 0, 180);
  digitalWrite(AIN1, HIGH);
  digitalWrite(AIN2, LOW);
  digitalWrite(BIN1, HIGH);
  digitalWrite(BIN2, LOW);
  analogWrite(PWMA, safeSpeed);
  analogWrite(PWMB, safeSpeed);
}

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  return duration == 0 ? -1.0 : duration * 0.0343 / 2.0;
}

void setup() {
  pinMode(PWMA, OUTPUT);
  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  pinMode(PWMB, OUTPUT);
  pinMode(BIN1, OUTPUT);
  pinMode(BIN2, OUTPUT);
  pinMode(STANDBY, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(STANDBY, LOW);
  stopMotors();
  digitalWrite(STANDBY, HIGH);
  Serial.begin(9600);
  delay(1500);
}

void loop() {
  float distance = readDistanceCm();
  Serial.println(distance);
  if (distance > 0 && distance <= STOP_DISTANCE_CM) {
    stopMotors();
  } else if (distance > 0) {
    driveForward(MOTOR_SPEED);
  } else {
    stopMotors();
  }
  delay(80);
}
`,
    steps: createLessonSteps({
      narrative:
        "The rover combines earlier skills but adds real mechanical energy. The Nano controls the TB6612FNG; the driver switches separate motor power; the HC-SR04 reports distance; and fail-safe conditions decide whether both wheels may move.",
      wiringInstructions: [
        "Remove the motor battery and unplug Nano USB. Mount the Nano, TB6612FNG, forward-facing HC-SR04, both TT motors, wheels, and caster so no loose lead can touch a wheel or axle.",
        "Check the motor pack, both motors, and driver carrier against the electrically signed pilot BOM. If any label or part differs—or the BOM is not signed—stop before connecting motor power.",
        "Connect Nano D3 to PWMA, D4 to AIN1, D5 to AIN2, D6 to PWMB, D7 to BIN1, D8 to BIN2, and D12 to STBY.",
        "Connect the left motor to driver AO1/AO2 and the right motor to BO1/BO2. Do not connect either motor directly to the Nano.",
        "Connect HC-SR04 TRIG to D9, ECHO to D10, VCC to Nano 5V, and GND to the common ground.",
        "Connect driver logic VCC to Nano 5V. Connect motor-battery positive only to driver VM; do not connect it to Nano 5V or VIN.",
        "Join motor-battery negative, every driver GND, Nano GND, and HC-SR04 GND into one common ground.",
        "Trace D3–D10 and D12, every power rail, and both motor outputs against the connection map. Keep the motor battery removed until the sketch is uploaded and the chassis is secure on the raised-wheel stand.",
        "For the later floor test, make a small pen within USB-cable reach and restrain the computer end. Route generous cable slack behind the rover where no wheel can catch it; the tether must never pull the computer or lift a Nano connection.",
      ],
      wiringDiagramAlt:
        "Connection map: Nano D3 to TB6612 PWMA, D4 AIN1, D5 AIN2, D6 PWMB, D7 BIN1, D8 BIN2, and D12 STBY; left motor on AO1/AO2 and right motor on BO1/BO2; HC-SR04 TRIG on D9, ECHO on D10, and VCC on Nano 5V; TB6612 logic VCC on Nano 5V; motor-battery positive only on VM; battery negative, TB6612 grounds, sensor ground, and Nano GND all joined; both wheels raised clear of the bench, with the USB tether restrained and routed behind them with slack.",
      codePrompt: "Keep the fixed D3–D10/D12 map, bound both PWM channels to a low test speed, use a timed HC-SR04 echo, and stop both motors when distance is at or below the threshold or when no valid echo returns.",
      validatorId: "trail-rover-v1",
      validationSuccess: "The exact pin map, output modes, common-speed bound, standby enable, bounded echo, and fail-safe two-motor stop logic are ready.",
      quizPrompt: "What should happen first when the measured distance crosses the safety threshold?",
      quizChoices: [
        { id: "faster", label: "Increase both motor speeds" },
        { id: "stop", label: "Set both motor PWM outputs to zero" },
        { id: "disconnect-sensor", label: "Ignore the sensor until restart" },
      ],
      correctChoiceId: "stop",
      serialObservation: "At 9600 baud with both wheels raised, positive centimetre readings update and both wheels change from low-speed forward motion to fully stopped at the threshold; a no-echo value also leaves both wheels stopped.",
      observationPrompt: "First confirm direction, low speed, threshold stop, and no-echo stop with the wheels raised. Then, with the USB cable safely restrained and slack outside the wheels, run a short low-speed test inside its clear floor pen and confirm the rover stops before a broad obstacle three times while you remain at the battery switch.",
      completionSummary: "Your recorded upload evidence, raised-wheel serial check, fail-safe test, and three controlled floor stops demonstrate an autonomous trail rover.",
    }),
    migrationStage: "prototype-ready",
  }),
];

export const lessonCatalog = assertValidLessonCatalog(lessonCatalogSource);

export function findLesson(id: string | undefined): LessonCatalogEntry | undefined {
  return lessonCatalog.find((lesson) => lesson.id === id);
}
