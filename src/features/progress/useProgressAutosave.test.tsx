import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonProgress, ProgressUpdateInput } from "../../../shared/identity";
import { WebStorageProgressDraftPersistence } from "./draft-persistence";
import { useProgressAutosave } from "./useProgressAutosave";

function savedResult(input: ProgressUpdateInput): LessonProgress {
  return {
    lessonId: "first-spark",
    lessonVersion: input.lessonVersion,
    revision: 1,
    status: input.status,
    currentStep: input.currentStep,
    percentage: input.percentage,
    codeSnapshot: input.codeSnapshot ?? null,
    completedAt: input.status === "completed" ? "2026-08-07T10:00:00.000Z" : null,
    updatedAt: "2026-08-07T10:00:00.000Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("useProgressAutosave", () => {
  it("flushes queued progress when the lesson workspace unmounts", async () => {
    const saveProgress = vi.fn(async (_lessonId, input: ProgressUpdateInput) =>
      savedResult(input),
    );
    const { result, unmount } = renderHook(() =>
      useProgressAutosave({
        lessonId: "first-spark",
        lessonVersion: 1,
        initialProgress: null,
        saveProgress,
        resolveConflict: vi.fn(async () => null),
        debounceMs: 30_000,
      }),
    );

    act(() => {
      result.current.queue({
        status: "in_progress",
        currentStep: "edit-code",
        percentage: 35,
        codeSnapshot: "void setup() {}",
      });
    });
    expect(saveProgress).not.toHaveBeenCalled();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(saveProgress).toHaveBeenCalledOnce();
    expect(saveProgress).toHaveBeenCalledWith("first-spark", {
      lessonVersion: 1,
      expectedRevision: null,
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 35,
      codeSnapshot: "void setup() {}",
    });
  });

  it("exposes a durable draft to the workspace and removes it after server confirmation", async () => {
    const draftOwnerId = "11111111-1111-4111-8111-111111111111";
    const draftPersistence = new WebStorageProgressDraftPersistence(window.localStorage);
    const scope = {
      ownerId: draftOwnerId,
      lessonId: "first-spark",
      lessonVersion: 1,
    } as const;
    const recovered = {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 35,
      codeSnapshot: "void setup() {}",
    } as const;
    draftPersistence.save(scope, recovered);
    const saveProgress = vi.fn(async (_lessonId, input: ProgressUpdateInput) =>
      savedResult(input),
    );
    const { result, unmount } = renderHook(() =>
      useProgressAutosave({
        lessonId: "first-spark",
        lessonVersion: 1,
        initialProgress: null,
        saveProgress,
        resolveConflict: vi.fn(async () => null),
        debounceMs: 30_000,
        draftOwnerId,
        draftPersistence,
      }),
    );

    expect(result.current.status).toMatchObject({
      dirty: true,
      restoredDraft: recovered,
    });

    await act(async () => {
      await result.current.flush();
    });

    expect(saveProgress).toHaveBeenCalledOnce();
    expect(result.current.status).toMatchObject({
      phase: "saved",
      dirty: false,
      restoredDraft: null,
    });
    expect(draftPersistence.load(scope)).toBeNull();
    unmount();
  });

  it("rebases the recovered workspace draft onto a farther bootstrap checkpoint", () => {
    const draftOwnerId = "11111111-1111-4111-8111-111111111111";
    const draftPersistence = new WebStorageProgressDraftPersistence(window.localStorage);
    const scope = {
      ownerId: draftOwnerId,
      lessonId: "first-spark",
      lessonVersion: 1,
    } as const;
    draftPersistence.save(scope, {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 35,
      codeSnapshot: "latest local code",
    });
    const newerBootstrap: LessonProgress = {
      lessonId: "first-spark",
      lessonVersion: 1,
      revision: 7,
      status: "in_progress",
      currentStep: "validate-code",
      percentage: 60,
      codeSnapshot: null,
      completedAt: null,
      updatedAt: "2026-08-07T10:00:00.000Z",
    };
    const saveProgress = vi.fn(async (_lessonId, input: ProgressUpdateInput) =>
      savedResult(input),
    );
    const { result, rerender, unmount } = renderHook(
      ({ initialProgress }: { readonly initialProgress: LessonProgress | null }) =>
        useProgressAutosave({
          lessonId: "first-spark",
          lessonVersion: 1,
          initialProgress,
          saveProgress,
          resolveConflict: vi.fn(async () => null),
          debounceMs: 30_000,
          draftOwnerId,
          draftPersistence,
        }),
      { initialProps: { initialProgress: null as LessonProgress | null } },
    );

    expect(result.current.status.restoredDraft).toMatchObject({
      currentStep: "edit-code",
      percentage: 35,
    });

    rerender({ initialProgress: newerBootstrap });

    expect(result.current.status.restoredDraft).toEqual({
      status: "in_progress",
      currentStep: "validate-code",
      percentage: 60,
      codeSnapshot: "latest local code",
    });
    expect(draftPersistence.load(scope)).toEqual(result.current.status.restoredDraft);
    act(() => {
      result.current.cancel();
    });
    unmount();
  });
});
