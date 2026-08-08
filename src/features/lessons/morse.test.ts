import { describe, expect, it } from "vitest";
import {
  validateArduinoSourcePolicy,
  validateLessonCode,
} from "./code-validation";
import { createMorseNameStarterCode } from "./morse";

function loopBody(source: string): string {
  return /void loop\(\) \{([\s\S]*?)\n\}/.exec(source)?.[1]?.trim() ?? "";
}

describe("personalized Morse starter code", () => {
  it("normalizes diacritics, keeps digits and spaces, and emits the correct signals", () => {
    const source = createMorseNameStarterCode("  É 2  ");

    expect(loopBody(source)).toBe(`dot();
  wordGap();
  dot();
  dot();
  dash();
  dash();
  dash();
  messageGap();`);
    expect(source).not.toContain("É 2");
  });

  it("uses ADA as the deterministic fallback without placing profile text in code", () => {
    const fallback = createMorseNameStarterCode("");
    expect(createMorseNameStarterCode("🤖🔥")).toBe(fallback);
    expect(fallback).toBe(createMorseNameStarterCode("ADA"));
    expect(loopBody(fallback)).toContain("dot();\n  dash();\n  letterGap();");
  });

  it("bounds a caller-supplied name to sixteen encoded characters", () => {
    const source = createMorseNameStarterCode("A".repeat(200));
    const body = loopBody(source);

    expect(body.match(/\b(?:dot|dash)\(\);/g)).toHaveLength(32);
    expect(body.match(/\bletterGap\(\);/g)).toHaveLength(15);
    expect(source.length).toBeLessThan(2_000);
  });

  it("emits only fixed statements even when profile text resembles source code", () => {
    const hostileName = `Ada";\n#include "/etc/passwd"\n//`;
    const source = createMorseNameStarterCode(hostileName);

    expect(source).not.toContain(hostileName);
    expect(source).not.toContain("#include");
    expect(source).not.toContain("/etc/passwd");
    expect(validateArduinoSourcePolicy(source)).toEqual([]);
  });

  it("accounts for pulse's low unit when defining letter, word, and repeat gaps", () => {
    const source = createMorseNameStarterCode("A B");

    expect(source).toMatch(
      /void pulse\(int onUnits\)[\s\S]*?digitalWrite\(LED_BUILTIN, LOW\);\s*delay\(UNIT_MS\);/,
    );
    expect(source).toMatch(/void letterGap\(\) \{\s*delay\(UNIT_MS \* 2\);\s*\}/);
    expect(source).toMatch(/void wordGap\(\) \{\s*delay\(UNIT_MS \* 6\);\s*\}/);
    expect(source).toMatch(/void messageGap\(\) \{\s*delay\(UNIT_MS \* 6\);\s*\}/);
  });

  it.each(["Ada", "Éowyn 42", "7", "A B", `#include "/tmp/nope"`])(
    "produces validator- and compiler-policy-compatible code for %s",
    (displayName) => {
      const source = createMorseNameStarterCode(displayName);
      expect(validateLessonCode("morse-name-v1", source)).toEqual({
        valid: true,
        messages: [],
      });
    },
  );
});
