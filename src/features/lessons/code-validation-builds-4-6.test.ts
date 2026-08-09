import { describe, expect, it } from "vitest";
import { findLesson } from "./catalog";
import { validateLessonCode } from "./code-validation";

type BuildId = "distance-scout" | "servo-gate" | "trail-rover";

function starterCode(id: BuildId): string {
  const lesson = findLesson(id);
  expect(lesson).toBeDefined();
  return lesson!.starterCode;
}

function expectRejected(
  id: BuildId,
  validatorId: `${BuildId}-v1`,
  transform: (source: string) => string,
  message: string,
): void {
  const result = validateLessonCode(validatorId, transform(starterCode(id)));
  expect(result.valid).toBe(false);
  expect(result.messages).toContain(message);
}

describe("Distance Scout semantic validation", () => {
  it("accepts the controlled starter sketch", () => {
    expect(validateLessonCode("distance-scout-v1", starterCode("distance-scout")))
      .toEqual({ valid: true, messages: [] });
  });

  it.each([
    [
      (source: string) => source.replace("TRIG_PIN = 9", "TRIG_PIN = 10"),
      "Keep HC-SR04 TRIG on D9.",
    ],
    [
      (source: string) => source.replace("ECHO_PIN = 10", "ECHO_PIN = 9"),
      "Keep HC-SR04 ECHO on D10.",
    ],
    [
      (source: string) => source.replace("pinMode(ECHO_PIN, INPUT)", "pinMode(ECHO_PIN, OUTPUT)"),
      "Configure D9 as the trigger OUTPUT and D10 as the echo INPUT.",
    ],
    [
      (source: string) => source.replace("delayMicroseconds(10)", "delayMicroseconds(5)"),
      "Send a LOW–HIGH–LOW trigger with a 10 microsecond HIGH pulse.",
    ],
    [
      (source: string) => source.replace("pulseIn(ECHO_PIN, HIGH, 30000UL)", "pulseIn(ECHO_PIN, HIGH)"),
      "Give the D10 echo read a timeout no longer than 30 milliseconds.",
    ],
    [
      (source: string) => source.replace("return -1.0;", "return 0;"),
      "Return a negative value when the sensor receives no echo.",
    ],
    [
      (source: string) => source.replace("duration * 0.0343 / 2.0", "duration * 0.0343"),
      "Convert the sound pulse's round trip into one-way centimetres.",
    ],
    [
      (source: string) => source.replace("Serial.begin(9600)", "Serial.begin(115200)"),
      "Start Serial at 9600 baud inside setup().",
    ],
    [
      (source: string) => source
        .replace("  Serial.begin(9600);\n", "")
        .replace("void setup() {", "void serialDecoy() { Serial.begin(9600); }\n\nvoid setup() {"),
      "Start Serial at 9600 baud inside setup().",
    ],
    [
      (source: string) => source.replace("Serial.println(distance)", "Serial.println(42)"),
      "Print the calculated distance variable to Serial.",
    ],
    [
      (source: string) => source.replace("delay(100)", "delay(20)"),
      "Leave at least 60 milliseconds between ultrasonic pings.",
    ],
  ] as const)("rejects a distance near miss", (transform, message) => {
    expectRejected("distance-scout", "distance-scout-v1", transform, message);
  });

  it("does not accept distance requirements copied into comments or strings", () => {
    const decoys = `
      void setup() {}
      void loop() {
        // const int TRIG_PIN = 9; const int ECHO_PIN = 10;
        const char *fake = "pinMode(TRIG_PIN, OUTPUT); Serial.begin(9600);";
        /* pulseIn(ECHO_PIN, HIGH, 30000); Serial.println(distance); */
      }
    `;
    const result = validateLessonCode("distance-scout-v1", decoys);
    expect(result.valid).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([
      "Keep HC-SR04 TRIG on D9.",
      "Keep HC-SR04 ECHO on D10.",
      "Start Serial at 9600 baud inside setup().",
    ]));
  });

  it("does not accept required pin modes moved into an unused helper", () => {
    const source = starterCode("distance-scout")
      .replace("  pinMode(TRIG_PIN, OUTPUT);\n", "")
      .replace("  pinMode(ECHO_PIN, INPUT);\n", "")
      .replace(
        "void setup() {",
        `void unusedPinSetup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

void setup() {`,
      );

    const result = validateLessonCode("distance-scout-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Configure D9 as the trigger OUTPUT and D10 as the echo INPUT.",
    );
  });

  it("binds duration to the only bounded echo read", () => {
    const source = starterCode("distance-scout").replace(
      "  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);",
      `  pulseIn(ECHO_PIN, HIGH, 30000UL);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH);`,
    );

    const result = validateLessonCode("distance-scout-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Give the D10 echo read a timeout no longer than 30 milliseconds.",
    );
  });

  it("rejects an unreachable safe-delay decoy before an unsafe ping interval", () => {
    const source = starterCode("distance-scout").replace(
      "  delay(100);",
      `  if (false) { delay(100); }
  delay(20);`,
    );

    const result = validateLessonCode("distance-scout-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Leave at least 60 milliseconds between ultrasonic pings.",
    );
  });
});

