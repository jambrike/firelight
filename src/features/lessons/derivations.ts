import { lessonCatalog } from "./catalog";
import type { LessonCatalogEntry, LessonSlug } from "./catalog";

export type LessonProgressViewStatus = "not_started" | "in_progress" | "completed";

export interface LessonProgressView {
  readonly lessonId: string;
  readonly lessonVersion: number;
  readonly revision?: number;
  readonly status: LessonProgressViewStatus;
  readonly percentage: number;
}

export interface LessonPrerequisiteState {
  readonly satisfied: boolean;
  readonly required: readonly LessonSlug[];
  readonly completed: readonly LessonSlug[];
  readonly missing: readonly LessonSlug[];
}

export type LessonAccessState = "locked" | "available" | "in-progress" | "completed";

export interface CurriculumProgressSummary {
  readonly completedLessons: number;
  readonly totalLessons: number;
  readonly percentage: number;
}

export type LessonAchievementId = "first-upload" | "name-signal" | "trail-complete";

export interface DerivedLessonAchievement {
  readonly id: LessonAchievementId;
  readonly label: string;
  readonly earned: boolean;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function getCurrentLessonProgress<TProgress extends LessonProgressView>(
  lesson: LessonCatalogEntry,
  progress: readonly TProgress[],
): TProgress | undefined {
  const candidates = progress.filter(
    (item) => item.lessonId === lesson.id && item.lessonVersion === lesson.version,
  );

  return candidates.reduce<TProgress | undefined>((best, candidate) => {
    if (!best) return candidate;
    if (
      best.revision !== undefined &&
      candidate.revision !== undefined &&
      best.revision !== candidate.revision
    ) {
      return candidate.revision > best.revision ? candidate : best;
    }
    if (candidate.status === "completed" && best.status !== "completed") return candidate;
    if (best.status === "completed" && candidate.status !== "completed") return best;
    return clampPercentage(candidate.percentage) > clampPercentage(best.percentage)
      ? candidate
      : best;
  }, undefined);
}

export function deriveCompletedLessonIds(
  progress: readonly LessonProgressView[],
  catalog: readonly LessonCatalogEntry[] = lessonCatalog,
): ReadonlySet<LessonSlug> {
  return new Set(
    catalog
      .filter((lesson) => getCurrentLessonProgress(lesson, progress)?.status === "completed")
      .map((lesson) => lesson.id),
  );
}

export function derivePrerequisiteState(
  lesson: LessonCatalogEntry,
  progress: readonly LessonProgressView[],
  catalog: readonly LessonCatalogEntry[] = lessonCatalog,
): LessonPrerequisiteState {
  const completedIds = deriveCompletedLessonIds(progress, catalog);
  const completed = lesson.prerequisites.filter((id) => completedIds.has(id));
  const missing = lesson.prerequisites.filter((id) => !completedIds.has(id));

  return {
    satisfied: missing.length === 0,
    required: lesson.prerequisites,
    completed,
    missing,
  };
}

export function deriveLessonAccessState(
  lesson: LessonCatalogEntry,
  progress: readonly LessonProgressView[],
  catalog: readonly LessonCatalogEntry[] = lessonCatalog,
): LessonAccessState {
  const saved = getCurrentLessonProgress(lesson, progress);
  if (saved?.status === "completed") return "completed";
  if (!derivePrerequisiteState(lesson, progress, catalog).satisfied) return "locked";
  if (saved?.status === "in_progress") return "in-progress";
  return "available";
}

/** Returns the earliest unlocked unfinished lesson, preferring its saved in-progress state. */
export function deriveNextLesson(
  progress: readonly LessonProgressView[],
  catalog: readonly LessonCatalogEntry[] = lessonCatalog,
): LessonCatalogEntry | null {
  return (
    catalog.find((lesson) => {
      const state = deriveLessonAccessState(lesson, progress, catalog);
      return state === "available" || state === "in-progress";
    }) ?? null
  );
}

/**
 * Derives trail progress from current lesson versions only. Completed lessons
 * contribute 100%; unfinished lessons contribute their greatest saved percentage.
 */
export function deriveCurriculumProgress(
  progress: readonly LessonProgressView[],
  catalog: readonly LessonCatalogEntry[] = lessonCatalog,
): CurriculumProgressSummary {
  if (catalog.length === 0) {
    return { completedLessons: 0, totalLessons: 0, percentage: 0 };
  }

  let completedLessons = 0;
  let percentageTotal = 0;

  for (const lesson of catalog) {
    const saved = getCurrentLessonProgress(lesson, progress);
    if (saved?.status === "completed") {
      completedLessons += 1;
      percentageTotal += 100;
    } else if (saved) {
      percentageTotal += clampPercentage(saved.percentage);
    }
  }

  return {
    completedLessons,
    totalLessons: catalog.length,
    percentage: Math.round(percentageTotal / catalog.length),
  };
}

export function deriveLessonAchievements(
  progress: readonly LessonProgressView[],
  catalog: readonly LessonCatalogEntry[] = lessonCatalog,
): readonly DerivedLessonAchievement[] {
  const completedIds = deriveCompletedLessonIds(progress, catalog);

  return [
    {
      id: "first-upload",
      label: "First Upload",
      earned: completedIds.has("first-spark"),
    },
    {
      id: "name-signal",
      label: "Name Signal",
      earned: completedIds.has("morse-name"),
    },
    {
      id: "trail-complete",
      label: "Trail Complete",
      earned: catalog.length > 0 && catalog.every((lesson) => completedIds.has(lesson.id)),
    },
  ];
}
