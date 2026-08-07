import { lessonSlugs } from "../../../shared/curriculum";
import type { LessonSlug } from "../../../shared/curriculum";
import { LESSON_SCHEMA_VERSION } from "./contracts";
import type {
  LessonDefinition,
  LessonPinAssignment,
  LessonStep,
  QuizChoice,
} from "./contracts";
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
          expectedObservation: config.serialObservation,
        },
      ]
    : [];
  const requiredStepIds = config.serialObservation
    ? ["check-understanding", "check-serial", "observe-build"]
    : ["check-understanding", "observe-build"];

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
    summary: "Wake the built-in LED and send your first sketch to a real Nano.",
    estimatedMinutes: 30,
    prerequisites: [],
    hardwareParts: ["Arduino Nano-compatible board", "USB data cable"],
    pinAssignments: [
      {
        component: "Built-in LED",
        signal: "Output",
        pin: "LED_BUILTIN",
        note: "No breadboard wiring is required.",
      },
    ],
    concepts: ["Outputs", "setup()", "loop()", "compile and upload"],
    objectives: [
      "Explain when setup() and loop() run.",
      "Configure the built-in LED as an output.",
      "Compile and upload a sketch to the supported Nano.",
    ],
    safetyNotes: [
      "Place the Nano on a clear, non-conductive surface before connecting USB.",
      "Disconnect USB before changing any later breadboard wiring.",
    ],
    troubleshooting: [
      {
        problem: "The board does not appear in the browser picker.",
        guidance: "Use desktop Chrome or Edge and confirm the cable carries data, not power only.",
      },
      {
        problem: "The upload finishes but no LED blinks.",
        guidance: "Confirm the code uses LED_BUILTIN and wait through one complete delay cycle.",
      },
    ],
    starterCode: `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`,
    steps: createLessonSteps({
      narrative:
        "A sketch is a repeating set of instructions. Your first one turns the Nano's built-in light into a steady camp signal.",
      wiringInstructions: [
        "Set the Nano on a non-conductive surface.",
        "Connect the Nano directly to the computer with the USB data cable.",
        "Leave every external pin disconnected for this build.",
      ],
      wiringDiagramAlt:
        "Arduino Nano connected directly to a computer by USB, with the built-in LED highlighted.",
      codePrompt: "Change both delay values to make a clear, even blink between 200 and 1,500 milliseconds.",
      validatorId: "first-spark-v1",
      validationSuccess: "The LED output and safe matching delays are ready to compile.",
      quizPrompt: "Which function repeats for as long as the board has power?",
      quizChoices: [
        { id: "setup", label: "setup()" },
        { id: "loop", label: "loop()" },
        { id: "pin-mode", label: "pinMode()" },
      ],
      correctChoiceId: "loop",
      observationPrompt: "Confirm that the built-in LED turns on and off at a steady pace at least three times.",
      completionSummary: "You configured an output and sent your first working sketch to real hardware.",
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
    summary: "Turn your name into a tiny light signal using functions and timing.",
    estimatedMinutes: 40,
    prerequisites: ["first-spark"],
    hardwareParts: ["Arduino Nano-compatible board", "USB data cable"],
    pinAssignments: [
      { component: "Built-in LED", signal: "Output", pin: "LED_BUILTIN" },
    ],
    concepts: ["Functions", "timing", "patterns", "personalized code"],
    objectives: [
      "Use small functions to name repeated behavior.",
      "Compare dot, dash, letter, and word timing.",
      "Create a light pattern from a learner name.",
    ],
    safetyNotes: ["Keep every external pin disconnected while this USB-only build is running."],
    troubleshooting: [
      {
        problem: "Dots and dashes look identical.",
        guidance: "Keep dash duration three times longer than dot duration.",
      },
      {
        problem: "Letters run together.",
        guidance: "Add a three-unit pause after each letter and a seven-unit pause between words.",
      },
    ],
    starterCode: `const int UNIT = 180;

void pulse(int units) {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(UNIT * units);
  digitalWrite(LED_BUILTIN, LOW);
  delay(UNIT);
}

void dot() { pulse(1); }
void dash() { pulse(3); }

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  dot(); dot(); dot();
  delay(UNIT * 3);
  dash(); dash(); dash();
  delay(UNIT * 7);
}
`,
    steps: createLessonSteps({
      narrative:
        "Morse code gives short and long signals meaning. Small functions let the sketch read like the signal you want to send.",
      wiringInstructions: [
        "Keep the Nano on a non-conductive surface.",
        "Connect it to the computer with the USB data cable.",
        "Use only the built-in LED for this signal.",
      ],
      wiringDiagramAlt:
        "USB-powered Arduino Nano with its built-in LED marked as the Morse signal output.",
      codePrompt: "Replace the sample signal in loop() with the generated dot and dash sequence for your name.",
      validatorId: "morse-name-v1",
      validationSuccess: "The name signal uses recognized dot, dash, and letter timing calls.",
      quizPrompt: "How long should a dash stay on compared with a dot?",
      quizChoices: [
        { id: "same", label: "The same length" },
        { id: "twice", label: "Twice as long" },
        { id: "three", label: "Three times as long" },
      ],
      correctChoiceId: "three",
      observationPrompt: "Watch one full cycle and confirm that the short and long flashes spell the intended name pattern.",
      completionSummary: "You turned functions and timing into a personal light message.",
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
    summary: "Build a reaction timer and let a pushbutton change what the code does.",
    estimatedMinutes: 50,
    prerequisites: ["morse-name"],
    hardwareParts: [
      "Arduino Nano-compatible board",
      "USB data cable",
      "Pushbutton",
      "Breadboard",
      "Jumper wires",
    ],
    pinAssignments: [
      {
        component: "Pushbutton",
        signal: "Input",
        pin: "D2",
        note: "Wire to ground and configure INPUT_PULLUP.",
      },
      { component: "Built-in LED", signal: "Reaction cue", pin: "LED_BUILTIN" },
    ],
    concepts: ["INPUT_PULLUP", "conditions", "state", "elapsed time"],
    objectives: [
      "Read a digital input with the internal pull-up resistor.",
      "Use state and conditions to react to a press.",
      "Measure elapsed time with millis().",
    ],
    safetyNotes: [
      "Disconnect USB before placing or moving the pushbutton wires.",
      "Connect D2 to ground only through the button; never connect an output pin directly to ground.",
    ],
    troubleshooting: [
      {
        problem: "The button always reads as pressed.",
        guidance: "Rotate the four-leg button 90 degrees or move the ground jumper to the opposite switched side.",
      },
      {
        problem: "One press triggers several times.",
        guidance: "Wait for release and include a short debounce interval before accepting another press.",
      },
    ],
    starterCode: `const int BUTTON_PIN = 2;
unsigned long cueStarted = 0;
bool waitingForPress = false;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  delay(1500);
  digitalWrite(LED_BUILTIN, HIGH);
  cueStarted = millis();
  waitingForPress = true;
}

void loop() {
  if (waitingForPress && digitalRead(BUTTON_PIN) == LOW) {
    unsigned long reaction = millis() - cueStarted;
    digitalWrite(LED_BUILTIN, LOW);
    Serial.println(reaction);
    waitingForPress = false;
  }
}
`,
    steps: createLessonSteps({
      narrative:
        "Outputs let code affect the world; inputs let the world answer back. A pull-up input gives the button a stable resting state without another resistor.",
      wiringInstructions: [
        "Disconnect USB and place the button across the breadboard's center gap.",
        "Connect one switched side of the button to D2.",
        "Connect the opposite switched side to a Nano GND pin.",
        "Inspect the two connections, then reconnect USB.",
      ],
      wiringDiagramAlt:
        "Pushbutton across a breadboard center gap, connecting Arduino Nano pin D2 to ground when pressed.",
      codePrompt: "Complete the pressed condition and print the elapsed reaction time only once.",
      validatorId: "button-reaction-v1",
      validationSuccess: "D2 uses INPUT_PULLUP and the pressed state is handled as LOW.",
      quizPrompt: "What value does D2 read while the wired INPUT_PULLUP button is pressed?",
      quizChoices: [
        { id: "high", label: "HIGH" },
        { id: "low", label: "LOW" },
        { id: "analog", label: "An analog number" },
      ],
      correctChoiceId: "low",
      serialObservation: "One non-negative reaction-time number appears after the button is pressed.",
      observationPrompt: "Confirm that the LED turns off on one press and does not repeatedly trigger while held.",
      completionSummary: "You built a circuit that changes program state from a physical input.",
    }),
    migrationStage: "planned",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "distance-scout",
    route: "/learn/distance-scout",
    version: 1,
    order: 4,
    title: "Distance Scout",
    shortTitle: "Distance",
    summary: "Measure the world in front of your build and inspect live serial values.",
    estimatedMinutes: 55,
    prerequisites: ["button-reaction"],
    hardwareParts: [
      "Arduino Nano-compatible board",
      "USB data cable",
      "HC-SR04 ultrasonic sensor",
      "Breadboard",
      "Jumper wires",
    ],
    pinAssignments: [
      { component: "HC-SR04", signal: "Trigger", pin: "D9" },
      { component: "HC-SR04", signal: "Echo", pin: "D10" },
    ],
    concepts: ["Ultrasonic sensing", "Serial", "thresholds", "calibration"],
    objectives: [
      "Trigger an ultrasonic measurement and time its echo.",
      "Convert pulse duration into approximate centimetres.",
      "Use serial readings to choose a reliable threshold.",
    ],
    safetyNotes: [
      "Disconnect USB before moving sensor wires.",
      "Check the HC-SR04 labels carefully: swapping 5V and GND can damage the sensor.",
    ],
    troubleshooting: [
      {
        problem: "The serial reading is always zero.",
        guidance: "Recheck trigger D9, echo D10, 5V, and GND, then aim at a broad hard surface.",
      },
      {
        problem: "Readings jump wildly.",
        guidance: "Keep the sensor still, avoid soft angled targets, and leave about 60 ms between pings.",
      },
    ],
    starterCode: `const int TRIG_PIN = 9;
const int ECHO_PIN = 10;

void setup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  float centimetres = duration * 0.0343 / 2.0;
  Serial.println(centimetres);
  delay(100);
}
`,
    steps: createLessonSteps({
      narrative:
        "The HC-SR04 sends a short sound pulse and measures how long its echo takes to return. Code turns that travel time into distance.",
      wiringInstructions: [
        "Disconnect USB and place the HC-SR04 facing away from the breadboard.",
        "Connect VCC to 5V and GND to GND.",
        "Connect TRIG to D9 and ECHO to D10.",
        "Inspect all four sensor labels before reconnecting USB.",
      ],
      wiringDiagramAlt:
        "HC-SR04 connected to Arduino Nano 5V and ground, with trigger on D9 and echo on D10.",
      codePrompt: "Complete the duration-to-centimetres conversion and print one reading every 100 milliseconds.",
      validatorId: "distance-scout-v1",
      validationSuccess: "The trigger pulse, echo timeout, conversion, and serial output are present.",
      quizPrompt: "Why is the measured sound travel distance divided by two?",
      quizChoices: [
        { id: "voltage", label: "The sensor runs at half voltage" },
        { id: "round-trip", label: "The pulse travels to the object and back" },
        { id: "two-pins", label: "The sensor uses two signal pins" },
      ],
      correctChoiceId: "round-trip",
      serialObservation: "Distance values change in the expected direction as a flat object moves nearer and farther.",
      observationPrompt: "Test at two known distances and confirm the readings are close enough to choose a threshold.",
      completionSummary: "You converted a timed sensor pulse into calibrated distance data.",
    }),
    migrationStage: "planned",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "servo-gate",
    route: "/learn/servo-gate",
    version: 1,
    order: 5,
    title: "Servo Gate",
    shortTitle: "Servo",
    summary: "Move a small gate to precise angles and learn safe servo power habits.",
    estimatedMinutes: 55,
    prerequisites: ["distance-scout"],
    hardwareParts: [
      "Arduino Nano-compatible board",
      "USB data cable",
      "SG90 micro servo",
      "External regulated 5V supply",
      "Jumper wires",
      "Lightweight gate arm",
    ],
    pinAssignments: [
      {
        component: "SG90 servo",
        signal: "Control",
        pin: "D6",
        note: "Power from the external regulated 5V supply and connect grounds together.",
      },
    ],
    concepts: ["Servo angles", "mechanisms", "external power", "common ground"],
    objectives: [
      "Command a servo to two safe target angles.",
      "Explain why the Nano and external supply need a common ground.",
      "Test a lightweight mechanism without stalling the servo.",
    ],
    safetyNotes: [
      "Do not power the servo from the Nano's 5V pin; use the regulated external 5V supply.",
      "Join the supply ground and Nano ground before connecting the D6 signal.",
      "Keep fingers and wires clear of the moving horn and stop if the servo buzzes or stalls.",
    ],
    troubleshooting: [
      {
        problem: "The servo jitters or resets the Nano.",
        guidance: "Confirm external 5V power, common ground, and secure connections; remove any heavy load.",
      },
      {
        problem: "The gate moves the wrong way.",
        guidance: "Swap the open and closed angle values in code instead of forcing the horn.",
      },
    ],
    starterCode: `#include <Servo.h>

const int SERVO_PIN = 6;
Servo gate;

void setup() {
  gate.attach(SERVO_PIN);
}

void loop() {
  gate.write(20);
  delay(1200);
  gate.write(100);
  delay(1200);
}
`,
    steps: createLessonSteps({
      narrative:
        "A servo turns code into a controlled angle. Supplying motor current separately keeps that movement from disturbing the Nano.",
      wiringInstructions: [
        "Disconnect Nano USB and turn off the external 5V supply.",
        "Connect servo power to external 5V and servo ground to supply ground.",
        "Connect the supply ground to Nano GND to make a common reference.",
        "Connect the servo signal lead to D6, then inspect before powering either source.",
      ],
      wiringDiagramAlt:
        "SG90 signal connected to Nano D6, powered by a separate regulated 5V supply whose ground is joined to Nano ground.",
      codePrompt: "Choose safe open and closed angles between 10 and 170 degrees and move between them with a pause.",
      validatorId: "servo-gate-v1",
      validationSuccess: "The servo attaches to D6 and uses two safe angle commands with pauses.",
      quizPrompt: "Why must the external servo supply ground connect to Nano ground?",
      quizChoices: [
        { id: "charge", label: "To charge the Nano" },
        { id: "signal-reference", label: "To give the control signal a shared reference" },
        { id: "faster", label: "To make the sketch compile faster" },
      ],
      correctChoiceId: "signal-reference",
      observationPrompt: "Confirm that the unloaded gate reaches both angles smoothly without buzzing, stalling, or resetting the Nano.",
      completionSummary: "You powered and controlled a moving mechanism safely from code.",
    }),
    migrationStage: "planned",
  }),
  defineLesson({
    schemaVersion: LESSON_SCHEMA_VERSION,
    id: "trail-rover",
    route: "/learn/trail-rover",
    version: 1,
    order: 6,
    title: "Trail Rover",
    shortTitle: "Rover",
    summary: "Combine sensing and motion so a two-wheel rover can stop for obstacles.",
    estimatedMinutes: 90,
    prerequisites: ["servo-gate"],
    hardwareParts: [
      "Arduino Nano-compatible board",
      "USB data cable",
      "TB6612FNG motor driver",
      "Two TT motors",
      "Two wheels and caster",
      "HC-SR04 ultrasonic sensor",
      "Separate motor battery pack",
      "Chassis and jumper wires",
    ],
    pinAssignments: [
      { component: "TB6612FNG", signal: "PWMA", pin: "D3" },
      { component: "TB6612FNG", signal: "AIN1", pin: "D4" },
      { component: "TB6612FNG", signal: "AIN2", pin: "D5" },
      { component: "TB6612FNG", signal: "PWMB", pin: "D6" },
      { component: "TB6612FNG", signal: "BIN1", pin: "D7" },
      { component: "TB6612FNG", signal: "BIN2", pin: "D8" },
      { component: "HC-SR04", signal: "Trigger", pin: "D9" },
      { component: "HC-SR04", signal: "Echo", pin: "D10" },
      { component: "TB6612FNG", signal: "Standby", pin: "D12" },
    ],
    concepts: ["Motor control", "staged movement", "distance sensing", "autonomy"],
    objectives: [
      "Drive two motors through a TB6612FNG instead of from Nano pins.",
      "Test direction and stopping in safe, staged steps.",
      "Combine a distance threshold with motor control for autonomous stopping.",
    ],
    safetyNotes: [
      "Keep the rover raised so its wheels spin freely during the first motor test.",
      "Never power motors from Nano pins; use the separate motor pack through the driver.",
      "Join all grounds, leave the battery off while rewiring, and unplug immediately if any part heats up.",
      "Run floor tests in a clear area away from stairs, pets, hair, and loose cables.",
    ],
    troubleshooting: [
      {
        problem: "One wheel runs backward.",
        guidance: "Power off and swap that motor's two driver output leads, then repeat the raised-wheel test.",
      },
      {
        problem: "Neither motor moves.",
        guidance: "Check battery polarity, common ground, D12 standby HIGH, and the two PWM values.",
      },
      {
        problem: "The rover stops too late.",
        guidance: "Lower its speed and increase the stop threshold before another floor test.",
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

void stopMotors() {
  analogWrite(PWMA, 0);
  analogWrite(PWMB, 0);
}

void driveForward(int speedValue) {
  digitalWrite(AIN1, HIGH);
  digitalWrite(AIN2, LOW);
  digitalWrite(BIN1, HIGH);
  digitalWrite(BIN2, LOW);
  analogWrite(PWMA, speedValue);
  analogWrite(PWMB, speedValue);
}

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  return duration == 0 ? 0 : duration * 0.0343 / 2.0;
}

void setup() {
  pinMode(AIN1, OUTPUT); pinMode(AIN2, OUTPUT);
  pinMode(BIN1, OUTPUT); pinMode(BIN2, OUTPUT);
  pinMode(STANDBY, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT); pinMode(ECHO_PIN, INPUT);
  digitalWrite(STANDBY, HIGH);
  Serial.begin(9600);
}

void loop() {
  float distance = readDistanceCm();
  Serial.println(distance);
  if (distance > 0 && distance < 25) stopMotors();
  else driveForward(120);
  delay(80);
}
`,
    steps: createLessonSteps({
      narrative:
        "The rover combines every earlier idea: outputs drive a motor controller, a sensor reports distance, and conditions choose whether movement is safe.",
      wiringInstructions: [
        "Leave USB and the motor battery disconnected and mount the Nano, driver, sensor, and motors securely.",
        "Wire PWMA D3, AIN1 D4, AIN2 D5, PWMB D6, BIN1 D7, BIN2 D8, and standby D12.",
        "Wire the HC-SR04 trigger to D9 and echo to D10, plus its 5V and ground.",
        "Connect both motors to the driver outputs and the battery pack to motor power with correct polarity.",
        "Join driver, battery, sensor, and Nano grounds, then inspect every rail before applying power.",
      ],
      wiringDiagramAlt:
        "Nano controlling a TB6612FNG on D3 through D8 and D12, two motors on driver outputs, and an HC-SR04 on D9 and D10, with separate motor power and common grounds.",
      codePrompt: "Complete forward, stop, and distance functions so the rover stops at least 25 centimetres from an obstacle.",
      validatorId: "trail-rover-v1",
      validationSuccess: "Motor pins, standby, bounded PWM, sensor timeout, and obstacle-stop condition are present.",
      quizPrompt: "What should happen first when the measured distance crosses the safety threshold?",
      quizChoices: [
        { id: "faster", label: "Increase both motor speeds" },
        { id: "stop", label: "Set both motor PWM outputs to zero" },
        { id: "disconnect-sensor", label: "Ignore the sensor until restart" },
      ],
      correctChoiceId: "stop",
      serialObservation: "Distance readings update while the raised-wheel rover changes from driving to stopped at the selected threshold.",
      observationPrompt: "After raised-wheel tests pass, confirm on a clear floor that the rover stops before a broad obstacle three times in a row.",
      completionSummary: "You combined sensing, decisions, and controlled motion into an autonomous rover.",
    }),
    migrationStage: "planned",
  }),
];

export const lessonCatalog = assertValidLessonCatalog(lessonCatalogSource);

export function findLesson(id: string | undefined): LessonCatalogEntry | undefined {
  return lessonCatalog.find((lesson) => lesson.id === id);
}
