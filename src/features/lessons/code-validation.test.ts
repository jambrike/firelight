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
    expect(result.messages).toContain("Configure LED_BUILTIN as an OUTPUT inside setup().");
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
      "Configure LED_BUILTIN as an OUTPUT inside setup().",
      "Set BLINK_MS to a whole number from 200 through 1500.",
      "In loop(), turn LED_BUILTIN HIGH, wait BLINK_MS, turn it LOW, then wait the same BLINK_MS.",
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

describe("builds one through three semantic checks", () => {
  it("rejects a First Spark interval outside the authored safe range", () => {
    const source = findLesson("first-spark")!.starterCode.replace(
      "BLINK_MS = 500",
      "BLINK_MS = 1501",
    );

    const result = validateLessonCode("first-spark-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages.join(" ")).toContain("200 through 1500");
  });

  it("requires First Spark setup and ordered matching delays in loop", () => {
    const source = findLesson("first-spark")!.starterCode
      .replace("  pinMode(LED_BUILTIN, OUTPUT);\n", "")
      .replace(
        "void loop() {\n",
        "void loop() {\n  pinMode(LED_BUILTIN, OUTPUT);\n",
      )
      .replace(
        "digitalWrite(LED_BUILTIN, LOW);\n  delay(BLINK_MS);",
        "digitalWrite(LED_BUILTIN, LOW);\n  delay(700);",
      );

    const result = validateLessonCode("first-spark-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([
      "Configure LED_BUILTIN as an OUTPUT inside setup().",
      "In loop(), turn LED_BUILTIN HIGH, wait BLINK_MS, turn it LOW, then wait the same BLINK_MS.",
    ]));
  });

  it("rejects a First Spark sequence made unreachable by an early return", () => {
    const source = findLesson("first-spark")!.starterCode.replace(
      "void loop() {",
      "void loop() {\n  return;",
    );

    expect(validateLessonCode("first-spark-v1", source).valid).toBe(false);
  });

  it("rejects Morse timing near misses instead of accepting helper names alone", () => {
    const source = findLesson("morse-name")!.starterCode
      .replace("pulse(3);", "pulse(2);")
      .replace("delay(UNIT_MS * 2);", "delay(UNIT_MS * 3);")
      .replaceAll("delay(UNIT_MS * 6);", "delay(UNIT_MS * 7);");

    const result = validateLessonCode("morse-name-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages.join(" ")).toContain("pulse(3)");
    expect(result.messages.join(" ")).toContain("two extra units");
    expect(result.messages.join(" ")).toContain("six extra units");
  });

  it("requires executable dot or dash calls in the Morse loop", () => {
    const source = findLesson("morse-name")!.starterCode.replace(
      /void loop\(\) \{[\s\S]*\}\n$/,
      `void loop() {
  // dot(); dash(); messageGap();
  const char *pretend = "dot(); dash(); messageGap();";
}
`,
    );

    const result = validateLessonCode("morse-name-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Use valid dot/dash letter groups in loop(), separate groups with letterGap() or wordGap(), and finish once with messageGap().",
    );
  });

  it("rejects extra Morse pulses and merged invalid letter groups", () => {
    const extraPulse = findLesson("morse-name")!.starterCode.replace(
      "void dot() {\n  pulse(1);",
      "void dot() {\n  pulse(1);\n  pulse(1);",
    );
    const mergedLetters = findLesson("morse-name")!.starterCode.replaceAll(
      "  letterGap();\n",
      "",
    );

    expect(validateLessonCode("morse-name-v1", extraPulse).valid).toBe(false);
    expect(validateLessonCode("morse-name-v1", mergedLetters).valid).toBe(false);
  });

  it("rejects Morse timing below the conservative flash-rate floor", () => {
    const source = findLesson("morse-name")!.starterCode.replace(
      "UNIT_MS = 200",
      "UNIT_MS = 199",
    );

    const result = validateLessonCode("morse-name-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages.join(" ")).toContain("200 through 500");
  });

  it("rejects a Button Reaction sketch moved off D2 or made active-HIGH", () => {
    const source = findLesson("button-reaction")!.starterCode
      .replace("BUTTON_PIN = 2", "BUTTON_PIN = 3")
      .replace(
        "digitalRead(BUTTON_PIN) == LOW",
        `digitalRead(BUTTON_PIN) == HIGH /* digitalRead(BUTTON_PIN) == LOW */`,
      );

    const result = validateLessonCode("button-reaction-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([
      "Keep BUTTON_PIN fixed to Nano D2.",
      "Inside loop(), treat LOW as the pressed INPUT_PULLUP state.",
    ]));
  });

  it("requires elapsed subtraction, the calculated serial value, and release-to-rearm state", () => {
    const source = findLesson("button-reaction")!.starterCode
      .replace("millis() - cueStartedAt", "millis() + cueStartedAt")
      .replace("Serial.println(reactionTime);", "Serial.println(0);")
      .replace(
        "state = WAITING_FOR_RESULT_RELEASE;",
        "state = READY_TO_ARM;",
      );

    const result = validateLessonCode("button-reaction-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages.join(" ")).toContain("millis() subtraction");
    expect(result.messages.join(" ")).toContain("calculated reactionTime");
    expect(result.messages.join(" ")).toContain("one hold produces one result");
  });

  it("rejects extra Button serial output and state resets", () => {
    const extraSerial = findLesson("button-reaction")!.starterCode.replace(
      "  const bool pressed = digitalRead(BUTTON_PIN) == LOW;",
      "  const bool pressed = digitalRead(BUTTON_PIN) == LOW;\n  if (pressed) Serial.println(0);",
    );
    const extraReset = findLesson("button-reaction")!.starterCode.replace(
      /\n}\n$/,
      "\n  state = READY_TO_ARM;\n}\n",
    );

    expect(validateLessonCode("button-reaction-v1", extraSerial).valid).toBe(false);
    expect(validateLessonCode("button-reaction-v1", extraReset).valid).toBe(false);
  });
});
