import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSlug } from "../../../shared/curriculum";
import type { LessonProgress, ProgressUpdateInput } from "../../../shared/identity";
import { FirelightApiError } from "../identity/api";
import {
  ProgressAutosaveController,
  mergeProgressConflict,
} from "./autosave";
import type {
  ProgressAutosaveOptions,
  ProgressConnectivity,
  ProgressDraft,
} from "./autosave";
import type {
  ProgressDraftPersistence,
  ProgressDraftScope,
} from "./draft-persistence";

const savedAt = "2026-08-07T10:00:00.000Z";

function progress(
  overrides: Partial<LessonProgress> = {},
): LessonProgress {
  return {
    lessonId: "first-spark",
    lessonVersion: 1,
    revision: 1,
    status: "in_progress",
    currentStep: "intro",
    percentage: 10,
    codeSnapshot: null,
    completionEvidenceId: null,
    completedAt: null,
    updatedAt: savedAt,
    ...overrides,
  };
}

function resultFrom(input: ProgressUpdateInput, revision: number): LessonProgress {
  return progress({
    revision,
    status: input.status,
    currentStep: input.currentStep,
    percentage: input.percentage,
    codeSnapshot: input.codeSnapshot ?? null,
    completionEvidenceId: input.uploadEvidenceId ?? null,
    completedAt: input.status === "completed" ? savedAt : null,
  });
}

function draft(overrides: Partial<ProgressDraft> = {}): ProgressDraft {
  return {
    status: "in_progress",
    currentStep: "edit-code",
    percentage: 25,
    ...overrides,
  };
}

class FakeConnectivity implements ProgressConnectivity {
  #online: boolean;
  readonly #listeners = new Set<(online: boolean) => void>();

  constructor(online = true) {
    this.#online = online;
  }

  isOnline(): boolean {
    return this.#online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setOnline(online: boolean): void {
    this.#online = online;
    for (const listener of this.#listeners) listener(online);
  }
}

class MemoryDraftPersistence implements ProgressDraftPersistence {
  readonly #drafts = new Map<string, ProgressDraft>();

  load(scope: ProgressDraftScope): ProgressDraft | null {
    return this.#drafts.get(this.#key(scope)) ?? null;
  }

  save(scope: ProgressDraftScope, value: ProgressDraft): void {
    this.#drafts.set(this.#key(scope), structuredClone(value));
  }

  remove(scope: ProgressDraftScope): void {
    this.#drafts.delete(this.#key(scope));
  }

