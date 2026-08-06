import type { LessonPinAssignment } from "./contracts";

export const lessonSlugs = [
  "first-spark",
  "morse-name",
  "button-reaction",
  "distance-scout",
  "servo-gate",
  "trail-rover",
] as const;

export type LessonSlug = (typeof lessonSlugs)[number];
export type LessonMigrationStage = "prototype-ready" | "planned";

export interface LessonCatalogEntry {
  readonly id: LessonSlug;
  readonly order: number;
  readonly title: string;
  readonly shortTitle: string;
  readonly summary: string;
  readonly estimatedMinutes: number;
  readonly concepts: readonly string[];
  readonly parts: readonly string[];
  readonly pins: readonly LessonPinAssignment[];
  readonly prerequisites: readonly LessonSlug[];
  readonly migrationStage: LessonMigrationStage;
}

export const lessonCatalog = [
  {
    id: "first-spark",
    order: 1,
    title: "First Spark",
    shortTitle: "Blink",
    summary: "Wake the built-in LED and send your first sketch to a real Nano.",
    estimatedMinutes: 30,
    concepts: ["Outputs", "setup()", "loop()", "compile and upload"],
    parts: ["Arduino Nano-compatible board", "USB data cable"],
    pins: [
      {
        component: "Built-in LED",
        signal: "Output",
        pin: "LED_BUILTIN",
        note: "No breadboard wiring required.",
      },
    ],
    prerequisites: [],
    migrationStage: "prototype-ready",
  },
  {
    id: "morse-name",
    order: 2,
    title: "Morse Name",
    shortTitle: "Morse",
    summary: "Turn your name into a tiny light signal using functions and timing.",
    estimatedMinutes: 40,
    concepts: ["Functions", "timing", "patterns", "personalized code"],
    parts: ["Arduino Nano-compatible board", "USB data cable"],
    pins: [
      {
        component: "Built-in LED",
        signal: "Output",
        pin: "LED_BUILTIN",
      },
    ],
    prerequisites: ["first-spark"],
    migrationStage: "prototype-ready",
  },
  {
    id: "button-reaction",
    order: 3,
    title: "Button Reaction",
    shortTitle: "Button",
    summary: "Build a reaction timer and let a pushbutton change what the code does.",
    estimatedMinutes: 50,
    concepts: ["INPUT_PULLUP", "conditions", "state", "elapsed time"],
    parts: ["Pushbutton", "breadboard", "jumper wires"],
    pins: [
      {
        component: "Pushbutton",
        signal: "Input",
        pin: "D2",
        note: "Wire to ground and configure INPUT_PULLUP.",
      },
    ],
    prerequisites: ["morse-name"],
    migrationStage: "planned",
  },
  {
    id: "distance-scout",
    order: 4,
    title: "Distance Scout",
    shortTitle: "Distance",
    summary: "Measure the world in front of your build and inspect live serial values.",
    estimatedMinutes: 55,
    concepts: ["Ultrasonic sensing", "Serial", "thresholds", "calibration"],
    parts: ["HC-SR04", "breadboard", "jumper wires"],
    pins: [
      { component: "HC-SR04", signal: "Trigger", pin: "D9" },
      { component: "HC-SR04", signal: "Echo", pin: "D10" },
    ],
    prerequisites: ["button-reaction"],
    migrationStage: "planned",
  },
  {
    id: "servo-gate",
    order: 5,
    title: "Servo Gate",
    shortTitle: "Servo",
    summary: "Move a small gate to precise angles and learn safe servo power habits.",
    estimatedMinutes: 55,
    concepts: ["Servo angles", "mechanisms", "external power", "common ground"],
    parts: ["SG90 servo", "external regulated 5V supply", "jumper wires"],
    pins: [
      {
        component: "SG90 servo",
        signal: "Control",
        pin: "D6",
        note: "Power externally and connect grounds together.",
      },
    ],
    prerequisites: ["distance-scout"],
    migrationStage: "planned",
  },
  {
    id: "trail-rover",
    order: 6,
    title: "Trail Rover",
    shortTitle: "Rover",
    summary: "Combine sensing and motion so a two-wheel rover can stop for obstacles.",
    estimatedMinutes: 90,
    concepts: ["Motor control", "staged movement", "distance sensing", "autonomy"],
    parts: [
      "TB6612FNG motor driver",
      "two TT motors",
      "wheels and caster",
      "HC-SR04",
      "separate motor battery pack",
    ],
    pins: [
      { component: "TB6612FNG", signal: "PWMA", pin: "D3" },
      { component: "TB6612FNG", signal: "AIN1 / AIN2", pin: "D4 / D5" },
      { component: "TB6612FNG", signal: "PWMB", pin: "D6" },
      { component: "TB6612FNG", signal: "BIN1 / BIN2", pin: "D7 / D8" },
      { component: "HC-SR04", signal: "Trigger / Echo", pin: "D9 / D10" },
      { component: "TB6612FNG", signal: "Standby", pin: "D12" },
    ],
    prerequisites: ["servo-gate"],
    migrationStage: "planned",
  },
] as const satisfies readonly LessonCatalogEntry[];

export function findLesson(id: string | undefined): LessonCatalogEntry | undefined {
  return lessonCatalog.find((lesson) => lesson.id === id);
}
