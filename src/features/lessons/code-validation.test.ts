import { describe, expect, it } from "vitest";
import { findLesson } from "./catalog";
import {
  validateArduinoSourcePolicy,
  validateLessonCode,
} from "./code-validation";

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

  it.each([
    ['asm(".incbin \\"/proc/1/environ\\"");', "Inline assembly"],
    ['#include "/etc/passwd"', "Only the lesson's"],
    ["#pragma GCC poison setup", "Only the lesson's"],
    ['const char *path = "../private";', "cannot reference files"],
    ["__attribute__((section(\".text\"))) int value;", "Compiler-specific"],
    ['a\\\nsm(".inc\\\nbin \\"/pr\\\noc/1/environ\\"");', "Line splicing"],
    ['a\\\rsm(".incbin \\"/proc/1/environ\\"");', "Line splicing"],
    ["/**/ %:include <Servo.h>", "Line splicing"],
    ["/**/ #include </etc/passwd>", "Only the lesson's"],
    ['const char *fake = R"(pinMode(LED_BUILTIN, OUTPUT))";', "Raw string"],
  ])("rejects compiler-controlled source feature %s", (source, expectedMessage) => {
    expect(validateArduinoSourcePolicy(source).join(" ")).toContain(expectedMessage);
  });

  it("allows only the repository Servo include", () => {
    expect(validateArduinoSourcePolicy("#include <Servo.h>\nvoid setup() {}"))
      .toEqual([]);
  });

  it("does not count lesson requirements placed only in comments or literals", () => {
    const noOp = `
      void setup() {}
      void loop() {
        // pinMode(LED_BUILTIN, OUTPUT);
        /* digitalWrite(LED_BUILTIN, HIGH);
           digitalWrite(LED_BUILTIN, LOW); */
        const char *pretend = "delay(1000)";
      }
    `;

    const result = validateLessonCode("first-spark-v1", noOp);
    expect(result.valid).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([
      "Configure LED_BUILTIN as an OUTPUT.",
      "Turn the built-in LED on with digitalWrite().",
      "Turn the built-in LED off with digitalWrite().",
      "Add a numeric delay between changes.",
    ]));
  });

  it("keeps comment-like text inside a string from exposing later fake calls", () => {
    const noOp = `
      void setup() {}
      void loop() {
        const char *pretend = "not // pinMode(LED_BUILTIN, OUTPUT)";
        const char marker = '/';
      }
    `;

    expect(validateLessonCode("first-spark-v1", noOp).valid).toBe(false);
  });
});
