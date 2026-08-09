const MORSE_PATTERNS: Readonly<Record<string, string>> = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  0: "-----",
  1: ".----",
  2: "..---",
  3: "...--",
  4: "....-",
  5: ".....",
  6: "-....",
  7: "--...",
  8: "---..",
  9: "----.",
};

const FALLBACK_MORSE_NAME = "ADA";
const MAX_INPUT_CODE_POINTS = 80;
const MAX_ENCODED_CHARACTERS = 16;

/**
 * Produce a small A-Z/0-9 representation without ever returning raw profile
 * text. Profile names are already bounded at the API, but this second bound
 * keeps the generator safe and deterministic when called independently.
 */
function normalizeMorseName(displayName: string): string {
  const boundedInput = Array.from(displayName)
    .slice(0, MAX_INPUT_CODE_POINTS)
    .join("");
  const expandedLatin = boundedInput
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toUpperCase()
    .replaceAll("Æ", "AE")
    .replaceAll("Œ", "OE")
    .replaceAll("Ø", "O")
    .replaceAll("Ł", "L")
    .replaceAll("Ð", "D")
    .replaceAll("Þ", "TH");
  const words = expandedLatin
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Z0-9]/g, ""))
    .filter((word) => word.length > 0);

  const boundedWords: string[] = [];
  let remaining = MAX_ENCODED_CHARACTERS;
  for (const word of words) {
    if (remaining === 0) break;
    const boundedWord = word.slice(0, remaining);
    if (boundedWord.length > 0) boundedWords.push(boundedWord);
    remaining -= boundedWord.length;
  }

  return boundedWords.join(" ") || FALLBACK_MORSE_NAME;
}

function signalCalls(normalizedName: string): string {
  const words = normalizedName.split(" ");
  const lines: string[] = [];

  words.forEach((word, wordIndex) => {
    Array.from(word).forEach((character, characterIndex) => {
      const pattern = MORSE_PATTERNS[character];
      if (!pattern) return;
      for (const mark of pattern) {
        lines.push(mark === "." ? "  dot();" : "  dash();");
      }
      if (characterIndex < word.length - 1) lines.push("  letterGap();");
    });
    if (wordIndex < words.length - 1) lines.push("  wordGap();");
  });

  lines.push("  messageGap();");
  return lines.join("\n");
}

/**
 * Build a compiler-policy-compatible sketch for a profile display name.
 * Only fixed Arduino statements are emitted; the supplied text is never
 * interpolated into source, comments, identifiers, or literals.
 */
export function createMorseNameStarterCode(displayName: string): string {
  const body = signalCalls(normalizeMorseName(displayName));

  return `const unsigned int UNIT_MS = 200;

void pulse(int onUnits) {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(UNIT_MS * onUnits);
  digitalWrite(LED_BUILTIN, LOW);
  delay(UNIT_MS);
}

void dot() {
  pulse(1);
}

void dash() {
  pulse(3);
}

void letterGap() {
  delay(UNIT_MS * 2);
}

void wordGap() {
  delay(UNIT_MS * 6);
}

void messageGap() {
  delay(UNIT_MS * 6);
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
${body}
}
`;
}
