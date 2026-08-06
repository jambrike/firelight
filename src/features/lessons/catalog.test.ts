import { describe, expect, it } from "vitest";
import { findLesson, lessonCatalog, lessonSlugs } from "./catalog";

describe("lesson catalog boundary", () => {
  it("contains the six ordered pilot builds with unique IDs", () => {
    expect(lessonCatalog).toHaveLength(6);
    expect(new Set(lessonCatalog.map((lesson) => lesson.id)).size).toBe(6);
    expect(lessonCatalog.map((lesson) => lesson.id)).toEqual(lessonSlugs);
    expect(lessonCatalog.map((lesson) => lesson.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("locks each build to the preceding prerequisite", () => {
    expect(lessonCatalog[0].prerequisites).toEqual([]);

    for (let index = 1; index < lessonCatalog.length; index += 1) {
      expect(lessonCatalog[index]?.prerequisites).toEqual([lessonCatalog[index - 1]?.id]);
    }
  });

  it("keeps the approved fixed pin maps", () => {
    expect(findLesson("button-reaction")?.pins.map((pin) => pin.pin)).toContain("D2");
    expect(findLesson("distance-scout")?.pins.map((pin) => pin.pin)).toEqual(["D9", "D10"]);
    expect(findLesson("servo-gate")?.pins.map((pin) => pin.pin)).toEqual(["D6"]);
    expect(findLesson("trail-rover")?.pins.at(-1)?.pin).toBe("D12");
  });
});
