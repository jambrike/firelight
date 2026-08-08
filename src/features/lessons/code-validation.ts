import { validateBuildsFourToSixCode } from "./code-validation-builds-4-6";

export interface CodeValidationResult {
  readonly valid: boolean;
  readonly messages: readonly string[];
}

interface PatternRequirement {
  readonly pattern: RegExp;
  readonly message: string;
}

interface SemanticRequirement {
  readonly test: (source: string) => boolean;
  readonly message: string;
}

type Requirement = PatternRequirement | SemanticRequirement;

function functionBody(source: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signature = new RegExp(
    `\\b(?:void|bool|int|long|float|double|unsigned\\s+(?:int|long))\\s+${escapedName}\\s*\\([^;{}]*\\)\\s*\\{`,
  );
  const match = signature.exec(source);
  if (!match) return null;
  const openingBrace = source.indexOf("{", match.index);
  if (openingBrace < 0) return null;

  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  return null;
}

function numericConstant(source: string, name: string): number | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\bconst\\s+(?:unsigned\\s+)?(?:int|long)\\s+${escapedName}\\s*=\\s*(\\d+)\\s*;`,
  ).exec(source);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function bodyMatches(source: string, name: string, pattern: RegExp): boolean {
  const body = functionBody(source, name);
  return body !== null && pattern.test(body);
}

function bodyMatchesExactly(source: string, name: string, pattern: RegExp): boolean {
  const body = functionBody(source, name);
  return body !== null && pattern.test(body.trim());
}

const MORSE_LETTER_PATTERNS: ReadonlySet<string> = new Set([
  ".-", "-...", "-.-.", "-..", ".", "..-.", "--.", "....", "..", ".---",
  "-.-", ".-..", "--", "-.", "---", ".--.", "--.-", ".-.", "...", "-",
  "..-", "...-", ".--", "-..-", "-.--", "--..", "-----", ".----", "..---",
  "...--", "....-", ".....", "-....", "--...", "---..", "----.",
]);

function morseLoopIsStructured(source: string): boolean {
  const body = functionBody(source, "loop");
  if (!body) return false;
  const callPattern = /\b(dot|dash|letterGap|wordGap|messageGap)\s*\(\s*\)\s*;/g;
  const calls = [...body.matchAll(callPattern)].map((match) => match[1]);
  if (body.replace(callPattern, "").trim().length > 0 || calls.length < 2) return false;
  if (
    calls.at(-1) !== "messageGap" ||
    calls.filter((name) => name === "messageGap").length !== 1
  ) {
    return false;
  }

  let encodedLetter = "";
  for (const name of calls.slice(0, -1)) {
    if (name === "dot" || name === "dash") {
      encodedLetter += name === "dot" ? "." : "-";
      continue;
    }
    if (!MORSE_LETTER_PATTERNS.has(encodedLetter)) return false;
    encodedLetter = "";
  }
  return MORSE_LETTER_PATTERNS.has(encodedLetter);
}

function loopHasNoEarlyControlTransfer(source: string): boolean {
  const body = functionBody(source, "loop");
  return body !== null && !/\b(?:return|goto)\b/.test(body);
}

const sharedSetupLoop: readonly Requirement[] = [
  {
    test: (source) => functionBody(source, "setup") !== null,
    message: "Add a complete setup() function.",
  },
  {
    test: (source) => functionBody(source, "loop") !== null,
    message: "Add a complete loop() function.",
  },
];

const ALLOWED_PREPROCESSOR_DIRECTIVE = /^\s*#\s*include\s*<Servo\.h>\s*(?:\/\/.*)?$/;
const FORBIDDEN_TRANSLATION_FEATURE = /(?:\\(?:\r\n|\r|\n)|\?\?[=/'()!<>-]|%:)/;
const FORBIDDEN_COMPILER_FEATURES: readonly PatternRequirement[] = [
  {
    pattern: /\b(?:asm|__asm|__asm__)\b/i,
    message: "Inline assembly is not available in Firelight lesson sketches.",
  },
  {
    pattern: /\.(?:incbin|include)\b/i,
    message: "Assembler file directives are not available in lesson sketches.",
  },
  {
    pattern: /\b(?:__attribute__|__has_include|include_next)\b/i,
    message: "Compiler-specific file and attribute features are not available here.",
  },
  {
    pattern: /(?:\bu8|\b[LuU])?R"/,
    message: "Raw string literals are not available in lesson sketches.",
  },
  {
    pattern: /(?:\.\.\/|\/proc\/|\/etc\/|\/var\/|\/tmp\/|file:\/\/)/i,
    message: "Lesson sketches cannot reference files or system paths.",
  },
];

/**
 * Replace comments (and, optionally, literals) with spaces while preserving
 * newlines and offsets. This is intentionally a small lexer rather than a
 * comment-removal regex: lesson requirements must not be satisfiable by code
 * copied into a comment or string, and comments before `#include` disappear
 * before the C preprocessor decides whether `#` starts a directive.
 */
