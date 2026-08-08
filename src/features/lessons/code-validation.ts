export interface CodeValidationResult {
  readonly valid: boolean;
  readonly messages: readonly string[];
}

interface Requirement {
  readonly pattern: RegExp;
  readonly message: string;
}

const sharedSetupLoop: readonly Requirement[] = [
  { pattern: /\bvoid\s+setup\s*\(/, message: "Add a setup() function." },
  { pattern: /\bvoid\s+loop\s*\(/, message: "Add a loop() function." },
];

const ALLOWED_PREPROCESSOR_DIRECTIVE = /^\s*#\s*include\s*<Servo\.h>\s*(?:\/\/.*)?$/;
const FORBIDDEN_TRANSLATION_FEATURE = /(?:\\(?:\r\n|\r|\n)|\?\?[=/'()!<>-]|%:)/;
const FORBIDDEN_COMPILER_FEATURES: readonly Requirement[] = [
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
      pattern: /pinMode\s*\(\s*LED_BUILTIN\s*,\s*OUTPUT\s*\)/,
      message: "Configure LED_BUILTIN as an OUTPUT.",
    },
    {
      pattern: /digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*HIGH\s*\)/,
      message: "Turn the built-in LED on with digitalWrite().",
    },
    {
      pattern: /digitalWrite\s*\(\s*LED_BUILTIN\s*,\s*LOW\s*\)/,
      message: "Turn the built-in LED off with digitalWrite().",
    },
    { pattern: /delay\s*\(\s*\d+\s*\)/, message: "Add a numeric delay between changes." },
  ],
  "morse-name-v1": [
    ...sharedSetupLoop,
    { pattern: /\bvoid\s+dot\s*\(/, message: "Keep a dot() helper." },
    { pattern: /\bvoid\s+dash\s*\(/, message: "Keep a dash() helper." },
    { pattern: /\b(dot|dash)\s*\(\s*\)/, message: "Call dot() or dash() in the signal." },
  ],
  "button-reaction-v1": [
    ...sharedSetupLoop,
    {
      pattern: /pinMode\s*\(\s*BUTTON_PIN\s*,\s*INPUT_PULLUP\s*\)/,
      message: "Configure the D2 button with INPUT_PULLUP.",
    },
    {
      pattern: /digitalRead\s*\(\s*BUTTON_PIN\s*\)\s*==\s*LOW/,
      message: "Treat LOW as the pressed button state.",
    },
    { pattern: /\bmillis\s*\(/, message: "Use millis() to measure reaction time." },
  ],
  "distance-scout-v1": [
    ...sharedSetupLoop,
    { pattern: /\bTRIG_PIN\s*=\s*9\b/, message: "Keep the trigger signal on D9." },
    { pattern: /\bECHO_PIN\s*=\s*10\b/, message: "Keep the echo signal on D10." },
    {
      pattern: /pulseIn\s*\([^,]+,[^,]+,\s*\d+\s*\)/,
      message: "Give pulseIn() a timeout so the sketch cannot wait forever.",
    },
    { pattern: /Serial\.println\s*\(/, message: "Print the calculated distance." },
  ],
  "servo-gate-v1": [
    ...sharedSetupLoop,
    { pattern: /#include\s*<Servo\.h>/, message: "Include the Servo library." },
    { pattern: /\.attach\s*\(\s*SERVO_PIN\s*\)/, message: "Attach the servo on D6." },
    { pattern: /\.write\s*\(\s*\d+\s*\)/, message: "Write at least one numeric angle." },
  ],
  "trail-rover-v1": [
    ...sharedSetupLoop,
    { pattern: /\bSTANDBY\s*=\s*12\b/, message: "Keep motor standby on D12." },
    { pattern: /\bstopMotors\s*\(/, message: "Keep a stopMotors() safety function." },
    { pattern: /\breadDistanceCm\s*\(/, message: "Keep a bounded distance-reading function." },
    {
      pattern: /distance\s*>\s*0\s*&&\s*distance\s*<\s*\d+/,
      message: "Stop only for a valid distance inside the safety threshold.",
    },
  ],
};

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
    .filter((requirement) => !requirement.pattern.test(executableSource))
    .map((requirement) => requirement.message);
  messages.push(...validateArduinoSourcePolicy(source));
  return { valid: messages.length === 0, messages };
}
