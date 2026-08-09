interface SemanticRequirement {
  readonly test: (source: string) => boolean;
  readonly message: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFunctionBody(source: string, name: string): string | null {
  const signature = new RegExp(
    `\\b(?:void|float|double|int|long|unsigned\\s+long)\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*\\{`,
  );
  const match = signature.exec(source);
  if (!match) return null;

  const openBraceIndex = match.index + match[0].lastIndexOf("{");
  let depth = 1;
  for (let index = openBraceIndex + 1; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return source.slice(openBraceIndex + 1, index);
  }
  return null;
}

function numericConstants(source: string): ReadonlyMap<string, number> {
  const constants = new Map<string, number>();
  const declaration = /\bconst\s+(?:unsigned\s+)?(?:char|byte|int|long|float|double)\s+([A-Za-z_]\w*)\s*=\s*(-?\d+(?:\.\d+)?)\s*[fFlLuU]*\s*;/g;
  for (const match of source.matchAll(declaration)) {
    const name = match[1];
    const rawValue = match[2];
    if (!name || !rawValue) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) constants.set(name, value);
  }
  return constants;
}

function hasConstant(source: string, name: string, value: number): boolean {
  return numericConstants(source).get(name) === value;
}

function setupHasExclusivePinMode(
  source: string,
  name: string,
  mode: "INPUT" | "OUTPUT",
): boolean {
  const setup = findFunctionBody(source, "setup");
  if (!setup) return false;
  const call = new RegExp(
    `\\bpinMode\\s*\\(\\s*${escapeRegExp(name)}\\s*,\\s*([^)]+?)\\s*\\)`,
    "g",
  );
  const allCalls = [...source.matchAll(call)];
  return allCalls.length === 1 &&
    allCalls[0]?.[1]?.trim() === mode &&
    new RegExp(
      `\\bpinMode\\s*\\(\\s*${escapeRegExp(name)}\\s*,\\s*${mode}\\s*\\)\\s*;`,
    ).test(setup);
}

function triggerPulseIsSafe(source: string): boolean {
  const body = findFunctionBody(source, "readDistanceCm");
  if (!body) return false;
  return /digitalWrite\s*\(\s*TRIG_PIN\s*,\s*LOW\s*\)\s*;[\s\S]*?delayMicroseconds\s*\(\s*2\s*\)\s*;[\s\S]*?digitalWrite\s*\(\s*TRIG_PIN\s*,\s*HIGH\s*\)\s*;[\s\S]*?delayMicroseconds\s*\(\s*10\s*\)\s*;[\s\S]*?digitalWrite\s*\(\s*TRIG_PIN\s*,\s*LOW\s*\)/.test(body);
}

