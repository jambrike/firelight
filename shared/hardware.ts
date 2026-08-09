import type { LessonSlug } from "./curriculum";

export const FIRELIGHT_BOARD_FQBN = "arduino:avr:nano:cpu=atmega328old";
export const FIRELIGHT_UPLOAD_BAUD = 57_600;
export const MAX_SKETCH_SOURCE_BYTES = 65_536;
export const MAX_COMPILER_RESPONSE_BYTES = 192 * 1024;
export const MAX_NANO_UPLOAD_BYTES = 30_720;

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Strict RFC 3339 subset emitted by Postgres for application timestamps. */
export function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    maximumDay !== undefined &&
    day >= 1 &&
    day <= maximumDay &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
}

export interface CompileSketchInput {
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly fqbn: typeof FIRELIGHT_BOARD_FQBN;
  readonly source: string;
}

export interface CompileArtifact {
  readonly compileJobId: string;
  readonly format: "intel-hex";
  readonly fqbn: typeof FIRELIGHT_BOARD_FQBN;
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly hex: string;
  readonly diagnostics: readonly string[];
}

export interface UploadEvidenceInput {
  readonly compileJobId: string;
  readonly artifactHash: string;
  readonly bytesWritten: number;
}

export interface UploadEvidence {
  readonly id: string;
  readonly compileJobId: string;
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly bytesWritten: number;
  readonly recordedAt: string;
  /**
   * Evidence is asserted by the authenticated browser after Web Serial reports
   * success. It is deliberately not represented as cryptographic device proof.
   */
  readonly attestation: "browser-web-serial-v1";
}
