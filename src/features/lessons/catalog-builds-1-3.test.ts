import { describe, expect, it } from "vitest";
import { findLesson } from "./catalog";
import { validateArduinoSourcePolicy, validateLessonCode } from "./code-validation";
import type { CompletionStep, WiringStep } from "./contracts";
import { createMorseNameStarterCode } from "./morse";

const firstSpark = findLesson("first-spark")!;
const morseName = findLesson("morse-name")!;
const buttonReaction = findLesson("button-reaction")!;
const firstThree = [firstSpark, morseName, buttonReaction] as const;

function wiringStep(lesson: (typeof firstThree)[number]): WiringStep {
  return lesson.steps.find((step): step is WiringStep => step.type === "wiring")!;
}

function completionStep(lesson: (typeof firstThree)[number]): CompletionStep {
  return lesson.steps.find((step): step is CompletionStep => step.type === "completion")!;
}

describe("pilot curriculum builds one through three", () => {
  it("locks the build order and marks every migrated build ready", () => {
    expect(firstSpark.prerequisites).toEqual([]);
    expect(morseName.prerequisites).toEqual(["first-spark"]);
    expect(buttonReaction.prerequisites).toEqual(["morse-name"]);
    expect(firstThree.map((lesson) => lesson.migrationStage)).toEqual([
      "prototype-ready",
      "prototype-ready",
      "prototype-ready",
    ]);
    expect(firstThree.map((lesson) => lesson.estimatedMinutes)).toEqual([35, 45, 60]);
  });

  it("names the controlled Nano and the exact parts needed by each build", () => {
    for (const lesson of firstThree) {
      expect(lesson.hardwareParts[0]).toBe(
        "ATmega328P Arduino Nano-compatible board (old bootloader)",
      );
      expect(lesson.hardwareParts).toContain("USB data cable");
    }

    expect(firstSpark.hardwareParts).toHaveLength(2);
    expect(morseName.hardwareParts).toHaveLength(2);
    expect(buttonReaction.hardwareParts).toEqual([
      "ATmega328P Arduino Nano-compatible board (old bootloader)",
      "USB data cable",
      "Momentary four-leg pushbutton",
      "Solderless breadboard",
      "2 male-to-male jumper wires",
    ]);
  });

  it("keeps the declared pins aligned with wiring and executable code", () => {
    expect(firstSpark.pinAssignments.map((assignment) => assignment.pin)).toEqual([
      "LED_BUILTIN",
    ]);
    expect(morseName.pinAssignments.map((assignment) => assignment.pin)).toEqual([
      "LED_BUILTIN",
    ]);
    expect(buttonReaction.pinAssignments.map((assignment) => assignment.pin)).toEqual([
      "D2",
      "LED_BUILTIN",
    ]);

    expect(firstSpark.starterCode).toContain("pinMode(LED_BUILTIN, OUTPUT)");
    expect(morseName.starterCode).toContain("pinMode(LED_BUILTIN, OUTPUT)");
    expect(buttonReaction.starterCode).toContain("const int BUTTON_PIN = 2;");
    expect(buttonReaction.starterCode).toContain("pinMode(BUTTON_PIN, INPUT_PULLUP)");
  });

  it("provides complete accessible connection descriptions", () => {
    const sparkWiring = wiringStep(firstSpark);
    const morseWiring = wiringStep(morseName);
    const buttonWiring = wiringStep(buttonReaction);

    expect(sparkWiring.diagramAlt).toMatch(/USB data cable.*Nano USB socket/i);
    expect(sparkWiring.instructions.join(" ")).toMatch(/every header pin.*unconnected/i);
    expect(morseWiring.diagramAlt).toMatch(/built-in L LED.*LED_BUILTIN/i);
    expect(morseWiring.instructions.join(" ")).toMatch(/external header pin.*unconnected/i);
    expect(buttonWiring.diagramAlt).toMatch(/D2.*GND/i);
    expect(buttonWiring.diagramAlt).toMatch(/No 5V wire or external resistor/i);
    expect(buttonWiring.instructions.join(" ")).toMatch(/opposite switched side/i);

    for (const lesson of firstThree) {
      const wiring = wiringStep(lesson);
      expect(wiring.diagramAlt.length).toBeGreaterThan(100);
      expect(wiring.instructions.length).toBeGreaterThanOrEqual(4);
      expect(wiring.instructions.every((instruction) => instruction.trim().length > 20)).toBe(
        true,
      );
    }
  });

  it("uses every applicable typed step and explicitly requires upload evidence", () => {
    const commonTypes = [
      "narrative",
      "wiring",
      "code-edit",
      "code-validation",
      "quiz",
      "compile",
      "connect",
      "upload",
      "manual-observation",
      "completion",
    ];

    expect(firstSpark.steps.map((step) => step.type)).toEqual(commonTypes);
    expect(morseName.steps.map((step) => step.type)).toEqual(commonTypes);
    expect(buttonReaction.steps.map((step) => step.type)).toEqual([
      ...commonTypes.slice(0, 8),
      "serial-check",
      ...commonTypes.slice(8),
    ]);
    expect(completionStep(firstSpark).requiredStepIds).toEqual([
      "check-understanding",
      "upload-sketch",
      "observe-build",
    ]);
    expect(completionStep(morseName).requiredStepIds).toEqual([
      "check-understanding",
      "upload-sketch",
      "observe-build",
    ]);
    expect(completionStep(buttonReaction).requiredStepIds).toEqual([
      "check-understanding",
      "upload-sketch",
      "check-serial",
      "observe-build",
    ]);
  });

  it("ships source that passes both semantic validation and compiler policy", () => {
    const validatorIds = [
      "first-spark-v1",
      "morse-name-v1",
      "button-reaction-v1",
    ] as const;

    firstThree.forEach((lesson, index) => {
      expect(validateArduinoSourcePolicy(lesson.starterCode)).toEqual([]);
      expect(validateLessonCode(validatorIds[index]!, lesson.starterCode)).toEqual({
        valid: true,
        messages: [],
      });
    });
    expect(morseName.starterCode).toBe(createMorseNameStarterCode("ADA"));
  });

  it("contains actionable objectives, safety checks, observations, and troubleshooting", () => {
    for (const lesson of firstThree) {
      expect(lesson.objectives.length).toBeGreaterThanOrEqual(3);
      expect(lesson.safetyNotes.length).toBeGreaterThanOrEqual(3);
      expect(lesson.troubleshooting.length).toBeGreaterThanOrEqual(3);
      expect(
        lesson.steps.some(
          (step) => step.type === "manual-observation" && step.prompt.length > 100,
        ),
      ).toBe(true);
      expect(completionStep(lesson).summary).toMatch(/upload evidence/i);
    }
  });
});
