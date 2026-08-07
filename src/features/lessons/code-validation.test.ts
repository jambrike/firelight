import { describe, expect, it } from "vitest";
import { findLesson } from "./catalog";
import { validateLessonCode } from "./code-validation";

describe("lesson code validation", () => {
  it.each([
    ["first-spark", "first-spark-v1"],
    ["morse-name", "morse-name-v1"],
    ["button-reaction", "button-reaction-v1"],
    ["distance-scout", "distance-scout-v1"],
    ["servo-gate", "servo-gate-v1"],
    ["trail-rover", "trail-rover-v1"],
  ] as const)("accepts the %s structured shell", (lessonId, validatorId) => {
    const lesson = findLesson(lessonId);
    expect(lesson).toBeDefined();
    expect(validateLessonCode(validatorId, lesson!.starterCode).valid).toBe(true);
  });

  it("returns actionable feedback instead of a boolean-only failure", () => {
    const result = validateLessonCode("first-spark-v1", "void setup() {}\nvoid loop() {}");
    expect(result.valid).toBe(false);
    expect(result.messages).toContain("Configure LED_BUILTIN as an OUTPUT.");
    expect(result.messages.length).toBeGreaterThan(1);
  });
});
