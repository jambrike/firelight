import { curriculumLessons } from "../../../shared/curriculum";
import {
  LESSON_SCHEMA_VERSION,
  supportedArduinoPins,
} from "./contracts";
import type {
  LessonDefinition,
  LessonPinAssignment,
  LessonStep,
  LessonStepType,
} from "./contracts";

export const lessonCatalogValidationCodes = [
  "DUPLICATE_LESSON_ID",
  "DUPLICATE_STEP_ID",
  "ROUTE_MISMATCH",
  "SCHEMA_VERSION_MISMATCH",
  "CURRICULUM_MISSING_LESSON",
  "CURRICULUM_UNEXPECTED_LESSON",
  "CURRICULUM_ORDER_MISMATCH",
  "CURRICULUM_VERSION_MISMATCH",
  "CURRICULUM_TITLE_MISMATCH",
  "MISSING_PREREQUISITE",
  "DUPLICATE_PREREQUISITE",
  "INVALID_PREREQUISITE",
  "INVALID_PREREQUISITE_ORDER",
  "PREREQUISITE_CYCLE",
  "INVALID_STEP_REFERENCE",
  "INVALID_STEP_REFERENCE_TYPE",
  "FORWARD_STEP_REFERENCE",
  "DUPLICATE_QUIZ_CHOICE",
  "INVALID_QUIZ_CHOICE_REFERENCE",
  "UNSUPPORTED_PIN",
  "ACCESSIBLE_LABEL_REQUIRED",
] as const;

export type LessonCatalogValidationCode =
  (typeof lessonCatalogValidationCodes)[number];

