import type { LessonSlug } from "./curriculum";

export type ProfileRole = "learner" | "admin";
export type KitActivationKind = "code" | "grandfathered";
export type LessonProgressStatus = "not_started" | "in_progress" | "completed";

export interface PublicRuntimeConfig {
  readonly apiVersion: "v1";
  readonly environment: string;
  readonly buildId: string;
  readonly supabase: {
    readonly url: string;
    readonly publishableKey: string;
  };
  readonly hardware: {
    readonly fqbn: "arduino:avr:nano:cpu=atmega328old";
    readonly uploadBaud: 57_600;
  };
}

export interface LearnerProfile {
  readonly id: string;
  readonly displayName: string;
  readonly role: ProfileRole;
  readonly email: string;
  readonly emailConfirmed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KitActivation {
  readonly id: string;
  readonly batch: string;
  readonly kind: KitActivationKind;
  readonly claimedAt: string;
}

export interface LessonProgress {
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  /** Monotonic optimistic-concurrency token for cross-device saves. */
  readonly revision: number;
  readonly status: LessonProgressStatus;
  readonly currentStep: string;
  readonly percentage: number;
  readonly codeSnapshot: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface Achievement {
  readonly id: "first-upload" | "name-signal" | "trail-complete";
  readonly label: string;
  readonly earned: boolean;
}

export interface NextLesson {
  readonly id: LessonSlug;
  readonly title: string;
}

export interface BootstrapData {
  readonly profile: LearnerProfile;
  readonly activation: KitActivation | null;
  readonly progress: readonly LessonProgress[];
  readonly achievements: readonly Achievement[];
  readonly nextLesson: NextLesson | null;
}

export interface ProgressUpdateInput {
  readonly lessonVersion: number;
  /** `null` creates the first checkpoint; otherwise the save must match this revision. */
  readonly expectedRevision: number | null;
  readonly status: LessonProgressStatus;
  readonly currentStep: string;
  readonly percentage: number;
  readonly codeSnapshot?: string | null;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export interface ApiDataBody<T> {
  readonly data: T;
}