function maskCppNonCode(source: string, maskLiterals: boolean): string {
  let result = "";
  let index = 0;
  let state: "code" | "line-comment" | "block-comment" | "string" | "character" =
    "code";

  const mask = (character: string): string => (character === "\n" || character === "\r" ? character : " ");

  while (index < source.length) {
    const character = source.charAt(index);
    const next = source.charAt(index + 1);

    if (state === "code") {
      if (character === "/" && next === "/") {
        result += "  ";
        index += 2;
        state = "line-comment";
        continue;
      }
      if (character === "/" && next === "*") {
        result += "  ";
        index += 2;
        state = "block-comment";
        continue;
      }
      if (character === '"' || character === "'") {
        state = character === '"' ? "string" : "character";
        result += maskLiterals ? " " : character;
        index += 1;
        continue;
      }
      result += character;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      result += mask(character);
      index += 1;
      if (character === "\n") state = "code";
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 2;
        state = "code";
      } else {
        result += mask(character);
        index += 1;
      }
      continue;
    }

    const literalState = state;
    if (character === "\\" && next.length > 0) {
      result += maskLiterals ? `${mask(character)}${mask(next)}` : `${character}${next}`;
      index += 2;
      continue;
    }
    result += maskLiterals ? mask(character) : character;
    index += 1;
    if (
      (literalState === "string" && character === '"') ||
      (literalState === "character" && character === "'")
    ) {
      state = "code";
    }
  }

  return result;
}

/**
 * Conservative source policy for the remote compiler boundary. Firelight is a
 * lesson editor, not an arbitrary C++ build service: only Servo.h may be
 * explicitly included, and source-controlled compiler/assembler file features
 * are rejected again by the no-task-role Fargate compiler.
 */
export function validateArduinoSourcePolicy(source: string): readonly string[] {
  const messages = new Set<string>();
  if (FORBIDDEN_TRANSLATION_FEATURE.test(source)) {
    messages.add("Line splicing and alternate preprocessor tokens are not available here.");
  }
  const sourceWithoutComments = maskCppNonCode(source, false);
  for (const line of sourceWithoutComments.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#") && !ALLOWED_PREPROCESSOR_DIRECTIVE.test(line)) {
      messages.add("Only the lesson's #include <Servo.h> directive is available.");
    }
  }
  for (const feature of FORBIDDEN_COMPILER_FEATURES) {
    if (feature.pattern.test(sourceWithoutComments)) messages.add(feature.message);
  }
  return [...messages];
}