export interface LessonCatalogValidationIssue {
  readonly code: LessonCatalogValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface CurriculumSchemaEntry {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

export interface ValidatableLessonDefinition
  extends Omit<LessonDefinition, "schemaVersion" | "route" | "pinAssignments"> {
  readonly schemaVersion: number;
  readonly route: string;
  readonly pinAssignments: readonly (
    Omit<LessonPinAssignment, "pin"> & { readonly pin: string }
  )[];
}

interface StepReference {
  readonly field: string;
  readonly id: string;
  readonly expectedType?: LessonStepType;
}

const supportedPinSet: ReadonlySet<string> = new Set(supportedArduinoPins);

function stepReferences(step: LessonStep): readonly StepReference[] {
  switch (step.type) {
    case "code-validation":
      return [{ field: "codeStepId", id: step.codeStepId, expectedType: "code-edit" }];
    case "compile":
      return [
        {
          field: "validationStepId",
          id: step.validationStepId,
          expectedType: "code-validation",
        },
      ];
    case "upload":
      return [
        { field: "compileStepId", id: step.compileStepId, expectedType: "compile" },
        { field: "connectStepId", id: step.connectStepId, expectedType: "connect" },
      ];
    case "serial-check":
    case "manual-observation":
      return [{ field: "uploadStepId", id: step.uploadStepId, expectedType: "upload" }];
    case "completion":
      return step.requiredStepIds.map((id, index) => ({
        field: `requiredStepIds[${String(index)}]`,
        id,
      }));
    case "narrative":
    case "wiring":
    case "code-edit":
    case "quiz":
    case "connect":
      return [];
  }
}

function issue(
  issues: LessonCatalogValidationIssue[],
  code: LessonCatalogValidationCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function validateAccessibleLabels(
  lesson: ValidatableLessonDefinition,
  issues: LessonCatalogValidationIssue[],
): void {
  lesson.steps.forEach((step, stepIndex) => {
    const path = `lessons[${lesson.id}].steps[${String(stepIndex)}]`;

    if (step.ariaLabel.trim().length === 0) {
      issue(
        issues,
        "ACCESSIBLE_LABEL_REQUIRED",
        `${path}.ariaLabel`,
        `Step "${step.id}" needs a non-empty accessible label.`,
      );
    }

    if (step.type === "wiring" && step.diagramAlt.trim().length === 0) {
      issue(
        issues,
        "ACCESSIBLE_LABEL_REQUIRED",
        `${path}.diagramAlt`,
        `Wiring step "${step.id}" needs diagram alternative text.`,
      );
    }

    if (step.type === "quiz") {
      step.choices.forEach((choice, choiceIndex) => {
        if (choice.label.trim().length === 0) {
          issue(
            issues,
            "ACCESSIBLE_LABEL_REQUIRED",
            `${path}.choices[${String(choiceIndex)}].label`,
            `Quiz choice "${choice.id}" needs a visible accessible label.`,
          );
        }
      });
    }
  });
}

function validateStepGraph(
  lesson: ValidatableLessonDefinition,
  issues: LessonCatalogValidationIssue[],
): void {
  const stepIndexes = new Map<string, number>();

  lesson.steps.forEach((step, index) => {
    if (stepIndexes.has(step.id)) {
      issue(
        issues,
        "DUPLICATE_STEP_ID",
        `lessons[${lesson.id}].steps[${String(index)}].id`,
        `Lesson "${lesson.id}" repeats step ID "${step.id}".`,
      );
      return;
    }

    stepIndexes.set(step.id, index);
  });

  lesson.steps.forEach((step, index) => {
    const path = `lessons[${lesson.id}].steps[${String(index)}]`;

    for (const reference of stepReferences(step)) {
      const targetIndex = stepIndexes.get(reference.id);

      if (targetIndex === undefined) {
        issue(
          issues,
          "INVALID_STEP_REFERENCE",
          `${path}.${reference.field}`,
          `Step "${step.id}" references missing step "${reference.id}".`,
        );
        continue;
      }

      const target = lesson.steps[targetIndex];
      if (reference.expectedType && target?.type !== reference.expectedType) {
        issue(
          issues,
          "INVALID_STEP_REFERENCE_TYPE",
          `${path}.${reference.field}`,
          `Step "${step.id}" expects "${reference.id}" to be a ${reference.expectedType} step.`,
        );
      }

      if (targetIndex >= index) {
        issue(
          issues,
          "FORWARD_STEP_REFERENCE",
          `${path}.${reference.field}`,
          `Step "${step.id}" must reference an earlier step, not "${reference.id}".`,
        );
      }
    }

    if (step.type === "quiz") {
      const choiceIds = new Set<string>();
      for (const choice of step.choices) {
        if (choiceIds.has(choice.id)) {
          issue(
            issues,
            "DUPLICATE_QUIZ_CHOICE",
            `${path}.choices`,
            `Quiz step "${step.id}" repeats choice ID "${choice.id}".`,
          );
        }
        choiceIds.add(choice.id);
      }

      if (!choiceIds.has(step.correctChoiceId)) {
        issue(
          issues,
          "INVALID_QUIZ_CHOICE_REFERENCE",
          `${path}.correctChoiceId`,
          `Quiz step "${step.id}" has no choice "${step.correctChoiceId}".`,
        );
      }
    }
  });
}

function validatePrerequisiteCycles(
  lessons: readonly ValidatableLessonDefinition[],
  issues: LessonCatalogValidationIssue[],
): void {
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const reported = new Set<string>();

  function visit(id: string, path: readonly string[]): void {
    if (visited.has(id)) return;

    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(Math.max(0, cycleStart)), id];
      const cycleKey = [...new Set(cycle)].sort().join("|");
      if (!reported.has(cycleKey)) {
        reported.add(cycleKey);
        issue(
          issues,
          "PREREQUISITE_CYCLE",
          `lessons[${id}].prerequisites`,
          `Prerequisite cycle detected: ${cycle.join(" -> ")}.`,
        );
      }
      return;
    }

    const lesson = lessonsById.get(id);
    if (!lesson) return;

    visiting.add(id);
    for (const prerequisite of lesson.prerequisites) {
      if (lessonsById.has(prerequisite)) {
        visit(prerequisite, [...path, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of lessonsById.keys()) visit(id, []);
}

/**
 * Validates both author-controlled lesson content and its shared route/API schema.
 * The catalog invokes this during module initialization, so these checks also run
 * whenever Vite evaluates the catalog for a production build.
 */
export function validateLessonCatalog(
  lessons: readonly ValidatableLessonDefinition[],
  schema: readonly CurriculumSchemaEntry[] = curriculumLessons,
): readonly LessonCatalogValidationIssue[] {
  const issues: LessonCatalogValidationIssue[] = [];
  const lessonIndexes = new Map<string, number>();
  const schemaIndexes = new Map(schema.map((entry, index) => [entry.id, index]));

  lessons.forEach((lesson, index) => {
    const id = lesson.id;
    if (lessonIndexes.has(id)) {
      issue(
        issues,
        "DUPLICATE_LESSON_ID",
        `lessons[${String(index)}].id`,
        `Lesson ID "${id}" appears more than once.`,
      );
    } else {
      lessonIndexes.set(id, index);
    }

    if (lesson.schemaVersion !== LESSON_SCHEMA_VERSION) {
      issue(
        issues,
        "SCHEMA_VERSION_MISMATCH",
        `lessons[${id}].schemaVersion`,
        `Lesson "${id}" uses unsupported schema version ${String(lesson.schemaVersion)}.`,
      );
    }

    if (lesson.route !== `/learn/${id}`) {
      issue(
        issues,
        "ROUTE_MISMATCH",
        `lessons[${id}].route`,
        `Lesson "${id}" must use route "/learn/${id}".`,
      );
    }

    const schemaEntry = schema.find((entry) => entry.id === id);
    if (!schemaEntry) {
      issue(
        issues,
        "CURRICULUM_UNEXPECTED_LESSON",
        `lessons[${id}].id`,
        `Lesson "${id}" is not declared in the shared curriculum schema.`,
      );
    } else {
      if (schemaIndexes.get(id) !== index) {
        issue(
          issues,
          "CURRICULUM_ORDER_MISMATCH",
          `lessons[${id}].id`,
          `Lesson "${id}" is not in shared curriculum order.`,
        );
      }
      if (schemaEntry.version !== lesson.version) {
        issue(
          issues,
          "CURRICULUM_VERSION_MISMATCH",
          `lessons[${id}].version`,
          `Lesson "${id}" version does not match the shared curriculum schema.`,
        );
      }
      if (schemaEntry.title !== lesson.title) {
        issue(
          issues,
          "CURRICULUM_TITLE_MISMATCH",
          `lessons[${id}].title`,
          `Lesson "${id}" title does not match the shared curriculum schema.`,
        );
      }
    }

    lesson.pinAssignments.forEach((assignment, pinIndex) => {
      if (!supportedPinSet.has(assignment.pin)) {
        issue(
          issues,
          "UNSUPPORTED_PIN",
          `lessons[${id}].pinAssignments[${String(pinIndex)}].pin`,
          `Lesson "${id}" assigns unsupported pin "${assignment.pin}".`,
        );
      }
    });

    const prerequisiteIds = new Set<string>();
    for (const prerequisite of lesson.prerequisites) {
      const prerequisiteId = prerequisite;
      if (prerequisiteIds.has(prerequisiteId)) {
        issue(
          issues,
          "DUPLICATE_PREREQUISITE",
          `lessons[${id}].prerequisites`,
          `Lesson "${id}" repeats prerequisite "${prerequisiteId}".`,
        );
      }
      prerequisiteIds.add(prerequisiteId);

      const prerequisiteIndex = lessonIndexes.get(prerequisiteId)
        ?? lessons.findIndex((candidate) => candidate.id === prerequisiteId);
      if (prerequisiteIndex < 0) {
        issue(
          issues,
          "INVALID_PREREQUISITE",
          `lessons[${id}].prerequisites`,
          `Lesson "${id}" references missing prerequisite "${prerequisiteId}".`,
        );
      } else if (prerequisiteIndex >= index) {
        issue(
          issues,
          "INVALID_PREREQUISITE_ORDER",
          `lessons[${id}].prerequisites`,
          `Lesson "${id}" prerequisite "${prerequisiteId}" must appear earlier.`,
        );
      }
    }

    const precedingSchemaEntry = schema[index - 1];
    if (precedingSchemaEntry && !prerequisiteIds.has(precedingSchemaEntry.id)) {
      issue(
        issues,
        "MISSING_PREREQUISITE",
        `lessons[${id}].prerequisites`,
        `Lesson "${id}" must require preceding lesson "${precedingSchemaEntry.id}".`,
      );
    }

    validateAccessibleLabels(lesson, issues);
    validateStepGraph(lesson, issues);
  });

  for (const schemaEntry of schema) {
    if (!lessonIndexes.has(schemaEntry.id)) {
      issue(
        issues,
        "CURRICULUM_MISSING_LESSON",
        "lessons",
        `Shared curriculum lesson "${schemaEntry.id}" is missing from the catalog.`,
      );
    }
  }

  validatePrerequisiteCycles(lessons, issues);
  return issues;
}

export class LessonCatalogValidationError extends Error {
  readonly issues: readonly LessonCatalogValidationIssue[];

  constructor(issues: readonly LessonCatalogValidationIssue[]) {
    const details = issues
      .map((item) => `${item.code} at ${item.path}: ${item.message}`)
      .join("\n");
    super(`Lesson catalog validation failed with ${String(issues.length)} issue(s).\n${details}`);
    this.name = "LessonCatalogValidationError";
    this.issues = issues;
  }
}

export function assertValidLessonCatalog<T extends readonly LessonDefinition[]>(
  lessons: T,
  schema: readonly CurriculumSchemaEntry[] = curriculumLessons,
): T {
  const issues = validateLessonCatalog(lessons, schema);
  if (issues.length > 0) throw new LessonCatalogValidationError(issues);
  return lessons;
}
