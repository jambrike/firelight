import { describe, expect, it, vi } from "vitest";
import type { CompileArtifact } from "./contracts";
import { FIRELIGHT_BOARD_FQBN } from "./contracts";
import type { HardwareTransportError } from "./errors";
import { sha256TextHex, validateCompileArtifact } from "./artifact";
import { intelHexDocument, intelHexRecord } from "./testing/serial-mock";

const SOURCE_HASH = "a".repeat(64);
const ARTIFACT_HASH = "b".repeat(64);

function artifact(overrides: Partial<CompileArtifact> = {}): CompileArtifact {
  return {
    compileJobId: "123e4567-e89b-42d3-a456-426614174000",
    format: "intel-hex",
    fqbn: FIRELIGHT_BOARD_FQBN,
    sourceHash: SOURCE_HASH,
    artifactHash: ARTIFACT_HASH,
    hex: intelHexDocument(
      intelHexRecord(0, 0x00, [0x0c, 0x94, 0x00, 0x00]),
      intelHexRecord(0, 0x01, []),
    ),
    diagnostics: [],
    ...overrides,
  };
}

async function expectInvalid(value: CompileArtifact): Promise<void> {
  await expect(
    validateCompileArtifact(value, { digestHex: async () => ARTIFACT_HASH }),
  ).rejects.toMatchObject({
    code: "artifact-invalid" satisfies HardwareTransportError["code"],
  });
}

describe("compiled artifact validation", () => {
  it("checks metadata, exact-text hash, reset vector, and decoded image", async () => {
    const digestHex = vi.fn(async () => ARTIFACT_HASH);
    const result = await validateCompileArtifact(artifact(), { digestHex });

    expect(digestHex).toHaveBeenCalledOnce();
    expect(digestHex).toHaveBeenCalledWith(artifact().hex);
    expect([...result.data]).toEqual([0x0c, 0x94, 0x00, 0x00]);
  });

  it("rejects untrusted job, board, hash, and diagnostics metadata", async () => {
    await expectInvalid(artifact({ compileJobId: "not-a-job" }));
    await expectInvalid(artifact({ sourceHash: SOURCE_HASH.toUpperCase() }));
    await expectInvalid(artifact({ artifactHash: "short" }));
    await expectInvalid(
      artifact({ fqbn: "arduino:avr:nano" as typeof FIRELIGHT_BOARD_FQBN }),
    );
    await expectInvalid(
      artifact({ diagnostics: [4] as unknown as readonly string[] }),
    );
  });

  it("rejects tampering, malformed HEX, bootloader writes, and partial images", async () => {
    await expect(
      validateCompileArtifact(artifact(), { digestHex: async () => "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "artifact-invalid" });

    await expectInvalid(artifact({ hex: ":bad\n" }));
    await expectInvalid(
      artifact({
        hex: intelHexDocument(
          intelHexRecord(30_719, 0x00, [1, 2]),
          intelHexRecord(0, 0x01, []),
        ),
      }),
    );
    await expectInvalid(
      artifact({
        hex: intelHexDocument(
          intelHexRecord(2, 0x00, [1, 2]),
          intelHexRecord(0, 0x01, []),
        ),
      }),
    );
  });

  it("hashes the exact UTF-8 artifact text with SHA-256", async () => {
    await expect(sha256TextHex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
