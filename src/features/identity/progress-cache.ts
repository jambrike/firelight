import type { LessonProgress } from "../../../shared/identity";

/** Keeps the bootstrap cache monotonic when refreshes and saves resolve out of order. */
export function mergeProgressCache(
  current: readonly LessonProgress[],
  incoming: LessonProgress,
): readonly LessonProgress[] {
  const existing = current.find(
    (item) =>
      item.lessonId === incoming.lessonId &&
      item.lessonVersion === incoming.lessonVersion,
  );
  if (existing && existing.revision >= incoming.revision) return current;
  return [
    ...current.filter(
      (item) =>
        item.lessonId !== incoming.lessonId ||
        item.lessonVersion !== incoming.lessonVersion,
    ),
    incoming,
  ];
}

/** Merges a bootstrap snapshot without allowing a slower refresh to regress a save. */
export function mergeProgressCollections(
  cached: readonly LessonProgress[],
  incoming: readonly LessonProgress[],
): readonly LessonProgress[] {
  let merged = incoming;
  for (const progress of cached) {
    merged = mergeProgressCache(merged, progress);
  }
  return merged;
}
