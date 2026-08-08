import { describe, expect, it } from "vitest";
import { findLesson } from "./catalog";
import type {
  CompletionStep,
  SerialCheckStep,
  WiringStep,
} from "./contracts";

function requiredLesson(id: "distance-scout" | "servo-gate" | "trail-rover") {
  const lesson = findLesson(id);
  expect(lesson).toBeDefined();
  return lesson!;
}

function stepOfType<TType extends "wiring" | "serial-check" | "completion">(
  lessonId: "distance-scout" | "servo-gate" | "trail-rover",
  type: TType,
): Extract<WiringStep | SerialCheckStep | CompletionStep, { type: TType }> {
  const step = requiredLesson(lessonId).steps.find((candidate) => candidate.type === type);
  expect(step).toBeDefined();
  return step as Extract<WiringStep | SerialCheckStep | CompletionStep, { type: TType }>;
}

describe("pilot curriculum builds 4–6", () => {
  it.each([
    ["distance-scout", "button-reaction", 60],
    ["servo-gate", "distance-scout", 60],
    ["trail-rover", "servo-gate", 100],
  ] as const)("marks %s complete with its time and preceding prerequisite", (
    id,
    prerequisite,
    estimatedMinutes,
  ) => {
    const lesson = requiredLesson(id);
    expect(lesson.migrationStage).toBe("prototype-ready");
    expect(lesson.prerequisites).toEqual([prerequisite]);
    expect(lesson.estimatedMinutes).toBe(estimatedMinutes);
    expect(lesson.objectives.length).toBeGreaterThanOrEqual(3);
    expect(lesson.troubleshooting.length).toBeGreaterThanOrEqual(3);
  });

  it("locks Distance Scout wiring, prose, and sketch to the HC-SR04 D9/D10 map", () => {
    const lesson = requiredLesson("distance-scout");
    expect(lesson.pinAssignments.map(({ component, signal, pin }) => ({ component, signal, pin })))
      .toEqual([
        { component: "HC-SR04 TRIG", signal: "Trigger output", pin: "D9" },
        { component: "HC-SR04 ECHO", signal: "Echo input", pin: "D10" },
      ]);
    expect(lesson.hardwareParts).toEqual(expect.arrayContaining([
      "HC-SR04 ultrasonic sensor",
      "4 male-to-male jumper wires",
      "Ruler or tape measure",
      "Broad, flat test object",
    ]));
    const wiring = stepOfType("distance-scout", "wiring");
    expect(wiring.instructions.join(" ")).toMatch(/VCC to the Nano 5V/i);
    expect(wiring.instructions.join(" ")).toMatch(/GND to a Nano GND/i);
    expect(wiring.instructions.join(" ")).toMatch(/TRIG to Nano D9/i);
    expect(wiring.instructions.join(" ")).toMatch(/ECHO to Nano D10/i);
    expect(wiring.diagramAlt).toMatch(/VCC to Nano 5V.*GND to Nano GND.*TRIG.*D9.*ECHO.*D10/i);
    expect(lesson.starterCode).toMatch(/TRIG_PIN\s*=\s*9/);
    expect(lesson.starterCode).toMatch(/ECHO_PIN\s*=\s*10/);
    expect(lesson.starterCode).toMatch(/Serial\.begin\s*\(\s*9600\s*\)/);
  });

  it("makes Distance Scout calibration observable at the controlled serial speed", () => {
    const serial = stepOfType("distance-scout", "serial-check");
    const observation = requiredLesson("distance-scout").steps.find(
      (step) => step.type === "manual-observation",
    );
    expect(serial.baudRate).toBe(9_600);
    expect(serial.expectedObservation).toMatch(/positive centimetre values/i);
    expect(serial.expectedObservation).toMatch(/absent echo/i);
    expect(observation?.type).toBe("manual-observation");
    expect(observation && "prompt" in observation ? observation.prompt : "")
      .toMatch(/15 cm.*30 cm.*60 cm/i);
  });

  it("documents Servo Gate external power and common ground without implying Nano power", () => {
    const lesson = requiredLesson("servo-gate");
    expect(lesson.pinAssignments).toHaveLength(1);
    expect(lesson.pinAssignments[0]).toMatchObject({
      component: "SG90 signal lead",
      signal: "Angle-control pulse",
      pin: "D6",
    });
    expect(lesson.pinAssignments[0]?.note).toMatch(/external regulated supply/i);
    expect(lesson.pinAssignments[0]?.note).toMatch(/Nano GND/i);
    expect(lesson.hardwareParts).toContain(
      "Firelight-supplied regulated 5V servo supply rated for at least 1 A (exact model, polarity, and connectors require signed pilot BOM)",
    );
    expect(lesson.safetyNotes.join(" ")).toMatch(/electrical reviewer has signed/i);
    const wiring = stepOfType("servo-gate", "wiring");
    const instructions = wiring.instructions.join(" ");
    expect(instructions).toMatch(/servo \+5V only to external regulated \+5V/i);
    expect(instructions).toMatch(/external supply ground to Nano GND/i);
    expect(instructions).toMatch(/Do not connect external \+5V to Nano 5V or VIN/i);
    expect(wiring.diagramAlt).toMatch(/signal lead to Nano D6/i);
    expect(wiring.diagramAlt).toMatch(/external positive is not connected to any Nano power pin/i);
    expect(lesson.starterCode).toContain("#include <Servo.h>");
    expect(lesson.starterCode).toMatch(/SERVO_PIN\s*=\s*6/);
  });

  it("keeps the rover signal map, supplies, grounds, and motor outputs explicit", () => {
    const lesson = requiredLesson("trail-rover");
    expect(lesson.hardwareParts.join(" ")).toMatch(/signed pilot BOM/i);
    expect(lesson.safetyNotes.join(" ")).toMatch(
      /maximum voltage\/current capability.*stall current.*continuous\/peak\/thermal limits/i,
    );
    expect(lesson.pinAssignments.map(({ pin }) => pin)).toEqual([
      "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D12",
    ]);
    expect(lesson.pinAssignments.map(({ component }) => component)).toEqual([
      "TB6612FNG PWMA",
      "TB6612FNG AIN1",
      "TB6612FNG AIN2",
      "TB6612FNG PWMB",
      "TB6612FNG BIN1",
      "TB6612FNG BIN2",
      "HC-SR04 TRIG",
      "HC-SR04 ECHO",
      "TB6612FNG STBY",
    ]);
    const wiring = stepOfType("trail-rover", "wiring");
    const instructions = wiring.instructions.join(" ");
    expect(instructions).toMatch(/D3 to PWMA.*D4 to AIN1.*D5 to AIN2.*D6 to PWMB.*D7 to BIN1.*D8 to BIN2.*D12 to STBY/i);
    expect(instructions).toMatch(/left motor to driver AO1\/AO2.*right motor to BO1\/BO2/i);
    expect(instructions).toMatch(/driver logic VCC to Nano 5V/i);
    expect(instructions).toMatch(/motor-battery positive only to driver VM/i);
    expect(instructions).toMatch(/motor-battery negative.*driver GND.*Nano GND.*HC-SR04 GND/i);
    expect(instructions).toMatch(/floor test.*within USB-cable reach.*generous cable slack/i);
    expect(wiring.diagramAlt).toMatch(/both wheels raised clear of the bench/i);
  });

  it("requires upload evidence plus applicable serial and physical observations before completion", () => {
    for (const id of ["distance-scout", "servo-gate", "trail-rover"] as const) {
      const lesson = requiredLesson(id);
      expect(lesson.steps.map((step) => step.type)).toEqual(expect.arrayContaining([
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
      ]));
      const completion = stepOfType(id, "completion");
      expect(completion.requiredStepIds).toEqual(expect.arrayContaining([
        "upload-sketch",
        "check-understanding",
        "observe-build",
      ]));
      expect(completion.summary).toMatch(/recorded upload evidence/i);
    }

    for (const id of ["distance-scout", "trail-rover"] as const) {
      expect(requiredLesson(id).steps.some((step) => step.type === "serial-check")).toBe(true);
      expect(stepOfType(id, "completion").requiredStepIds).toContain("check-serial");
    }
    expect(requiredLesson("servo-gate").steps.some((step) => step.type === "serial-check"))
      .toBe(false);
  });

  it("stages rover validation on a stand before three clear-floor stops", () => {
    const lesson = requiredLesson("trail-rover");
    const serial = stepOfType("trail-rover", "serial-check");
    const observation = lesson.steps.find((step) => step.type === "manual-observation");
    expect(serial.baudRate).toBe(9_600);
    expect(serial.expectedObservation).toMatch(/both wheels raised/i);
    expect(serial.expectedObservation).toMatch(/no-echo value.*stopped/i);
    expect(observation?.type).toBe("manual-observation");
    expect(observation && "prompt" in observation ? observation.prompt : "")
      .toMatch(/First.*wheels raised.*Then.*USB cable safely restrained.*clear floor.*three times/i);
  });
});