describe("Servo Gate semantic validation", () => {
  it("accepts the compiler-policy-compatible Servo starter sketch", () => {
    expect(validateLessonCode("servo-gate-v1", starterCode("servo-gate")))
      .toEqual({ valid: true, messages: [] });
  });

  it.each([
    [
      (source: string) => source.replace("#include <Servo.h>", "// #include <Servo.h>"),
      "Include the pinned Servo library.",
    ],
    [
      (source: string) => source.replace("SERVO_PIN = 6", "SERVO_PIN = 5"),
      "Keep the SG90 signal on D6.",
    ],
    [
      (source: string) => source
        .replace("gate.attach(SERVO_PIN);", "")
        .replace("void loop() {", "void attachLater() { gate.attach(SERVO_PIN); }\n\nvoid loop() {"),
      "Attach one declared Servo to SERVO_PIN inside setup().",
    ],
    [
      (source: string) => source.replace("OPEN_ANGLE = 100", "OPEN_ANGLE = 20"),
      "In loop(), write one safe angle, pause at least 500 milliseconds, then write a distinct safe angle and pause again.",
    ],
    [
      (source: string) => source.replace("OPEN_ANGLE = 100", "OPEN_ANGLE = 180"),
      "In loop(), write one safe angle, pause at least 500 milliseconds, then write a distinct safe angle and pause again.",
    ],
    [
      (source: string) => source.replaceAll("delay(1200)", "delay(100)"),
      "In loop(), write one safe angle, pause at least 500 milliseconds, then write a distinct safe angle and pause again.",
    ],
    [
      (source: string) => source.replace(
        "gate.write(OPEN_ANGLE);\n  delay(1200);",
        "delay(1200);\n  gate.write(OPEN_ANGLE);",
      ),
      "In loop(), write one safe angle, pause at least 500 milliseconds, then write a distinct safe angle and pause again.",
    ],
    [
      (source: string) => source.replace(
        "  delay(1200);\n}",
        "  delay(1200);\n  gate.write(150);\n}",
      ),
      "In loop(), write one safe angle, pause at least 500 milliseconds, then write a distinct safe angle and pause again.",
    ],
  ] as const)("rejects a servo near miss", (transform, message) => {
    expectRejected("servo-gate", "servo-gate-v1", transform, message);
  });

  it("does not accept a fake Servo include, attach, angles, or pauses", () => {
    const decoys = `
      void setup() {}
      void loop() {
        const char *fake = "#include <Servo.h> gate.attach(SERVO_PIN);";
        // gate.write(20); delay(1000); gate.write(100); delay(1000);
      }
    `;
    const result = validateLessonCode("servo-gate-v1", decoys);
    expect(result.valid).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([
      "Include the pinned Servo library.",
      "Keep the SG90 signal on D6.",
      "Attach one declared Servo to SERVO_PIN inside setup().",
    ]));
  });

  it.each([
    (source: string) => source.replace(
      "  gate.attach(SERVO_PIN);",
      "  gate.attach(SERVO_PIN);\n  gate.write(180);",
    ),
    (source: string) => source.replace(
      "  gate.attach(SERVO_PIN);",
      "  gate.attach(SERVO_PIN);\n  gate.writeMicroseconds(2500);",
    ),
  ])("rejects an unsafe Servo command outside the two loop writes", (transform) => {
    const result = validateLessonCode(
      "servo-gate-v1",
      transform(starterCode("servo-gate")),
    );
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Keep every Servo angle write between 10 and 170 degrees.",
    );
  });
});

