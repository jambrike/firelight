import { ADMIN_KIT_BATCH_MAX_CODES } from "../shared/admin";

export const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CROCKFORD_KIT_CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

type SecureRandomFill = (bytes: Uint8Array) => Uint8Array;

function randomKitCode(fill: SecureRandomFill): string {
  const bytes = fill(new Uint8Array(16));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new TypeError("The secure random source returned invalid bytes.");
  }
  return Array.from(
    bytes,
    (byte) => CROCKFORD_BASE32_ALPHABET[byte & 31] ?? "",
  ).join("");
}

export function generateKitCodes(
  count: number,
  fill: SecureRandomFill = (bytes) => crypto.getRandomValues(bytes),
): readonly string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > ADMIN_KIT_BATCH_MAX_CODES) {
    throw new RangeError(`Kit batches must contain 1 to ${String(ADMIN_KIT_BATCH_MAX_CODES)} codes.`);
  }

  const codes = new Set<string>();
  const maximumAttempts = count * 8;
  for (let attempt = 0; attempt < maximumAttempts && codes.size < count; attempt += 1) {
    codes.add(randomKitCode(fill));
  }
  if (codes.size !== count) {
    throw new Error("The secure random source could not produce a unique kit batch.");
  }
  return [...codes];
}

export function formatKitCode(code: string): string {
  if (!CROCKFORD_KIT_CODE_PATTERN.test(code)) {
    throw new TypeError("A canonical 16-character Crockford code is required.");
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`;
}

async function importPepper(pepper: string): Promise<CryptoKey> {
  if (pepper.length < 16) {
    throw new Error("The kit-code pepper is not configured.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signCode(key: CryptoKey, code: string): Promise<string> {
  if (!CROCKFORD_KIT_CODE_PATTERN.test(code)) {
    throw new TypeError("A canonical 16-character Crockford code is required.");
  }
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(code),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hashKitCode(code: string, pepper: string): Promise<string> {
  return signCode(await importPepper(pepper), code);
}

export async function hashKitCodes(
  codes: readonly string[],
  pepper: string,
): Promise<readonly string[]> {
  const key = await importPepper(pepper);
  return Promise.all(codes.map((code) => signCode(key, code)));
}
