import { describe, expect, it } from "vitest";
import type { LessonProgress } from "../../../shared/identity";
import {
  mergeProgressCache,
  mergeProgressCollections,
} from "./progress-cache";

const timestamp = "2026-08-07T14:00:00.000Z";

function progress(revision: number, lessonVersion = 1): LessonProgress {
  return {
    lessonId: "first-spark",
    lessonVersion,
    revision,
    status: "in_progress",
    currentStep: `step-${String(revision)}`,
    percentage: revision * 10,
    codeSnapshot: null,
    completedAt: null,
    updatedAt: timestamp,
  };
}

describe("mergeProgressCache", () => {
  it("does not let a late save response replace a newer refreshed revision", () => {
    const current = [progress(4)] as const;

    expect(mergeProgressCache(current, progress(3))).toBe(current);
  });

  it("replaces an older checkpoint and preserves other lesson versions", () => {
    const olderVersion = progress(9, 2);

    expect(mergeProgressCache([progress(2), olderVersion], progress(3))).toEqual([
      olderVersion,
      progress(3),
    ]);
  });

  it("does not let a slower bootstrap refresh regress a completed save", () => {
    const cached = [{ ...progress(5), status: "completed" as const, percentage: 100 }];
    const staleBootstrap = [progress(4)];

    expect(mergeProgressCollections(cached, staleBootstrap)).toEqual(cached);
  });
});