  #key(scope: ProgressDraftScope): string {
    return `${scope.ownerId}:${scope.lessonId}:${String(scope.lessonVersion)}`;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createController(
  options: Pick<ProgressAutosaveOptions, "saveProgress"> &
    Partial<Omit<ProgressAutosaveOptions, "saveProgress">>,
) {
  const connectivity = options.connectivity ?? new FakeConnectivity();
  const controller = new ProgressAutosaveController({
    lessonId: options.lessonId ?? "first-spark",
    lessonVersion: options.lessonVersion ?? 1,
    saveProgress: options.saveProgress,
    resolveConflict: options.resolveConflict ?? vi.fn(async () => null),
    connectivity,
    debounceMs: options.debounceMs ?? 100,
    retryInitialDelayMs: options.retryInitialDelayMs ?? 200,
    retryMaximumDelayMs: options.retryMaximumDelayMs ?? 800,
    maximumRetries: options.maximumRetries ?? 3,
    ...(options.draftOwnerId === undefined
      ? {}
      : { draftOwnerId: options.draftOwnerId }),
    ...(options.draftPersistence === undefined
      ? {}
      : { draftPersistence: options.draftPersistence }),
    ...(options.initialProgress === undefined
      ? {}
      : { initialProgress: options.initialProgress }),
  });
  controller.start();
  return { controller, connectivity };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProgressAutosaveController", () => {
  it("debounces bursts and saves only the newest monotonic checkpoint", async () => {
    const saveProgress = vi.fn(
      async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 1),
    );
    const { controller } = createController({ saveProgress });

    controller.queue(draft({ currentStep: "wire", percentage: 10 }));
    await vi.advanceTimersByTimeAsync(60);
    controller.queue(
      draft({ currentStep: "edit", percentage: 30, codeSnapshot: "void setup() {}" }),
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(saveProgress).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(saveProgress).toHaveBeenCalledOnce();
    expect(saveProgress).toHaveBeenCalledWith("first-spark", {
      lessonVersion: 1,
      expectedRevision: null,
      status: "in_progress",
      currentStep: "edit",
      percentage: 30,
      codeSnapshot: "void setup() {}",
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "saved",
      dirty: false,
      savedAt,
      message: "Progress saved.",
    });
  });

  it("flushes a pending checkpoint without waiting for its debounce timer", async () => {
    const saveProgress = vi.fn(
      async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 1),
    );
    const { controller } = createController({ saveProgress, debounceMs: 10_000 });
    controller.queue(draft());

    await controller.flush();

    expect(saveProgress).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe("saved");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes a conflict, merges forward, and retries exactly once", async () => {
    const initial = progress({ revision: 3, percentage: 20 });
    const newest = progress({
      revision: 4,
      percentage: 40,
      currentStep: "server-step",
      codeSnapshot: "server code",
    });
    const conflict = new FirelightApiError(
      409,
      "PROGRESS_REVISION_CONFLICT",
      "Progress changed.",
      "request-conflict",
    );
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 5))
      .mockRejectedValueOnce(conflict);
    const resolveConflict = vi.fn(async () => newest);
    const { controller } = createController({
      saveProgress,
      resolveConflict,
      initialProgress: initial,
    });
    controller.queue(
      draft({ percentage: 60, currentStep: "local-step", codeSnapshot: "local code" }),
    );

    await controller.flush();

