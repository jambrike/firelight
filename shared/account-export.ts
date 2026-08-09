import type { LessonSlug } from "./curriculum";
import type { UploadEvidence } from "./hardware";
import type { KitActivation, LearnerProfile, LessonProgress } from "./identity";

export const ACCOUNT_EXPORT_SCHEMA = "firelight.account-export" as const;

/**
 * Version 1 was the browser-composed bootstrap snapshot. Version 2 is the
 * authoritative server export containing every bounded owner record.
 */
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 2 as const;

export const ACCOUNT_EXPORT_MAX_PROGRESS_RECORDS = 256;
export const ACCOUNT_EXPORT_MAX_COMPILE_JOBS = 10_000;
export const ACCOUNT_EXPORT_MAX_UPLOAD_EVIDENCE = 10_000;
export const ACCOUNT_EXPORT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type AccountExportCompileState = "queued" | "running" | "succeeded" | "failed";

export interface AccountExportCompileJob {
  readonly id: string;
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly boardTarget: string;
  readonly sourceHash: string;
  readonly state: AccountExportCompileState;
  readonly durationMs: number | null;
  readonly safeErrorCode: string | null;
  readonly artifactHash: string | null;
  readonly diagnosticSummary: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface AccountExportData {
  /** Profile fields plus the email and confirmation state from Supabase Auth. */
  readonly profile: LearnerProfile;
  /** Safe activation projection only; kit plaintext and HMAC fields never enter this schema. */
  readonly activation: KitActivation | null;
  /** Every stored lesson/version row, including the learner's optional code snapshot. */
  readonly progress: readonly LessonProgress[];
  /** Compile metadata only. Raw source and Intel HEX artifacts are not stored or exported. */
  readonly compileJobs: readonly AccountExportCompileJob[];
  /** Browser upload attestations and hashes; no serial stream or artifact body is retained. */
  readonly uploadEvidence: readonly UploadEvidence[];
}

export interface AccountExport {
  readonly schema: typeof ACCOUNT_EXPORT_SCHEMA;
  readonly version: typeof ACCOUNT_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly data: AccountExportData;
}
