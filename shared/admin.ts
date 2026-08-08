import type { LessonSlug } from "./curriculum";
import type {
  KitActivationKind,
  LessonProgressStatus,
  ProfileRole,
} from "./identity";

export const ADMIN_PAGE_DEFAULT_LIMIT = 20;
export const ADMIN_PAGE_MAX_LIMIT = 50;
export const ADMIN_PAGE_MAX_OFFSET = 10_000;
export const ADMIN_KIT_BATCH_MAX_CODES = 100;

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset: number | null;
}

export type AdminKitCodeState = "issued" | "claimed" | "revoked";

export interface AdminKitRecord {
  readonly id: string;
  readonly batch: string;
  readonly state: AdminKitCodeState;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface GeneratedKitBatch {
  readonly batch: string;
  readonly codes: readonly GeneratedKitCode[];
  readonly generatedAt: string;
}

export interface GeneratedKitCode {
  /** Stable database identifier used for support lookup and targeted revocation. */
  readonly id: string;
  /** One-time plaintext activation code. It is never persisted by Firelight. */
  readonly code: string;
}

export interface AdminLearnerSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: ProfileRole;
  readonly accessSource: KitActivationKind | null;
  readonly activationBatch: string | null;
  readonly completedLessons: number;
  readonly progressRecords: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminProgressRecord {
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly status: LessonProgressStatus;
  readonly currentStep: string;
  readonly percentage: number;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export type AdminCompileState = "queued" | "running" | "succeeded" | "failed";

export interface AdminCompileDiagnostic {
  readonly id: string;
  readonly userId: string;
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly state: AdminCompileState;
  readonly durationMs: number | null;
  readonly safeErrorCode: string | null;
  readonly diagnosticSummary: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface AdminAuditEntry {
  readonly id: number;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AdminLearnerProgress {
  readonly learner: AdminLearnerSummary;
  readonly progress: AdminPage<AdminProgressRecord>;
}

export interface AdminKitBatchInput {
  readonly batch: string;
  readonly count: number;
}

export interface AdminKitRevocationInput {
  readonly reason: "lost" | "damaged" | "support" | "security" | "other";
}

export interface AdminKitRevocationResult {
  readonly id: string;
  readonly state: "revoked" | "already_revoked";
  readonly accessRevoked: boolean;
}
