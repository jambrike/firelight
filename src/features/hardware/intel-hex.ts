export const ATMEGA328P_FLASH_BYTES = 32_768;
export const FIRELIGHT_MAX_SKETCH_BYTES = 30_720;
export const MAX_INTEL_HEX_TEXT_BYTES = 128 * 1024;

export type IntelHexErrorCode =
  | "empty-input"
  | "text-too-large"
  | "invalid-record"
  | "invalid-checksum"
  | "invalid-record-data"
  | "unsupported-record-type"
  | "overlapping-data"
  | "address-out-of-range"
  | "missing-eof"
  | "data-after-eof"
  | "no-data";

export class IntelHexParseError extends Error {
  readonly code: IntelHexErrorCode;
  readonly lineNumber?: number;

  constructor(code: IntelHexErrorCode, message: string, lineNumber?: number) {
    super(message);
    this.name = "IntelHexParseError";
    this.code = code;
    if (lineNumber !== undefined) this.lineNumber = lineNumber;
  }
}

export interface IntelHexParseOptions {
  /** Exclusive upper bound for decoded addresses. */
  readonly maxAddressExclusive?: number;
  readonly maxTextBytes?: number;
}

export interface IntelHexImage {
  /** Dense image from address zero; gaps are erased-flash bytes (0xff). */
  readonly data: Uint8Array;
  readonly dataByteCount: number;
  readonly startAddress: number;
  readonly endAddressExclusive: number;
}

const HEX_BYTE = /^[0-9a-fA-F]{2}$/;

function fail(
  code: IntelHexErrorCode,
  message: string,
  lineNumber?: number,
): never {
  throw new IntelHexParseError(code, message, lineNumber);
}

function validatePositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function decodeRecord(line: string, lineNumber: number): Uint8Array {
  if (!line.startsWith(":")) {
    return fail("invalid-record", "Intel HEX records must begin with a colon.", lineNumber);
  }

  const encoded = line.slice(1);
  if (encoded.length < 10 || encoded.length % 2 !== 0) {
    return fail("invalid-record", "Intel HEX record length is invalid.", lineNumber);
  }

  const bytes = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const encodedByte = encoded.slice(index * 2, index * 2 + 2);
    if (!HEX_BYTE.test(encodedByte)) {
      return fail("invalid-record", "Intel HEX contains a non-hexadecimal byte.", lineNumber);
    }
    bytes[index] = Number.parseInt(encodedByte, 16);
  }

  const byteCount = bytes[0];
  if (byteCount === undefined || bytes.length !== byteCount + 5) {
    return fail("invalid-record", "Intel HEX byte count does not match the record.", lineNumber);
  }

  let checksum = 0;
  for (const byte of bytes) checksum = (checksum + byte) & 0xff;
  if (checksum !== 0) {
    return fail("invalid-checksum", "Intel HEX checksum validation failed.", lineNumber);
  }

  return bytes;
}

function requireControlRecord(
  address: number,
  data: Uint8Array,
  expectedLength: number,
  typeName: string,
  lineNumber: number,
): void {
  if (address !== 0 || data.length !== expectedLength) {
    fail(
      "invalid-record-data",
      `${typeName} record has invalid address or data length.`,
      lineNumber,
    );
  }
}

/**
 * Strictly decodes Intel HEX while accepting the standard addressing and start-address
 * records emitted by AVR toolchains. Overlaps and records after EOF are rejected so a
 * single artifact cannot have ambiguous flash semantics.
 */
export function parseIntelHex(
  hex: string,
  options: IntelHexParseOptions = {},
): IntelHexImage {
  if (typeof hex !== "string" || hex.trim().length === 0) {
    return fail("empty-input", "Intel HEX input is empty.");
  }

  const maxAddressExclusive = validatePositiveLimit(
    options.maxAddressExclusive ?? ATMEGA328P_FLASH_BYTES,
    "maxAddressExclusive",
  );
  const maxTextBytes = validatePositiveLimit(
    options.maxTextBytes ?? MAX_INTEL_HEX_TEXT_BYTES,
    "maxTextBytes",
  );
  if (new TextEncoder().encode(hex).byteLength > maxTextBytes) {
    return fail("text-too-large", "Intel HEX input exceeds the accepted size limit.");
  }

  const memory = new Map<number, number>();
  let addressBase = 0;
  let eofSeen = false;
  let dataByteCount = 0;
  let startAddress = Number.POSITIVE_INFINITY;
  let endAddressExclusive = 0;
  const lines = hex.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex]?.trim() ?? "";
    if (line.length === 0) continue;
    if (eofSeen) {
      return fail("data-after-eof", "Intel HEX contains a record after EOF.", lineNumber);
    }

    const record = decodeRecord(line, lineNumber);
    const byteCount = record[0] ?? 0;
    const address = ((record[1] ?? 0) << 8) | (record[2] ?? 0);
    const recordType = record[3] ?? -1;
    const data = record.slice(4, 4 + byteCount);

    switch (recordType) {
      case 0x00: {
        const absoluteAddress = addressBase + address;
        const recordEnd = absoluteAddress + data.length;
        if (
          !Number.isSafeInteger(absoluteAddress) ||
          recordEnd > maxAddressExclusive ||
          recordEnd < absoluteAddress
        ) {
          return fail(
            "address-out-of-range",
            "Intel HEX data falls outside the supported flash range.",
            lineNumber,
          );
        }
        for (let index = 0; index < data.length; index += 1) {
          const targetAddress = absoluteAddress + index;
          if (memory.has(targetAddress)) {
            return fail(
              "overlapping-data",
              "Intel HEX contains overlapping data records.",
              lineNumber,
            );
          }
          memory.set(targetAddress, data[index] ?? 0xff);
        }
        if (data.length > 0) {
          dataByteCount += data.length;
          startAddress = Math.min(startAddress, absoluteAddress);
          endAddressExclusive = Math.max(endAddressExclusive, recordEnd);
        }
        break;
      }
      case 0x01:
        requireControlRecord(address, data, 0, "EOF", lineNumber);
        eofSeen = true;
        break;
      case 0x02:
        requireControlRecord(address, data, 2, "extended segment address", lineNumber);
        addressBase = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) * 16;
        break;
      case 0x03:
        requireControlRecord(address, data, 4, "start segment address", lineNumber);
        break;
      case 0x04:
        requireControlRecord(address, data, 2, "extended linear address", lineNumber);
        addressBase = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) * 65_536;
        break;
      case 0x05:
        requireControlRecord(address, data, 4, "start linear address", lineNumber);
        break;
      default:
        return fail(
          "unsupported-record-type",
          "Intel HEX contains an unsupported record type.",
          lineNumber,
        );
    }
  }

  if (!eofSeen) return fail("missing-eof", "Intel HEX is missing its EOF record.");
  if (dataByteCount === 0) return fail("no-data", "Intel HEX contains no flash data.");

  const image = new Uint8Array(endAddressExclusive).fill(0xff);
  for (const [address, byte] of memory) image[address] = byte;

  return {
    data: image,
    dataByteCount,
    startAddress,
    endAddressExclusive,
  };
}