    expect(resolveConflict).toHaveBeenCalledOnce();
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 3 });
    expect(saveProgress.mock.calls[1]?.[1]).toEqual({
      lessonVersion: 1,
      expectedRevision: 4,
      status: "in_progress",
      currentStep: "local-step",
      percentage: 60,
      codeSnapshot: "local code",
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("preserves a cross-device completion when resolving a conflict", async () => {
    const conflict = new FirelightApiError(409, "CONFLICT", "Changed elsewhere.");
    const completed = progress({
      revision: 8,
      status: "completed",
      currentStep: "finish",
      percentage: 100,
      codeSnapshot: "server final code",
      completionEvidenceId: "55555555-5555-4555-8555-555555555555",
      completedAt: savedAt,
    });
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 9))
      .mockRejectedValueOnce(conflict);
    const { controller } = createController({
      initialProgress: progress({ revision: 7, percentage: 50 }),
      saveProgress,
      resolveConflict: vi.fn(async () => completed),
    });
    controller.queue(
      draft({ percentage: 70, currentStep: "local-step", codeSnapshot: "local code" }),
    );

    await controller.flush();

    expect(saveProgress).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("durably sends terminal progress with its exact sketch and upload evidence", async () => {
    const saveProgress = vi.fn(
      async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 2),
    );
    const { controller } = createController({ saveProgress });
    controller.queue({
      status: "completed",
      currentStep: "finish-lesson",
      percentage: 100,
      codeSnapshot: "void setup() {}\nvoid loop() {}",
      uploadEvidenceId: "55555555-5555-4555-8555-555555555555",
    });

    await controller.flush();

    expect(saveProgress).toHaveBeenCalledWith("first-spark", {
      lessonVersion: 1,
      expectedRevision: null,
      status: "completed",
      currentStep: "finish-lesson",
      percentage: 100,
      codeSnapshot: "void setup() {}\nvoid loop() {}",
      uploadEvidenceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("retries with the server checkpoint when another device is farther ahead", async () => {
    const conflict = new FirelightApiError(
      409,
      "PROGRESS_REVISION_CONFLICT",
      "Progress changed.",
    );
    const newest = progress({
      revision: 4,
      percentage: 70,
      currentStep: "upload-sketch",
    });
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 5))
      .mockRejectedValueOnce(conflict);
    const { controller } = createController({
      initialProgress: progress({ revision: 3, percentage: 20 }),
      saveProgress,
      resolveConflict: vi.fn(async () => newest),
    });
    controller.queue(
      draft({
        percentage: 40,
        currentStep: "check-understanding",
        codeSnapshot: "latest local code",
      }),
    );

    await controller.flush();

    expect(saveProgress.mock.calls[1]?.[1]).toEqual({
      lessonVersion: 1,
      expectedRevision: 4,
      status: "in_progress",
      currentStep: "upload-sketch",
      percentage: 70,
      codeSnapshot: "latest local code",
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("surfaces a conflict after the single merge retry also conflicts", async () => {
    const conflict = new FirelightApiError(
      409,
      "PROGRESS_REVISION_CONFLICT",
      "Changed again.",
      "request-two",
    );
    const saveProgress = vi.fn(async () => Promise.reject(conflict));
    const resolveConflict = vi.fn(async () => progress({ revision: 4 }));
    const { controller } = createController({
      initialProgress: progress({ revision: 3 }),
      saveProgress,
      resolveConflict,
    });
    controller.queue(draft());

    await controller.flush();

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(resolveConflict).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "conflict",
      dirty: true,
      canRetry: true,
      errorCode: "PROGRESS_REVISION_CONFLICT",
      requestId: "request-two",
      accessibility: { role: "status", live: "assertive", atomic: true },
    });
  });

  it("retries transient errors with bounded backoff", async () => {
    const networkError = new FirelightApiError(
      0,
      "NETWORK_ERROR",
      "Could not reach Firelight.",
    );
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 1))
      .mockRejectedValueOnce(networkError);
    const { controller } = createController({ saveProgress });
    controller.queue(draft());

    await vi.advanceTimersByTimeAsync(100);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "retrying",
      dirty: true,
      retryAttempt: 1,
      errorCode: "NETWORK_ERROR",
    });
    expect(saveProgress).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(199);
    expect(saveProgress).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("keeps a rejected draft available for a manual retry", async () => {
    const rejected = new FirelightApiError(
      403,
      "ACTIVATION_REQUIRED",
      "Activate a kit first.",
      "request-activation",
    );
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 1))
      .mockRejectedValueOnce(rejected);
    const { controller } = createController({ saveProgress });
    controller.queue(draft());

    await controller.flush();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      dirty: true,
      canRetry: true,
      errorCode: "ACTIVATION_REQUIRED",
      requestId: "request-activation",
    });

    controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe("saved");
  });

  it("recovers a user-scoped draft after navigation and clears it only after a confirmed save", async () => {
    const draftPersistence = new MemoryDraftPersistence();
    const draftOwnerId = "11111111-1111-4111-8111-111111111111";
    const scope: ProgressDraftScope = {
      ownerId: draftOwnerId,
      lessonId: "first-spark",
      lessonVersion: 1,
    };
    const offline = new FakeConnectivity(false);
    const first = createController({
      saveProgress: vi.fn(async () => progress()),
      connectivity: offline,
      draftOwnerId,
      draftPersistence,
    });
    const unsaved = draft({
      currentStep: "edit-code",
      percentage: 45,
      codeSnapshot: "void loop() { delay(250); }",
    });

    first.controller.queue(unsaved);
    first.controller.stop();

    expect(draftPersistence.load(scope)).toEqual(unsaved);
    const rejected = new FirelightApiError(
      403,
      "ACTIVATION_REQUIRED",
      "Activate a kit first.",
    );
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) =>
        resultFrom(input, 8),
      )
      .mockRejectedValueOnce(rejected);
    const second = createController({
      saveProgress,
      initialProgress: progress({ revision: 7 }),
      draftOwnerId,
      draftPersistence,
    });

    expect(second.controller.getSnapshot()).toMatchObject({
      phase: "pending",
      dirty: true,
      restoredDraft: unsaved,
    });

    await second.controller.flush();

    expect(second.controller.getSnapshot()).toMatchObject({ phase: "error", dirty: true });
    expect(draftPersistence.load(scope)).toEqual(unsaved);

    second.controller.retry();
    await second.controller.flush();

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 7,
      currentStep: "edit-code",
      percentage: 45,
    });
    expect(second.controller.getSnapshot()).toMatchObject({
      phase: "saved",
      dirty: false,
      restoredDraft: null,
    });
    expect(draftPersistence.load(scope)).toBeNull();
  });

  it("waits offline and saves immediately after connectivity returns", async () => {
    const connectivity = new FakeConnectivity(false);
    const saveProgress = vi.fn(
      async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 1),
    );
    const { controller } = createController({ saveProgress, connectivity });
    controller.queue(draft());

    expect(saveProgress).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "offline",
      dirty: true,
      accessibility: { live: "assertive" },
    });

    connectivity.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(saveProgress).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("does not let an older response clear a newer queued edit", async () => {
    const firstRequest = deferred<LessonProgress>();
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 2))
      .mockImplementationOnce(async () => firstRequest.promise);
    const { controller } = createController({ saveProgress });
    controller.queue(draft({ percentage: 20, currentStep: "first" }));
    await vi.advanceTimersByTimeAsync(100);
    controller.queue(draft({ percentage: 55, currentStep: "newer" }));

    firstRequest.resolve(
      progress({ revision: 1, percentage: 20, currentStep: "first" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot()).toMatchObject({ phase: "pending", dirty: true });

    await vi.advanceTimersByTimeAsync(100);

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 1,
      percentage: 55,
      currentStep: "newer",
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("ignores a response older than a rebase and saves against the newest revision", async () => {
    const firstRequest = deferred<LessonProgress>();
    const saveProgress = vi
      .fn(async (_lessonId: LessonSlug, input: ProgressUpdateInput) => resultFrom(input, 5))
      .mockImplementationOnce(async () => firstRequest.promise);
    const { controller } = createController({
      initialProgress: progress({ revision: 2, percentage: 20 }),
      saveProgress,
    });
    controller.queue(draft({ percentage: 60, currentStep: "local" }));
    await vi.advanceTimersByTimeAsync(100);

    controller.rebase(
      progress({ revision: 4, percentage: 50, currentStep: "other-device" }),
    );
    firstRequest.resolve(
      progress({ revision: 3, percentage: 60, currentStep: "local" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot()).toMatchObject({ phase: "pending", dirty: true });

    await vi.advanceTimersByTimeAsync(100);

    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(saveProgress.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 4,
      percentage: 60,
      currentStep: "local",
    });
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("ignores an in-flight response after cancellation", async () => {
    const request = deferred<LessonProgress>();
    const saveProgress = vi.fn(async () => request.promise);
    const draftPersistence = new MemoryDraftPersistence();
    const draftOwnerId = "11111111-1111-4111-8111-111111111111";
    const scope: ProgressDraftScope = {
      ownerId: draftOwnerId,
      lessonId: "first-spark",
      lessonVersion: 1,
    };
    const { controller } = createController({
      saveProgress,
      draftPersistence,
      draftOwnerId,
    });
    controller.queue(draft());
    await vi.advanceTimersByTimeAsync(100);
    expect(draftPersistence.load(scope)).toEqual(draft());

    controller.cancel();
    expect(draftPersistence.load(scope)).toBeNull();
    request.resolve(progress());
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getSnapshot()).toMatchObject({ phase: "idle", dirty: false });
    expect(saveProgress).toHaveBeenCalledOnce();
  });
});

describe("mergeProgressConflict", () => {
  it("keeps local code while pairing the furthest server checkpoint with its percentage", () => {
    expect(
      mergeProgressConflict(
        progress({ revision: 2, percentage: 70, currentStep: "server" }),
        draft({ percentage: 40, currentStep: "local", codeSnapshot: "new code" }),
      ),
    ).toEqual({
      status: "in_progress",
      currentStep: "server",
      percentage: 70,
      codeSnapshot: "new code",
    });
  });
});
