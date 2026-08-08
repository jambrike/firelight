import { describe, expect, it } from "vitest";
import { curriculumLessons } from "../../../shared/curriculum";
import { lessonCatalog } from "./catalog";
import type { LessonSlug } from "./catalog";
import type {
  LessonStep,
} from "./contracts";
import {
  assertValidLessonCatalog,
  LessonCatalogValidationError,
  validateLessonCatalog,
} from "./validation";
import type { ValidatableLessonDefinition } from "./validation";

function validationCodes(lessons: readonly ValidatableLessonDefinition[]) {
  return validateLessonCatalog(lessons).map((item) => item.code);
}

describe("lesson catalog validation", () => {
  it("reports duplicate lesson and step IDs", () => {
    const first = lessonCatalog[0];
    const second = lessonCatalog[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;

    const repeatedStep = {
      ...first.steps[1],
      id: first.steps[0]?.id ?? "meet-the-build",
    } as LessonStep;
    const lessonWithDuplicateStep = {
      ...first,
      steps: [first.steps[0]!, repeatedStep, ...first.steps.slice(2)],
    };
    const duplicateLesson = {
      ...second,
      id: first.id,
      route: first.route,
      title: first.title,
    };

    const codes = validationCodes([lessonWithDuplicateStep, duplicateLesson]);
    expect(codes).toContain("DUPLICATE_LESSON_ID");
    expect(codes).toContain("DUPLICATE_STEP_ID");
  });

  it("checks routes and the shared curriculum schema", () => {
    const first = lessonCatalog[0];
    if (!first) return;

    const invalid = {
      ...first,
      schemaVersion: 2,
      route: "/learn/not-first-spark" as const,
      version: 99,
    };
    const codes = validateLessonCatalog([invalid], [curriculumLessons[0]]).map(
      (item) => item.code,
    );

    expect(codes).toContain("SCHEMA_VERSION_MISMATCH");
    expect(codes).toContain("ROUTE_MISMATCH");
    expect(codes).toContain("CURRICULUM_VERSION_MISMATCH");
  });

  it("reports missing, invalid, and cyclic prerequisites", () => {
    const first = lessonCatalog[0];
    const second = lessonCatalog[1];
    if (!first || !second) return;

    const missing = { ...second, prerequisites: [] };
    expect(validationCodes([first, missing])).toContain("MISSING_PREREQUISITE");

    const unknown = {
      ...second,
      prerequisites: ["unknown-lesson" as LessonSlug],
    };
    expect(validationCodes([first, unknown])).toContain("INVALID_PREREQUISITE");

    const cyclicFirst = { ...first, prerequisites: [second.id] };
    const cyclicSecond = { ...second, prerequisites: [first.id] };
    expect(validationCodes([cyclicFirst, cyclicSecond])).toContain("PREREQUISITE_CYCLE");
  });

  it("reports missing, mistyped, and forward step references", () => {
    const first = lessonCatalog[0];
    if (!first) return;

    const missingReference = {
      ...first,
      steps: first.steps.map((step): LessonStep =>
        step.type === "compile"
          ? { ...step, validationStepId: "missing-validation" }
          : step,
      ),
    };
    expect(validationCodes([missingReference])).toContain("INVALID_STEP_REFERENCE");

    const wrongType = {
      ...first,
      steps: first.steps.map((step): LessonStep =>
        step.type === "compile"
          ? { ...step, validationStepId: "edit-code" }
          : step,
      ),
    };
    expect(validationCodes([wrongType])).toContain("INVALID_STEP_REFERENCE_TYPE");

    const forwardReference = {
      ...first,
      steps: first.steps.map((step): LessonStep =>
        step.type === "code-validation"
          ? { ...step, codeStepId: "connect-board" }
          : step,
      ),
    };
    expect(validationCodes([forwardReference])).toContain("FORWARD_STEP_REFERENCE");
  });

  it("reports unsupported pins and missing accessible labels", () => {
    const first = lessonCatalog[0];
    if (!first) return;

    const invalid = {
      ...first,
      pinAssignments: [
        {
          component: "Invalid test component",
          signal: "Invalid test signal",
          pin: "A7",
        },
      ],
      steps: first.steps.map((step, index): LessonStep => {
        if (index === 0) return { ...step, ariaLabel: "" };
        if (step.type === "wiring") return { ...step, diagramAlt: "" };
        return step;
      }),
    };
    const codes = validationCodes([invalid]);

    expect(codes).toContain("UNSUPPORTED_PIN");
    expect(codes.filter((code) => code === "ACCESSIBLE_LABEL_REQUIRED")).toHaveLength(2);
  });

  it("rejects a serial-check baud that disagrees with the controlled sketches", () => {
    const distance = lessonCatalog.find((lesson) => lesson.id === "distance-scout");
    if (!distance) return;
    const invalid = {
      ...distance,
      steps: distance.steps.map((step): LessonStep =>
        step.type === "serial-check"
          ? ({ ...step, baudRate: 115_200 } as unknown as LessonStep)
          : step,
      ),
    };

    expect(validationCodes([invalid])).toContain("INVALID_SERIAL_BAUD");
  });

  it("throws a diagnostic error from the build/runtime assertion", () => {
    const first = lessonCatalog[0];
    if (!first) return;
    const invalid = { ...first, route: "/learn/wrong" as const };

    expect(() => assertValidLessonCatalog([invalid], [curriculumLessons[0]])).toThrow(
      LessonCatalogValidationError,
    );
  });
});
