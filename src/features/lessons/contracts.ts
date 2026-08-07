export const LESSON_SCHEMA_VERSION = 1 as const;

export const lessonStepTypes = [
  "narrative",
  "wiring",
  "code-edit",
  "code-validation",
  "quiz",
  "compile",
  "connect",
  "upload",
  "serial-check",
  "manual-observation",
  "completion",
] as const;

export type LessonStepType = (typeof lessonStepTypes)[number];

export const supportedArduinoPins = [
  "LED_BUILTIN",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "D8",
  "D9",
  "D10",
  "D12",
] as const;

export type SupportedArduinoPin = (typeof supportedArduinoPins)[number];

interface LessonStepBase {
  readonly id: string;
  readonly type: LessonStepType;
  readonly title: string;
  /** A concise announcement for the workspace step navigation. */
  readonly ariaLabel: string;
}

export interface NarrativeStep extends LessonStepBase {
  readonly type: "narrative";
  readonly body: string;
}

export interface WiringStep extends LessonStepBase {
  readonly type: "wiring";
  readonly instructions: readonly string[];
  /** Text alternative for the wiring diagram supplied by the lesson renderer. */
  readonly diagramAlt: string;
}

export interface CodeEditStep extends LessonStepBase {
  readonly type: "code-edit";
  readonly prompt: string;
}

export interface CodeValidationStep extends LessonStepBase {
  readonly type: "code-validation";
  readonly codeStepId: string;
  readonly validatorId: string;
  readonly successMessage: string;
}

export interface QuizChoice {
  readonly id: string;
  readonly label: string;
}

export interface QuizStep extends LessonStepBase {
  readonly type: "quiz";
  readonly prompt: string;
  readonly choices: readonly QuizChoice[];
  readonly correctChoiceId: string;
}

export interface CompileStep extends LessonStepBase {
  readonly type: "compile";
  readonly validationStepId: string;
}

export interface ConnectStep extends LessonStepBase {
  readonly type: "connect";
}

export interface UploadStep extends LessonStepBase {
  readonly type: "upload";
  readonly compileStepId: string;
  readonly connectStepId: string;
}

export interface SerialCheckStep extends LessonStepBase {
  readonly type: "serial-check";
  readonly uploadStepId: string;
  readonly expectedObservation: string;
}

export interface ManualObservationStep extends LessonStepBase {
  readonly type: "manual-observation";
  readonly uploadStepId: string;
  readonly prompt: string;
}

export interface CompletionStep extends LessonStepBase {
  readonly type: "completion";
  readonly requiredStepIds: readonly string[];
  readonly summary: string;
}

export type LessonStep =
  | NarrativeStep
  | WiringStep
  | CodeEditStep
  | CodeValidationStep
  | QuizStep
  | CompileStep
  | ConnectStep
  | UploadStep
  | SerialCheckStep
  | ManualObservationStep
  | CompletionStep;

export interface LessonPinAssignment {
  readonly component: string;
  readonly signal: string;
  readonly pin: SupportedArduinoPin;
  readonly note?: string;
}

export interface LessonTroubleshootingItem {
  readonly problem: string;
  readonly guidance: string;
}

export interface LessonDefinition<LessonId extends string = string> {
  readonly schemaVersion: typeof LESSON_SCHEMA_VERSION;
  readonly id: LessonId;
  readonly route: `/learn/${string}`;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly estimatedMinutes: number;
  readonly prerequisites: readonly LessonId[];
  readonly hardwareParts: readonly string[];
  readonly pinAssignments: readonly LessonPinAssignment[];
  readonly objectives: readonly string[];
  readonly safetyNotes: readonly string[];
  readonly troubleshooting: readonly LessonTroubleshootingItem[];
  readonly starterCode: string;
  readonly steps: readonly LessonStep[];
}