const requirements: Readonly<Record<string, readonly Requirement[]>> = {
  "first-spark-v1": [
    ...sharedSetupLoop,
    {
      test: (source) =>
        bodyMatches(
          source,
          "setup",
          /\bpinMode\s*\(\s*LED_BUILTIN\s*,\s*OUTPUT\s*\)\s*;/,
        ),
      message: "Configure LED_BUILTIN as an OUTPUT inside setup().",
    },
    {
      test: (source) => {
        const blinkMs = numericConstant(source, "BLINK_MS");
        return blinkMs !== null && blinkMs >= 200 && blinkMs <= 1_500;
      },
      message: "Set BLINK_MS to a whole number from 200 through 1500.",
    },
    {
      test: (source) =>
        bodyMatchesExactly(
          source,
          "loop",
          /^digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*HIGH\s*\)\s*;\s*delay\s*\(\s*BLINK_MS\s*\)\s*;\s*digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*LOW\s*\)\s*;\s*delay\s*\(\s*BLINK_MS\s*\)\s*;$/,
        ),
      message:
        "In loop(), turn LED_BUILTIN HIGH, wait BLINK_MS, turn it LOW, then wait the same BLINK_MS.",
    },
  ],
  "morse-name-v1": [
    ...sharedSetupLoop,
    {
      test: (source) => {
        const unitMs = numericConstant(source, "UNIT_MS");
        return unitMs !== null && unitMs >= 200 && unitMs <= 500;
      },
      message: "Set UNIT_MS to a whole number from 200 through 500.",
    },
    {
      test: (source) =>
        bodyMatches(
          source,
          "setup",
          /\bpinMode\s*\(\s*LED_BUILTIN\s*,\s*OUTPUT\s*\)\s*;/,
        ),
      message: "Configure LED_BUILTIN as an OUTPUT inside setup().",
    },
    {
      test: (source) =>
        bodyMatchesExactly(
          source,
          "pulse",
          /^digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*HIGH\s*\)\s*;\s*delay\s*\(\s*UNIT_MS\s*\*\s*onUnits\s*\)\s*;\s*digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*LOW\s*\)\s*;\s*delay\s*\(\s*UNIT_MS\s*\)\s*;$/,
        ),
      message:
        "Keep pulse(onUnits) as HIGH for UNIT_MS * onUnits, then LOW for one UNIT_MS.",
    },
    {
      test: (source) =>
        bodyMatchesExactly(source, "dot", /^pulse\s*\(\s*1\s*\)\s*;$/),
      message: "Keep dot() as a call to pulse(1).",
    },
    {
      test: (source) =>
        bodyMatchesExactly(source, "dash", /^pulse\s*\(\s*3\s*\)\s*;$/),
      message: "Keep dash() three times as long with pulse(3).",
    },
    {
      test: (source) =>
        bodyMatchesExactly(
          source,
          "letterGap",
          /^delay\s*\(\s*UNIT_MS\s*\*\s*2\s*\)\s*;$/,
        ),
      message:
        "Keep letterGap() at two extra units, making three low units including pulse()'s first unit.",
    },
    {
      test: (source) =>
        bodyMatchesExactly(
          source,
          "wordGap",
          /^delay\s*\(\s*UNIT_MS\s*\*\s*6\s*\)\s*;$/,
        ) &&
        bodyMatchesExactly(
          source,
          "messageGap",
          /^delay\s*\(\s*UNIT_MS\s*\*\s*6\s*\)\s*;$/,
        ),
      message:
        "Keep wordGap() and messageGap() at six extra units, making seven low units after pulse().",
    },
    {
      test: morseLoopIsStructured,
      message:
        "Use valid dot/dash letter groups in loop(), separate groups with letterGap() or wordGap(), and finish once with messageGap().",
    },
  ],
  "button-reaction-v1": [
    ...sharedSetupLoop,
    {
      test: (source) => numericConstant(source, "BUTTON_PIN") === 2,
      message: "Keep BUTTON_PIN fixed to Nano D2.",
    },
    {
      test: (source) => {
        const cueDelay = numericConstant(source, "CUE_DELAY_MS");
        return cueDelay !== null && cueDelay >= 1_500 && cueDelay <= 5_000;
      },
      message: "Set CUE_DELAY_MS to a whole number from 1500 through 5000.",
    },
    {
      test: (source) =>
        bodyMatches(
          source,
          "setup",
          /\bpinMode\s*\(\s*BUTTON_PIN\s*,\s*INPUT_PULLUP\s*\)\s*;/,
        ),
      message: "Configure the D2 button with INPUT_PULLUP inside setup().",
    },
    {
      test: (source) =>
        bodyMatches(
          source,
          "setup",
          /\bpinMode\s*\(\s*LED_BUILTIN\s*,\s*OUTPUT\s*\)\s*;/,
        ) && bodyMatches(source, "setup", /\bSerial\s*\.\s*begin\s*\(\s*9600\s*\)\s*;/),
      message: "Set up the cue LED as an OUTPUT and Serial at 9600 baud.",
    },
    {
      test: (source) =>
        bodyMatches(
          source,
          "loop",
          /\bdigitalRead\s*\(\s*BUTTON_PIN\s*\)\s*==\s*LOW/,
        ),
      message: "Inside loop(), treat LOW as the pressed INPUT_PULLUP state.",
    },
    {
      test: (source) => {
        const loop = functionBody(source, "loop");
        return loop !== null &&
          /\bmillis\s*\(\s*\)\s*-\s*waitStartedAt\s*>=\s*CUE_DELAY_MS/.test(loop) &&
          /\bmillis\s*\(\s*\)\s*-\s*cueStartedAt/.test(loop);
      },
      message:
        "Use millis() subtraction for both the cue delay and the elapsed reaction time.",
    },
    {
      test: (source) =>
        bodyMatches(
          source,
          "loop",
          /\bdigitalWrite\s*\(\s*LED_BUILTIN\s*,\s*HIGH\s*\)\s*;[\s\S]*?\bdigitalWrite\s*\(\s*LED_BUILTIN\s*,\s*LOW\s*\)\s*;/,
        ),
      message: "Turn the cue LED HIGH before timing and LOW after the accepted press.",
    },
    {
      test: (source) =>
        bodyMatches(
          source,
          "loop",
          /\bSerial\s*\.\s*println\s*\(\s*reactionTime\s*\)\s*;/,
        ),
      message: "Print the calculated reactionTime once with Serial.println().",
    },
    {
      test: (source) => {
        const loop = functionBody(source, "loop");
        if (!loop || !loopHasNoEarlyControlTransfer(source)) return false;
        const printCalls = [
          ...loop.matchAll(/\bSerial\s*\.\s*(?:print(?:ln)?|write)\s*\(/g),
        ];
        const allAssignments = [...loop.matchAll(/\bstate\s*=(?!=)/g)];
        const assignments = [...loop.matchAll(/\bstate\s*=\s*([A-Z_]+)\s*;/g)]
          .map((match) => match[1]);
        const expectedAssignments = [
          "WAITING_FOR_ARM_RELEASE",
          "WAITING_FOR_CUE",
          "WAITING_FOR_PRESS",
          "WAITING_FOR_RESULT_RELEASE",
          "READY_TO_ARM",
        ];
        return printCalls.length === 1 &&
          allAssignments.length === expectedAssignments.length &&
          assignments.length === expectedAssignments.length &&
          expectedAssignments.every(
            (expected) => assignments.filter((value) => value === expected).length === 1,
          ) &&
          /\bstate\s*==\s*WAITING_FOR_PRESS\b/.test(loop) &&
          /\bstate\s*=\s*WAITING_FOR_RESULT_RELEASE\s*;/.test(loop) &&
          /\bstate\s*==\s*WAITING_FOR_RESULT_RELEASE\s*&&\s*!\s*pressed/.test(loop) &&
          /\bstate\s*=\s*READY_TO_ARM\s*;/.test(loop);
      },
      message:
        "Keep exactly the five authored state transitions and one serial result so one hold produces one result.",
    },
  ],
  "distance-scout-v1": sharedSetupLoop,
  "servo-gate-v1": sharedSetupLoop,
  "trail-rover-v1": sharedSetupLoop,
};

function requirementIsSatisfied(
  requirement: Requirement,
  executableSource: string,
): boolean {
  return "test" in requirement
    ? requirement.test(executableSource)
    : requirement.pattern.test(executableSource);
}

export function validateLessonCode(
  validatorId: string,
  source: string,
): CodeValidationResult {
  const validatorRequirements = requirements[validatorId];
  if (!validatorRequirements) {
    return {
      valid: false,
      messages: ["This lesson validator is not available. Refresh the lesson and try again."],
    };
  }

  const executableSource = maskCppNonCode(source, true);
  const messages = validatorRequirements
    .filter((requirement) => !requirementIsSatisfied(requirement, executableSource))
    .map((requirement) => requirement.message);
  messages.push(...validateBuildsFourToSixCode(validatorId, executableSource));
  messages.push(...validateArduinoSourcePolicy(source));
  return { valid: messages.length === 0, messages };
}
