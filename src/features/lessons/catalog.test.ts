import { describe, expect, it } from "vitest";
import { findLesson, lessonCatalog, lessonSlugs } from "./catalog";
import { lessonStepTypes } from "./contracts";
import { validateLessonCatalog } from "./validation";

describe("lesson catalog boundary", () => {
  it("contains the six ordered pilot builds with unique IDs", () => {
    expect(lessonCatalog).toHaveLength(6);
    expect(new Set(lessonCatalog.map((lesson) => lesson.id)).size).toBe(6);
    expect(lessonCatalog.map((lesson) => lesson.id)).toEqual(lessonSlugs);
    expect(lessonCatalog.map((lesson) => lesson.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("locks each build to the preceding prerequisite", () => {
    expect(lessonCatalog[0]?.prerequisites).toEqual([]);

    for (let index = 1; index < lessonCatalog.length; index += 1) {
      expect(lessonCatalog[index]?.prerequisites).toEqual([lessonCatalog[index - 1]?.id]);
    }
  });

  it("keeps the approved fixed pin maps", () => {
    expect(findLesson("button-reaction")?.pins.map((pin) => pin.pin)).toContain("D2");
    expect(findLesson("distance-scout")?.pins.map((pin) => pin.pin)).toEqual(["D9", "D10"]);
    expect(findLesson("servo-gate")?.pins.map((pin) => pin.pin)).toEqual(["D6"]);
    expect(findLesson("trail-rover")?.pins.map((pin) => pin.pin)).toEqual([
      "D3",
      "D4",
      "D5",
      "D6",
      "D7",
      "D8",
      "D9",
      "D10",
      "D12",
    ]);
  });

  it("is a valid structured catalog with every supported step type", () => {
    expect(validateLessonCatalog(lessonCatalog)).toEqual([]);

    const catalogStepTypes = new Set(
      lessonCatalog.flatMap((lesson) => lesson.steps.map((step) => step.type)),
    );
    expect([...catalogStepTypes].sort()).toEqual([...lessonStepTypes].sort());

    for (const lesson of lessonCatalog) {
      expect(lesson.route).toBe(`/learn/${lesson.id}`);
      expect(lesson.objectives.length).toBeGreaterThan(0);
      expect(lesson.safetyNotes.length).toBeGreaterThan(0);
      expect(lesson.troubleshooting.length).toBeGreaterThan(0);
      expect(lesson.starterCode.trim()).not.toBe("");
      expect(lesson.steps.at(-1)?.type).toBe("completion");
    }
  });

  it("keeps compatibility aliases on the canonical content arrays", () => {
    for (const lesson of lessonCatalog) {
      expect(lesson.parts).toBe(lesson.hardwareParts);
      expect(lesson.pins).toBe(lesson.pinAssignments);
    }
  });
});
