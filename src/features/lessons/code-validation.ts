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

  const messages = validatorRequirements
    .filter((requirement) => !requirement.pattern.test(source))
    .map((requirement) => requirement.message);
  return { valid: messages.length === 0, messages };
}
