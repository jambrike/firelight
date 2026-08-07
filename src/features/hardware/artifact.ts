import type { CompileArtifact } from "./contracts";
import { FIRELIGHT_BOARD_FQBN } from "./contracts";
import { HardwareTransportError } from "./errors";
import {
  FIRELIGHT_MAX_SKETCH_BYTES,
  MAX_INTEL_HEX_TEXT_BYTES,
  parseIntelHex,
  type IntelHexImage,
} from "./intel-hex";

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Sha256Digest = (text: string) => Promise<string>;

export interface ArtifactValidationOptions {
  readonly digestHex?: Sha256Digest;
}

function invalid(message: string, cause?: unknown): never {
  throw new HardwareTransportError("artifact-invalid", message, cause);
}

export async function sha256TextHex(text: string): Promise<string> {
  const cryptoProvider = (globalThis as { readonly crypto?: Crypto }).crypto;
  if (cryptoProvider === undefined) {
    return invalid("This browser cannot securely validate the compiled artifact.");
  }
  const digest = await cryptoProvider.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Validates all server-controlled metadata and returns a bounded flash image. */
export async function validateCompileArtifact(
  artifact: unknown,
  options: ArtifactValidationOptions = {},
): Promise<IntelHexImage> {
  if (!artifact || typeof artifact !== "object") {
    return invalid("The compiler returned an invalid artifact.");
  }
  const candidate = artifact as Partial<Record<keyof CompileArtifact, unknown>>;
  if (
    typeof candidate.compileJobId !== "string" ||
    !LOWERCASE_UUID_V4.test(candidate.compileJobId)
  ) {
    return invalid("The compiled artifact has an invalid job identifier.");
  }
  if (candidate.format !== "intel-hex") {
    return invalid("The compiled artifact is not Intel HEX.");
  }
  if (candidate.fqbn !== FIRELIGHT_BOARD_FQBN) {
    return invalid("The compiled artifact targets a different board profile.");
  }
  if (
    typeof candidate.sourceHash !== "string" ||
    !LOWERCASE_SHA256.test(candidate.sourceHash)
  ) {
    return invalid("The compiled artifact has an invalid source hash.");
  }
  if (
    typeof candidate.artifactHash !== "string" ||
    !LOWERCASE_SHA256.test(candidate.artifactHash)
  ) {
    return invalid("The compiled artifact has an invalid artifact hash.");
  }
  if (
    !Array.isArray(candidate.diagnostics) ||
    candidate.diagnostics.some((item: unknown) => typeof item !== "string")
  ) {
    return invalid("The compiled artifact has invalid diagnostics metadata.");
  }
  if (typeof candidate.hex !== "string") {
    return invalid("The compiler returned invalid Intel HEX data.");
  }

  let image: IntelHexImage;
  try {
    image = parseIntelHex(candidate.hex, {
      maxAddressExclusive: FIRELIGHT_MAX_SKETCH_BYTES,
      maxTextBytes: MAX_INTEL_HEX_TEXT_BYTES,
    });
  } catch (error) {
    return invalid("The compiled Intel HEX artifact failed validation.", error);
  }

  if (image.startAddress !== 0) {
    return invalid("The compiled artifact does not contain the reset vector.");
  }

  let actualHash: string;
  try {
    actualHash = await (options.digestHex ?? sha256TextHex)(candidate.hex);
  } catch (error) {
    if (error instanceof HardwareTransportError) throw error;
    return invalid("The compiled artifact hash could not be verified.", error);
  }
  if (!LOWERCASE_SHA256.test(actualHash) || actualHash !== candidate.artifactHash) {
    return invalid("The compiled artifact hash does not match its contents.");
  }

  return image;
}
