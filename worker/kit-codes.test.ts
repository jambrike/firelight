import { describe, expect, it } from "vitest";
import {
  CROCKFORD_BASE32_ALPHABET,
  formatKitCode,
  generateKitCodes,
  hashKitCode,
  hashKitCodes,
} from "./kit-codes";

describe("admin kit-code generation", () => {
  it("maps secure random bytes to 16 unambiguous Crockford symbols", () => {
    let call = 0;
    const codes = generateKitCodes(2, (bytes) => {
      const offset = call * 16;
      call += 1;
      bytes.forEach((_, index) => {
        bytes[index] = index + offset;
      });
      return bytes;
    });

    expect(codes).toEqual([
      CROCKFORD_BASE32_ALPHABET.slice(0, 16),
      CROCKFORD_BASE32_ALPHABET.slice(16, 32),
    ]);
    expect(codes.every((code) => /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code))).toBe(true);
  });

  it("fails closed when the random source cannot make a unique batch", () => {
    expect(() => generateKitCodes(2, (bytes) => bytes.fill(0))).toThrow(
      "could not produce a unique kit batch",
    );
  });

  it("rejects unsafe batch sizes and formats plaintext only for one-time display", () => {
    expect(() => generateKitCodes(0)).toThrow(RangeError);
    expect(() => generateKitCodes(101)).toThrow(RangeError);
    expect(formatKitCode("0123456789ABCDEF")).toBe("0123-4567-89AB-CDEF");
  });

  it("stores stable peppered HMACs rather than plaintext", async () => {
    const code = "0123456789ABCDEF";
    const hashes = await hashKitCodes([code], "one-long-local-pepper");
    const repeated = await hashKitCode(code, "one-long-local-pepper");
    const differentPepper = await hashKitCode(code, "another-local-pepper");

    expect(hashes).toEqual([repeated]);
    expect(repeated).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated).not.toContain(code);
    expect(differentPepper).not.toBe(repeated);
  });
});
