import { describe, expect, it } from "vitest";
import { lessonCatalog } from "./catalog";
import {
  deriveCompletedLessonIds,
  deriveCurriculumProgress,
  deriveLessonAchievements,
  deriveLessonAccessState,
  deriveNextLesson,
  derivePrerequisiteState,
  getCurrentLessonProgress,
} from "./derivations";
import type { LessonProgressView, LessonProgressViewStatus } from "./derivations";

function saved(
  lessonId: string,
  status: LessonProgressViewStatus,
  percentage: number,
  lessonVersion = 1,
): LessonProgressView {
  return { lessonId, lessonVersion, status, percentage };
}

describe("lesson catalog derivations", () => {
  it("unlocks lessons only after current-version prerequisites are complete", () => {
    const first = lessonCatalog[0];
    const second = lessonCatalog[1];
    if (!first || !second) return;

    expect(deriveLessonAccessState(first, [])).toBe("available");
    expect(deriveLessonAccessState(second, [])).toBe("locked");
    expect(
      derivePrerequisiteState(second, [saved("first-spark", "completed", 100, 0)]),
    ).toMatchObject({ satisfied: false, missing: ["first-spark"] });

    const progress = [saved("first-spark", "completed", 100)];
    expect(derivePrerequisiteState(second, progress)).toEqual({
      satisfied: true,
      required: ["first-spark"],
      completed: ["first-spark"],
      missing: [],
    });
    expect(deriveLessonAccessState(first, progress)).toBe("completed");
    expect(deriveLessonAccessState(second, progress)).toBe("available");
  });

  it("derives the earliest unlocked lesson to resume", () => {
    expect(deriveNextLesson([])?.id).toBe("first-spark");

    const progress = [
      saved("first-spark", "completed", 100),
      saved("morse-name", "in_progress", 40),
    ];
    expect(deriveNextLesson(progress)?.id).toBe("morse-name");

    const allComplete = lessonCatalog.map((lesson) =>
      saved(lesson.id, "completed", 100, lesson.version),
    );
    expect(deriveNextLesson(allComplete)).toBeNull();
  });

  it("derives completion and aggregate progress from current versions", () => {
    const progress = [
      saved("first-spark", "completed", 15),
      saved("morse-name", "in_progress", 50),
      saved("morse-name", "in_progress", 25),
      saved("button-reaction", "completed", 100, 0),
      saved("distance-scout", "in_progress", Number.NaN),
    ];

    expect([...deriveCompletedLessonIds(progress)]).toEqual(["first-spark"]);
    expect(deriveCurriculumProgress(progress)).toEqual({
      completedLessons: 1,
      totalLessons: 6,
      percentage: 25,
    });
  });

  it("returns the canonical current-version record without dropping caller fields", () => {
    const first = lessonCatalog[0];
    if (!first) return;
    const progress = [
      {
        ...saved("first-spark", "completed", 100, 0),
        currentStep: "old-step",
        revision: 8,
      },
      {
        ...saved("first-spark", "in_progress", 35),
        currentStep: "edit-code",
        revision: 9,
      },
      {
        ...saved("first-spark", "in_progress", 20),
        currentStep: "compile-sketch",
        revision: 10,
      },
    ];

    expect(getCurrentLessonProgress(first, progress)).toMatchObject({
      lessonVersion: 1,
      currentStep: "compile-sketch",
      percentage: 20,
      revision: 10,
    });
  });

  it("derives current-version achievements and the full-trail badge", () => {
    expect(deriveLessonAchievements([]).map((achievement) => achievement.earned)).toEqual([
      false,
      false,
      false,
    ]);

    const firstTwo = [
      saved("first-spark", "completed", 100),
      saved("morse-name", "completed", 100),
      saved("trail-rover", "completed", 100, 0),
    ];
    expect(deriveLessonAchievements(firstTwo)).toEqual([
      { id: "first-upload", label: "First Upload", earned: true },
      { id: "name-signal", label: "Name Signal", earned: true },
      { id: "trail-complete", label: "Trail Complete", earned: false },
    ]);

    const allComplete = lessonCatalog.map((lesson) =>
      saved(lesson.id, "completed", 100, lesson.version),
    );
    expect(deriveLessonAchievements(allComplete).at(-1)?.earned).toBe(true);
  });

  it("handles an empty catalog without dividing by zero", () => {
    expect(deriveCurriculumProgress([], [])).toEqual({
      completedLessons: 0,
      totalLessons: 0,
      percentage: 0,
    });
    expect(deriveNextLesson([], [])).toBeNull();
  });
});
