export type LessonStepType =
  | "narrative"
  | "wiring"
  | "code-edit"
  | "code-validation"
  | "quiz"
  | "compile"
  | "connect"
  | "upload"
  | "serial-check"
  | "manual-observation"
  | "completion";

interface LessonStepBase {
  readonly id: string;
  readonly type: LessonStepType;
  readonly title: string;
  readonly ariaLabel: string;
}

export interface NarrativeStep extends LessonStepBase {
  readonly type: "narrative";
  readonly body: string;
}

export interface WiringStep extends LessonStepBase {
  readonly type: "wiring";
  readonly instructions: readonly string[];
  readonly diagramAlt: string;
}

export interface CodeEditStep extends LessonStepBase {
  readonly type: "code-edit";
  readonly prompt: string;
}

export interface CodeValidationStep extends LessonStepBase {
  readonly type: "code-validation";
  readonly validatorId: string;
  readonly successMessage: string;
}

export interface QuizStep extends LessonStepBase {
  readonly type: "quiz";
  readonly prompt: string;
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly correctChoiceId: string;
}

export interface CompileStep extends LessonStepBase {
  readonly type: "compile";
}

export interface ConnectStep extends LessonStepBase {
  readonly type: "connect";
}

export interface UploadStep extends LessonStepBase {
  readonly type: "upload";
}

export interface SerialCheckStep extends LessonStepBase {
  readonly type: "serial-check";
  readonly expectedObservation: string;
}

export interface ManualObservationStep extends LessonStepBase {
  readonly type: "manual-observation";
  readonly prompt: string;
}

export interface CompletionStep extends LessonStepBase {
  readonly type: "completion";
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
  readonly pin: string;
  readonly note?: string;
}

export interface LessonDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly estimatedMinutes: number;
  readonly prerequisites: readonly string[];
  readonly hardwareParts: readonly string[];
  readonly pinAssignments: readonly LessonPinAssignment[];
  readonly objectives: readonly string[];
  readonly starterCode: string;
  readonly steps: readonly LessonStep[];
}