function echoReadIsBounded(source: string): boolean {
  const body = findFunctionBody(source, "readDistanceCm");
  if (!body) return false;
  if ([...source.matchAll(/\bpulseIn\s*\(/g)].length !== 1) return false;
  const match = /\b(?:const\s+)?unsigned\s+long\s+duration\s*=\s*pulseIn\s*\(\s*ECHO_PIN\s*,\s*HIGH\s*,\s*(\d+)\s*[uUlL]*\s*\)\s*;/.exec(body);
  if (!match?.[1]) return false;
  const timeout = Number(match[1]);
  return timeout >= 1_000 && timeout <= 30_000;
}

function echoConversionIsRoundTrip(source: string): boolean {
  const body = findFunctionBody(source, "readDistanceCm");
  if (!body) return false;
  return (
    /\bduration\s*\*\s*0\.0343\s*[fF]?\s*\/\s*2(?:\.0+)?\s*[fF]?/.test(body) ||
    /\bduration\s*\/\s*58(?:\.0+)?\s*[fF]?/.test(body)
  );
}

function handlesMissingEcho(source: string): boolean {
  const body = findFunctionBody(source, "readDistanceCm");
  if (!body) return false;
  return (
    /\bduration\s*==\s*0\b[\s\S]*?return\s+-1(?:\.0+)?\s*[fF]?\s*;/.test(body) ||
    /\bduration\s*==\s*0\s*\?\s*-1(?:\.0+)?\s*[fF]?\s*:/.test(body)
  );
}

function loopReportsDistance(source: string): boolean {
  const body = findFunctionBody(source, "loop");
  return body !== null && /\bSerial\s*\.\s*println\s*\(\s*distance\s*\)/.test(body);
}

function loopHasSafePingInterval(source: string): boolean {
  const body = findFunctionBody(source, "loop");
  if (!body) return false;
  if (/\b(?:return|goto|while|for)\b|\bdo\s*\{/.test(body)) return false;
  const finalDelay = /\bdelay\s*\(\s*(\d+)\s*[uUlL]*\s*\)\s*;\s*$/.exec(body);
  return finalDelay?.[1] !== undefined && Number(finalDelay[1]) >= 60;
}

function setupStartsControlledSerial(source: string): boolean {
  const setup = findFunctionBody(source, "setup");
  return setup !== null && /\bSerial\s*\.\s*begin\s*\(\s*9600\s*\)/.test(setup);
}

function declaredServoNames(source: string): ReadonlySet<string> {
  return new Set(
    [...source.matchAll(/\bServo\s+([A-Za-z_]\w*)\s*;/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
}

function attachedServoName(source: string): string | null {
  const declaredServos = declaredServoNames(source);
  const setup = findFunctionBody(source, "setup");
  if (!setup) return null;
  const attach = /\b([A-Za-z_]\w*)\s*\.\s*attach\s*\(\s*SERVO_PIN\s*\)/.exec(setup);
  const servoName = attach?.[1];
  return servoName && declaredServos.has(servoName) ? servoName : null;
}

function everyServoWriteIsSafe(source: string): boolean {
  const constants = numericConstants(source);
  const servoNames = declaredServoNames(source);
  if (servoNames.size === 0) return false;

  for (const servoName of servoNames) {
    const escapedName = escapeRegExp(servoName);
    if (new RegExp(`\\b${escapedName}\\s*\\.\\s*writeMicroseconds\\s*\\(`).test(source)) {
      return false;
    }
    const writeStarts = [
      ...source.matchAll(new RegExp(`\\b${escapedName}\\s*\\.\\s*write\\s*\\(`, "g")),
    ];
    const safeWrites = [
      ...source.matchAll(
        new RegExp(
          `\\b${escapedName}\\s*\\.\\s*write\\s*\\(\\s*([A-Za-z_]\\w*|-?\\d+(?:\\.\\d+)?)\\s*\\)`,
          "g",
        ),
      ),
    ];
    if (writeStarts.length !== safeWrites.length) return false;
    for (const write of safeWrites) {
      const argument = write[1];
      if (!argument) return false;
      const angle = /^-?\d/.test(argument)
        ? Number(argument)
        : constants.get(argument);
      if (angle === undefined || !Number.isFinite(angle) || angle < 10 || angle > 170) {
        return false;
      }
    }
  }
  return true;
}

function servoMotionIsSafe(source: string): boolean {
  const constants = numericConstants(source);
  const servoName = attachedServoName(source);
  if (!servoName) return false;
  const loop = findFunctionBody(source, "loop");
  if (!loop) return false;
  const servoWriteCalls = new RegExp(
    `\\b${escapeRegExp(servoName)}\\s*\\.\\s*write\\s*\\(`,
    "g",
  );
  if ([...loop.matchAll(servoWriteCalls)].length !== 2) return false;
  const sequence = new RegExp(
    `\\b${escapeRegExp(servoName)}\\s*\\.\\s*write\\s*\\(\\s*([A-Za-z_]\\w*|-?\\d+(?:\\.\\d+)?)\\s*\\)\\s*;` +
      `[\\s\\S]*?\\bdelay\\s*\\(\\s*(\\d+)\\s*[uUlL]*\\s*\\)\\s*;` +
      `[\\s\\S]*?\\b${escapeRegExp(servoName)}\\s*\\.\\s*write\\s*\\(\\s*([A-Za-z_]\\w*|-?\\d+(?:\\.\\d+)?)\\s*\\)\\s*;` +
      `[\\s\\S]*?\\bdelay\\s*\\(\\s*(\\d+)\\s*[uUlL]*\\s*\\)\\s*;`,
  );
  const match = sequence.exec(loop);
  if (!match) return false;
  const resolveAngle = (argument: string | undefined): number => {
    if (!argument) return Number.NaN;
    return /^-?\d/.test(argument) ? Number(argument) : (constants.get(argument) ?? Number.NaN);
  };
  const angles = [resolveAngle(match[1]), resolveAngle(match[3])];
  const pauses = [Number(match[2]), Number(match[4])];
  return (
    new Set(angles).size >= 2 &&
    angles.every((angle) => Number.isFinite(angle) && angle >= 10 && angle <= 170) &&
    pauses.every((pause) => Number.isFinite(pause) && pause >= 500)
  );
}

const roverPinMap = {
  PWMA: 3,
  AIN1: 4,
  AIN2: 5,
  PWMB: 6,
  BIN1: 7,
  BIN2: 8,
  TRIG_PIN: 9,
  ECHO_PIN: 10,
  STANDBY: 12,
} as const;

function roverHasExactPinMap(source: string): boolean {
  return Object.entries(roverPinMap).every(([name, pin]) => hasConstant(source, name, pin));
}

function roverConfiguresEverySignal(source: string): boolean {
  return (
    ["PWMA", "AIN1", "AIN2", "PWMB", "BIN1", "BIN2", "TRIG_PIN", "STANDBY"]
      .every((name) => setupHasExclusivePinMode(source, name, "OUTPUT")) &&
    setupHasExclusivePinMode(source, "ECHO_PIN", "INPUT")
  );
}

function roverStopFunctionStopsBothChannels(source: string): boolean {
  const body = findFunctionBody(source, "stopMotors");
  if (!body) return false;
  const statements = body
    .split(";")
    .map((statement) => statement.replace(/\s+/g, ""))
    .filter((statement) => statement.length > 0);
  const requiredStatements = new Set([
    "analogWrite(PWMA,0)",
    "analogWrite(PWMB,0)",
    "digitalWrite(AIN1,LOW)",
    "digitalWrite(AIN2,LOW)",
    "digitalWrite(BIN1,LOW)",
    "digitalWrite(BIN2,LOW)",
  ]);
  return statements.length === requiredStatements.size &&
    new Set(statements).size === requiredStatements.size &&
    statements.every((statement) => requiredStatements.has(statement));
}

function roverForwardDriveIsBounded(source: string): boolean {
  const body = findFunctionBody(source, "driveForward");
  if (!body) return false;
  const constrainCall = /\b(?:int|byte)\s+([A-Za-z_]\w*)\s*=\s*constrain\s*\(\s*speedValue\s*,\s*0\s*,\s*(\d+)\s*\)\s*;/.exec(body);
  const boundedVariable = constrainCall?.[1];
  const maximum = Number(constrainCall?.[2]);
  if (!boundedVariable || maximum < 1 || maximum > 180) return false;
  const boundedArgument = escapeRegExp(boundedVariable);
  const writes = [
    ...body.matchAll(/\banalogWrite\s*\(\s*([A-Za-z_]\w*)\s*,\s*([^)]+?)\s*\)/g),
  ];
  return writes.length === 2 &&
    writes.every((write) => write[2]?.trim() === boundedVariable) &&
    writes.some((write) => write[1] === "PWMA") &&
    writes.some((write) => write[1] === "PWMB") &&
    new RegExp(`\\banalogWrite\\s*\\(\\s*PWMA\\s*,\\s*${boundedArgument}\\s*\\)`).test(body) &&
    new RegExp(`\\banalogWrite\\s*\\(\\s*PWMB\\s*,\\s*${boundedArgument}\\s*\\)`).test(body);
}

function roverDirectionIsForward(source: string): boolean {
  const body = findFunctionBody(source, "driveForward");
  if (!body) return false;
  const writes = [
    ...body.matchAll(/\bdigitalWrite\s*\(\s*([A-Za-z_]\w*)\s*,\s*([^)]+?)\s*\)/g),
  ];
  const requiredWrites = new Set([
    "AIN1:HIGH",
    "AIN2:LOW",
    "BIN1:HIGH",
    "BIN2:LOW",
  ]);
  const actualWrites = writes.map(
    (write) => `${write[1] ?? ""}:${write[2]?.trim() ?? ""}`,
  );
  return actualWrites.length === requiredWrites.size &&
    new Set(actualWrites).size === requiredWrites.size &&
    actualWrites.every((write) => requiredWrites.has(write));
}

function roverStartsStoppedBeforeEnable(source: string): boolean {
  const setup = findFunctionBody(source, "setup");
  if (!setup) return false;
  const standbyLow = setup.search(/\bdigitalWrite\s*\(\s*STANDBY\s*,\s*LOW\s*\)/);
  const stop = setup.search(/\bstopMotors\s*\(\s*\)/);
  const standbyHigh = setup.search(/\bdigitalWrite\s*\(\s*STANDBY\s*,\s*HIGH\s*\)/);
  const standbyWrites = [
    ...setup.matchAll(/\bdigitalWrite\s*\(\s*STANDBY\s*,\s*(LOW|HIGH)\s*\)/g),
  ];
  const stopCalls = [...setup.matchAll(/\bstopMotors\s*\(\s*\)/g)];
  const startsMotion = /\bdriveForward\s*\(|\banalogWrite\s*\(|\bdigitalWrite\s*\(\s*(?:PWMA|PWMB|AIN1|AIN2|BIN1|BIN2)\b/.test(setup);
  return standbyLow >= 0 &&
    stop > standbyLow &&
    standbyHigh > stop &&
    standbyWrites.length === 2 &&
    stopCalls.length === 1 &&
    !startsMotion;
}

function roverUsesSafeLowSpeed(source: string): boolean {
  const speed = numericConstants(source).get("MOTOR_SPEED");
  return speed !== undefined && Number.isInteger(speed) && speed >= 1 && speed <= 180;
}

function roverStopsForNearAndInvalidReadings(source: string): boolean {
  const loop = findFunctionBody(source, "loop");
  if (!loop) return false;
  const threshold = numericConstants(source).get("STOP_DISTANCE_CM");
  if (threshold === undefined || threshold < 15 || threshold > 60) return false;
  const safeDecision = /\bif\s*\(\s*distance\s*>\s*0(?:\.0+)?\s*&&\s*distance\s*<=\s*STOP_DISTANCE_CM\s*\)\s*\{\s*stopMotors\s*\(\s*\)\s*;\s*\}\s*else\s+if\s*\(\s*distance\s*>\s*0(?:\.0+)?\s*\)\s*\{\s*driveForward\s*\(\s*MOTOR_SPEED\s*\)\s*;\s*\}\s*else\s*\{\s*stopMotors\s*\(\s*\)\s*;\s*\}/.test(loop);
  const driveCalls = [...loop.matchAll(/\bdriveForward\s*\(/g)];
  const bypassesMotorHelpers = /\b(?:analogWrite\s*\(\s*(?:PWMA|PWMB)|digitalWrite\s*\(\s*(?:AIN1|AIN2|BIN1|BIN2))/.test(loop);
  return safeDecision && driveCalls.length === 1 && !bypassesMotorHelpers;
}

const requirements: Readonly<Record<string, readonly SemanticRequirement[]>> = {
  "distance-scout-v1": [
    { test: (source) => hasConstant(source, "TRIG_PIN", 9), message: "Keep HC-SR04 TRIG on D9." },
    { test: (source) => hasConstant(source, "ECHO_PIN", 10), message: "Keep HC-SR04 ECHO on D10." },
    {
      test: (source) =>
        setupHasExclusivePinMode(source, "TRIG_PIN", "OUTPUT") &&
        setupHasExclusivePinMode(source, "ECHO_PIN", "INPUT"),
      message: "Configure D9 as the trigger OUTPUT and D10 as the echo INPUT.",
    },
    { test: triggerPulseIsSafe, message: "Send a LOW–HIGH–LOW trigger with a 10 microsecond HIGH pulse." },
    { test: echoReadIsBounded, message: "Give the D10 echo read a timeout no longer than 30 milliseconds." },
    { test: handlesMissingEcho, message: "Return a negative value when the sensor receives no echo." },
    { test: echoConversionIsRoundTrip, message: "Convert the sound pulse's round trip into one-way centimetres." },
    { test: setupStartsControlledSerial, message: "Start Serial at 9600 baud inside setup()." },
    { test: loopReportsDistance, message: "Print the calculated distance variable to Serial." },
    { test: loopHasSafePingInterval, message: "Leave at least 60 milliseconds between ultrasonic pings." },
  ],
  "servo-gate-v1": [
    { test: (source) => /^\s*#\s*include\s*<Servo\.h>\s*$/m.test(source), message: "Include the pinned Servo library." },
    { test: (source) => hasConstant(source, "SERVO_PIN", 6), message: "Keep the SG90 signal on D6." },
    { test: (source) => attachedServoName(source) !== null, message: "Attach one declared Servo to SERVO_PIN inside setup()." },
    { test: everyServoWriteIsSafe, message: "Keep every Servo angle write between 10 and 170 degrees." },
    { test: servoMotionIsSafe, message: "In loop(), write one safe angle, pause at least 500 milliseconds, then write a distinct safe angle and pause again." },
  ],
  "trail-rover-v1": [
    { test: roverHasExactPinMap, message: "Keep the TB6612FNG and HC-SR04 on the fixed D3–D10 and D12 map." },
    { test: roverConfiguresEverySignal, message: "Configure both PWM, four direction, trigger, and standby signals as outputs and D10 echo as input." },
    { test: roverStopFunctionStopsBothChannels, message: "Make stopMotors() set both PWMA and PWMB to zero." },
    { test: roverDirectionIsForward, message: "Set both motor channels to the defined forward direction." },
    { test: roverForwardDriveIsBounded, message: "Constrain the shared motor speed to 0 through 180 before writing both PWM channels." },
    { test: roverUsesSafeLowSpeed, message: "Choose a low MOTOR_SPEED from 1 through 180 for staged tests." },
    { test: roverStartsStoppedBeforeEnable, message: "Start with standby LOW and both motors stopped before enabling the driver." },
    { test: triggerPulseIsSafe, message: "Keep the HC-SR04 10 microsecond trigger pulse on D9." },
    { test: echoReadIsBounded, message: "Give the rover's D10 echo read a timeout no longer than 30 milliseconds." },
    { test: handlesMissingEcho, message: "Represent a missing rover echo as an invalid negative distance." },
    { test: echoConversionIsRoundTrip, message: "Convert the rover echo's round trip into one-way centimetres." },
    { test: setupStartsControlledSerial, message: "Start rover Serial output at 9600 baud inside setup()." },
    { test: loopReportsDistance, message: "Print the rover distance variable for the raised-wheel check." },
    { test: roverStopsForNearAndInvalidReadings, message: "Stop both motors for a near obstacle and for every invalid or missing echo." },
    { test: loopHasSafePingInterval, message: "Leave at least 60 milliseconds between rover distance pings." },
  ],
};

/** Receives source whose comments and literals have already been masked. */
export function validateBuildsFourToSixCode(
  validatorId: string,
  executableSource: string,
): readonly string[] {
  return (requirements[validatorId] ?? [])
    .filter((requirement) => !requirement.test(executableSource))
    .map((requirement) => requirement.message);
}