describe("Trail Rover semantic validation", () => {
  it("accepts the fixed, bounded, fail-safe rover starter sketch", () => {
    expect(validateLessonCode("trail-rover-v1", starterCode("trail-rover")))
      .toEqual({ valid: true, messages: [] });
  });

  it.each([
    [
      (source: string) => source.replace("PWMB = 6", "PWMB = 11"),
      "Keep the TB6612FNG and HC-SR04 on the fixed D3–D10 and D12 map.",
    ],
    [
      (source: string) => source.replace("pinMode(PWMA, OUTPUT);", ""),
      "Configure both PWM, four direction, trigger, and standby signals as outputs and D10 echo as input.",
    ],
    [
      (source: string) => source.replace("analogWrite(PWMB, 0);", "analogWrite(PWMB, 40);"),
      "Make stopMotors() set both PWMA and PWMB to zero.",
    ],
    [
      (source: string) => source.replace(
        "analogWrite(PWMB, 0);",
        "analogWrite(PWMB, 0);\n  analogWrite(PWMA, 120);",
      ),
      "Make stopMotors() set both PWMA and PWMB to zero.",
    ],
    [
      (source: string) => source.replace("constrain(speedValue, 0, 180)", "constrain(speedValue, 0, 255)"),
      "Constrain the shared motor speed to 0 through 180 before writing both PWM channels.",
    ],
    [
      (source: string) => source.replace("MOTOR_SPEED = 120", "MOTOR_SPEED = 220"),
      "Choose a low MOTOR_SPEED from 1 through 180 for staged tests.",
    ],
    [
      (source: string) => source.replace(
        "digitalWrite(STANDBY, LOW);\n  stopMotors();\n  digitalWrite(STANDBY, HIGH);",
        "digitalWrite(STANDBY, HIGH);\n  stopMotors();",
      ),
      "Start with standby LOW and both motors stopped before enabling the driver.",
    ],
    [
      (source: string) => source.replace("pulseIn(ECHO_PIN, HIGH, 30000UL)", "pulseIn(ECHO_PIN, HIGH)"),
      "Give the rover's D10 echo read a timeout no longer than 30 milliseconds.",
    ],
    [
      (source: string) => source.replace("duration == 0 ? -1.0", "duration == 0 ? 100.0"),
      "Represent a missing rover echo as an invalid negative distance.",
    ],
    [
      (source: string) => source
        .replace("  Serial.begin(9600);\n", "")
        .replace("void setup() {", "void serialDecoy() { Serial.begin(9600); }\n\nvoid setup() {"),
      "Start rover Serial output at 9600 baud inside setup().",
    ],
    [
      (source: string) => source.replace(
        `if (distance > 0 && distance <= STOP_DISTANCE_CM) {
    stopMotors();
  } else if (distance > 0) {
    driveForward(MOTOR_SPEED);
  } else {
    stopMotors();
  }`,
        `if (distance > 0 && distance <= STOP_DISTANCE_CM) {
    stopMotors();
  } else {
    driveForward(MOTOR_SPEED);
  }`,
      ),
      "Stop both motors for a near obstacle and for every invalid or missing echo.",
    ],
    [
      (source: string) => source.replace(
        "  delay(80);",
        "  driveForward(MOTOR_SPEED);\n  delay(80);",
      ),
      "Stop both motors for a near obstacle and for every invalid or missing echo.",
    ],
    [
      (source: string) => source.replace(
        "  delay(80);",
        "  analogWrite(PWMA, 180);\n  delay(80);",
      ),
      "Stop both motors for a near obstacle and for every invalid or missing echo.",
    ],
  ] as const)("rejects a rover near miss", (transform, message) => {
    expectRejected("trail-rover", "trail-rover-v1", transform, message);
  });

  it("does not accept rover safety logic placed only in comments and literals", () => {
    const decoys = `
      void setup() {}
      void loop() {
        // stopMotors(); driveForward(MOTOR_SPEED);
        const char *fake = "PWMA = 3; STANDBY = 12; Serial.begin(9600);";
        /* if (distance > 0 && distance <= STOP_DISTANCE_CM) { stopMotors(); } */
      }
    `;
    const result = validateLessonCode("trail-rover-v1", decoys);
    expect(result.valid).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([
      "Keep the TB6612FNG and HC-SR04 on the fixed D3–D10 and D12 map.",
      "Make stopMotors() set both PWMA and PWMB to zero.",
      "Stop both motors for a near obstacle and for every invalid or missing echo.",
    ]));
  });

  it("rejects a stop helper that restarts motion after zeroing both channels", () => {
    const source = starterCode("trail-rover").replace(
      "  digitalWrite(BIN2, LOW);\n}",
      "  digitalWrite(BIN2, LOW);\n  driveForward(180);\n}",
    );

    const result = validateLessonCode("trail-rover-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Make stopMotors() set both PWMA and PWMB to zero.",
    );
  });

  it("rejects motion introduced after the stopped startup sequence", () => {
    const source = starterCode("trail-rover").replace(
      "  digitalWrite(STANDBY, HIGH);",
      "  digitalWrite(STANDBY, HIGH);\n  driveForward(180);",
    );

    const result = validateLessonCode("trail-rover-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Start with standby LOW and both motors stopped before enabling the driver.",
    );
  });

  it.each([
    [
      (source: string) => source.replace(
        "  analogWrite(PWMB, safeSpeed);\n}",
        "  analogWrite(PWMB, safeSpeed);\n  analogWrite(PWMA, 255);\n}",
      ),
      "Constrain the shared motor speed to 0 through 180 before writing both PWM channels.",
    ],
    [
      (source: string) => source.replace(
        "  digitalWrite(BIN2, LOW);\n  analogWrite(PWMA, safeSpeed);",
        "  digitalWrite(BIN2, LOW);\n  digitalWrite(AIN1, LOW);\n  analogWrite(PWMA, safeSpeed);",
      ),
      "Set both motor channels to the defined forward direction.",
    ],
  ] as const)("rejects a contradictory write after safe drive setup", (transform, message) => {
    const result = validateLessonCode(
      "trail-rover-v1",
      transform(starterCode("trail-rover")),
    );
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(message);
  });

  it("does not accept rover pin modes moved into an unused helper", () => {
    const pinModes = `  pinMode(PWMA, OUTPUT);
  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  pinMode(PWMB, OUTPUT);
  pinMode(BIN1, OUTPUT);
  pinMode(BIN2, OUTPUT);
  pinMode(STANDBY, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);`;
    const source = starterCode("trail-rover")
      .replace(`${pinModes}\n`, "")
      .replace(
        "void setup() {",
        `void unusedPinSetup() {
${pinModes}
}

void setup() {`,
      );

    const result = validateLessonCode("trail-rover-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Configure both PWM, four direction, trigger, and standby signals as outputs and D10 echo as input.",
    );
  });

  it("rejects a bounded echo decoy before the duration's unbounded read", () => {
    const source = starterCode("trail-rover").replace(
      "  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);",
      `  pulseIn(ECHO_PIN, HIGH, 30000UL);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH);`,
    );

    const result = validateLessonCode("trail-rover-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Give the rover's D10 echo read a timeout no longer than 30 milliseconds.",
    );
  });

  it("requires the effective final rover ping interval to remain safe", () => {
    const source = starterCode("trail-rover").replace(
      "  delay(80);",
      `  if (false) { delay(80); }
  delay(20);`,
    );

    const result = validateLessonCode("trail-rover-v1", source);
    expect(result.valid).toBe(false);
    expect(result.messages).toContain(
      "Leave at least 60 milliseconds between rover distance pings.",
    );
  });
});
