import type { LessonSlug } from "../../../shared/curriculum";
import type {
  LessonProgress,
  LessonProgressStatus,
  ProgressUpdateInput,
} from "../../../shared/identity";
import { FirelightApiError } from "../identity/api";
import type {
  ProgressDraftPersistence,
  ProgressDraftScope,
} from "./draft-persistence";

export type ProgressDraft = Omit<
  ProgressUpdateInput,
  "lessonVersion" | "expectedRevision"
>;

export type ProgressAutosavePhase =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "offline"
  | "retrying"
  | "conflict"
  | "error";

export type ProgressAutosaveTone = "neutral" | "positive" | "warning" | "critical";

export interface ProgressAutosaveStatus {
  readonly phase: ProgressAutosavePhase;
  /** Suitable for a visible status region and for screen-reader announcements. */
  readonly message: string;
  readonly tone: ProgressAutosaveTone;
  readonly dirty: boolean;
  readonly canRetry: boolean;
  readonly retryAttempt: number;
  readonly savedAt: string | null;
  readonly errorCode: string | null;
  readonly requestId: string | null;
  /** Present while a durable, user-scoped browser draft is being recovered. */
  readonly restoredDraft: ProgressDraft | null;
  readonly accessibility: {
    readonly role: "status";
    readonly live: "polite" | "assertive";
    readonly atomic: true;
  };
}

export type ProgressSaver = (
  lessonId: LessonSlug,
  input: ProgressUpdateInput,
) => Promise<LessonProgress>;

export type ProgressConflictResolver = (
  lessonId: LessonSlug,
  lessonVersion: number,
) => Promise<LessonProgress | null>;

export interface ProgressConnectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface ProgressAutosaveOptions {
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly initialProgress?: LessonProgress | null;
  readonly saveProgress: ProgressSaver;
  readonly resolveConflict: ProgressConflictResolver;
  readonly connectivity?: ProgressConnectivity;
  readonly draftPersistence?: ProgressDraftPersistence | null;
  readonly draftOwnerId?: string | null;
  readonly debounceMs?: number;
  readonly retryInitialDelayMs?: number;
  readonly retryMaximumDelayMs?: number;
  readonly maximumRetries?: number;
}

interface ErrorDetails {
  readonly code: string | null;
  readonly message: string;
  readonly requestId: string | null;
  readonly status: number | null;
}

interface InFlightSave {
  readonly generation: number;
  readonly promise: Promise<void>;
}

const hasOwn = (value: object, property: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, property);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function browserIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

export const browserProgressConnectivity: ProgressConnectivity = {
  isOnline: browserIsOnline,
  subscribe(listener) {
    if (typeof window === "undefined") return () => undefined;
    const onOnline = () => {
      listener(true);
    };
    const onOffline = () => {
      listener(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  },
};

function statusAccessibility(
  phase: ProgressAutosavePhase,
): ProgressAutosaveStatus["accessibility"] {
  return {
    role: "status",
    live: phase === "offline" || phase === "conflict" || phase === "error"
      ? "assertive"
      : "polite",
    atomic: true,
  };
}

function createStatus(
  phase: ProgressAutosavePhase,
  options: {
    readonly dirty: boolean;
    readonly message?: string;
    readonly retryAttempt?: number;
    readonly savedAt?: string | null;
    readonly errorCode?: string | null;
    readonly requestId?: string | null;
  },
): ProgressAutosaveStatus {
  const defaultMessage: Record<ProgressAutosavePhase, string> = {
    idle: "Progress is ready to save.",
    pending: "Progress has not been saved yet.",
    saving: "Saving progress…",
    saved: "Progress saved.",
    offline: "You’re offline. Progress will save when you reconnect.",
    retrying: "Saving was interrupted. Firelight will retry automatically.",
    conflict: "This lesson changed elsewhere. Reload its saved progress before continuing.",
    error: "Progress could not be saved. Your latest work is still here.",
  };
  const tone: Record<ProgressAutosavePhase, ProgressAutosaveTone> = {
    idle: "neutral",
    pending: "neutral",
    saving: "neutral",
    saved: "positive",
    offline: "warning",
    retrying: "warning",
    conflict: "critical",
    error: "critical",
  };
  return {
    phase,
    message: options.message ?? defaultMessage[phase],
    tone: tone[phase],
    dirty: options.dirty,
    canRetry: phase === "conflict" || phase === "error",
    retryAttempt: options.retryAttempt ?? 0,
    savedAt: options.savedAt ?? null,
    errorCode: options.errorCode ?? null,
    requestId: options.requestId ?? null,
    restoredDraft: null,
    accessibility: statusAccessibility(phase),
  };
}

function detailsFrom(error: unknown): ErrorDetails {
  if (error instanceof FirelightApiError) {
    return {
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return {
      code: null,
      message: error.message,
      requestId: null,
      status: null,
    };
  }
  return {
    code: null,
    message: "Firelight could not complete the save.",
    requestId: null,
    status: null,
  };
}

function isConflict(error: unknown): boolean {
  const details = detailsFrom(error);
  return details.status === 409;
}

function isTransient(error: unknown): boolean {
  const details = detailsFrom(error);
  return (
    details.code === "NETWORK_ERROR" ||
    details.status === 0 ||
    details.status === 408 ||
    details.status === 425 ||
    details.status === 429 ||
    (details.status !== null && details.status >= 500)
  );
}

function assertDraft(draft: ProgressDraft): void {
  if (draft.currentStep.trim().length < 1 || draft.currentStep.length > 100) {
    throw new RangeError("Progress currentStep must contain 1 to 100 characters.");
  }
  if (!Number.isInteger(draft.percentage) || draft.percentage < 0 || draft.percentage > 100) {
    throw new RangeError("Progress percentage must be an integer from 0 to 100.");
  }
  const valid =
    (draft.status === "not_started" && draft.percentage === 0) ||
    (draft.status === "in_progress" && draft.percentage < 100) ||
    (draft.status === "completed" && draft.percentage === 100);
  if (!valid) throw new RangeError("Progress status and percentage do not agree.");
  if (draft.status === "completed") {
    if (
      typeof draft.uploadEvidenceId !== "string" ||
      !UUID_PATTERN.test(draft.uploadEvidenceId)
    ) {
      throw new RangeError("Completed progress requires valid upload evidence.");
    }
    if (typeof draft.codeSnapshot !== "string" || draft.codeSnapshot.length === 0) {
      throw new RangeError("Completed progress requires the uploaded sketch.");
    }
  } else if (draft.uploadEvidenceId !== undefined) {
    throw new RangeError("Upload evidence is only valid for completed progress.");
  }
}

function furthestStatus(
  first: LessonProgressStatus,
  second: LessonProgressStatus,
  percentage: number,
): LessonProgressStatus {
  if (first === "completed" || second === "completed" || percentage === 100) {
    return "completed";
  }
  if (first === "in_progress" || second === "in_progress" || percentage > 0) {
    return "in_progress";
  }
  return "not_started";
}

function withDraftSnapshot(
  target: ProgressDraft,
  source: ProgressDraft,
): ProgressDraft {
  if (!hasOwn(source, "codeSnapshot") || source.codeSnapshot === undefined) return target;
  return { ...target, codeSnapshot: source.codeSnapshot };
}

function withDraftEvidence(
  target: ProgressDraft,
  source: ProgressDraft,
): ProgressDraft {
  if (!hasOwn(source, "uploadEvidenceId") || source.uploadEvidenceId === undefined) {
    return target;
  }
  return { ...target, uploadEvidenceId: source.uploadEvidenceId };
}

function draftFromCompletedProgress(progress: LessonProgress): ProgressDraft {
  return {
    status: "completed",
    currentStep: progress.currentStep,
    percentage: 100,
    ...(progress.codeSnapshot === null ? {} : { codeSnapshot: progress.codeSnapshot }),
    ...(progress.completionEvidenceId === null
      ? {}
      : { uploadEvidenceId: progress.completionEvidenceId }),
  };
}

function mergeQueuedDraft(
  persisted: LessonProgress | null,
  current: ProgressDraft | null,
  incoming: ProgressDraft,
): ProgressDraft {
  const baselineStatus = current?.status ?? persisted?.status ?? "not_started";
  const baselinePercentage = current?.percentage ?? persisted?.percentage ?? 0;
  const percentage = Math.max(baselinePercentage, incoming.percentage);
  const status = furthestStatus(baselineStatus, incoming.status, percentage);
  const terminalStep =
    persisted?.status === "completed"
      ? persisted.currentStep
      : current?.status === "completed"
        ? current.currentStep
        : null;
  let merged: ProgressDraft = {
    status,
    currentStep: terminalStep ?? incoming.currentStep.trim(),
    percentage: status === "completed" ? 100 : percentage,
  };
  if (hasOwn(incoming, "codeSnapshot")) {
    merged = withDraftSnapshot(merged, incoming);
  } else if (current && hasOwn(current, "codeSnapshot")) {
    merged = withDraftSnapshot(merged, current);
  }
  if (status === "completed") {
    if (persisted?.status === "completed") {
      merged = draftFromCompletedProgress(persisted);
    } else if (hasOwn(incoming, "uploadEvidenceId")) {
      merged = withDraftEvidence(merged, incoming);
    } else if (current && hasOwn(current, "uploadEvidenceId")) {
      merged = withDraftEvidence(merged, current);
    }
  }
  return merged;
}

/**
 * Reconciles an unsaved local checkpoint with a newer cross-device checkpoint.
 * Completion is terminal; otherwise the furthest progress and latest local edit win.
 */
export function mergeProgressConflict(
  server: LessonProgress | null,
  local: ProgressDraft,
): ProgressDraft {
  if (!server) return local;
  if (server.status === "completed") {
    return draftFromCompletedProgress(server);
  }
  const percentage = Math.max(server.percentage, local.percentage);
  const serverCheckpointIsFurther = server.percentage > local.percentage;
  let merged: ProgressDraft = {
    status: furthestStatus(server.status, local.status, percentage),
    currentStep: serverCheckpointIsFurther ? server.currentStep : local.currentStep,
    percentage,
  };
  if (hasOwn(local, "codeSnapshot")) merged = withDraftSnapshot(merged, local);
  return merged;
}

function mergeAfterOwnSave(server: LessonProgress, local: ProgressDraft): ProgressDraft {
  if (server.status !== "completed") return mergeProgressConflict(server, local);
  return draftFromCompletedProgress(server);
}

function draftMatchesProgress(draft: ProgressDraft, progress: LessonProgress): boolean {
  return (
    draft.status === progress.status &&
    draft.currentStep === progress.currentStep &&
    draft.percentage === progress.percentage &&
    (!hasOwn(draft, "codeSnapshot") || draft.codeSnapshot === progress.codeSnapshot) &&
    (!hasOwn(draft, "uploadEvidenceId") ||
      draft.uploadEvidenceId === progress.completionEvidenceId)
  );
}

function progressMatchesLesson(
  progress: LessonProgress,
  lessonId: LessonSlug,
  lessonVersion: number,
): boolean {
  return progress.lessonId === lessonId && progress.lessonVersion === lessonVersion;
}

export class ProgressAutosaveController {
  readonly #lessonId: LessonSlug;
  readonly #lessonVersion: number;
  #saveProgress: ProgressSaver;
  #resolveConflict: ProgressConflictResolver;
  readonly #connectivity: ProgressConnectivity;
  readonly #debounceMs: number;
  readonly #retryInitialDelayMs: number;
  readonly #retryMaximumDelayMs: number;
  readonly #maximumRetries: number;
  readonly #draftPersistence: ProgressDraftPersistence | null;
  readonly #draftScope: ProgressDraftScope | null;
  readonly #listeners = new Set<() => void>();

  #status: ProgressAutosaveStatus;
  #persisted: LessonProgress | null;
  #latestDraft: ProgressDraft | null = null;
  #restoredDraft: ProgressDraft | null = null;
  #dirty = false;
  #localRevision = 0;
  #generation = 0;
  #retryCount = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: InFlightSave | null = null;
  #unsubscribeConnectivity: (() => void) | null = null;
  #active = false;
  #lifecycleLease = 0;

  constructor(options: ProgressAutosaveOptions) {
    this.#lessonId = options.lessonId;
    this.#lessonVersion = options.lessonVersion;
    this.#saveProgress = options.saveProgress;
    this.#resolveConflict = options.resolveConflict;
    this.#connectivity = options.connectivity ?? browserProgressConnectivity;
    this.#debounceMs = Math.max(0, options.debounceMs ?? 800);
    this.#retryInitialDelayMs = Math.max(0, options.retryInitialDelayMs ?? 1_000);
    this.#retryMaximumDelayMs = Math.max(
      this.#retryInitialDelayMs,
      options.retryMaximumDelayMs ?? 10_000,
    );
    this.#maximumRetries = Math.max(0, options.maximumRetries ?? 3);
    this.#draftPersistence = options.draftPersistence ?? null;
    this.#draftScope =
      this.#draftPersistence && options.draftOwnerId
        ? {
            ownerId: options.draftOwnerId,
            lessonId: options.lessonId,
            lessonVersion: options.lessonVersion,
          }
        : null;
    this.#persisted =
      options.initialProgress &&
      progressMatchesLesson(options.initialProgress, options.lessonId, options.lessonVersion)
        ? options.initialProgress
        : null;
    const durableDraft = this.#loadPersistedDraft();
    if (durableDraft) {
      const mergedDraft = mergeProgressConflict(this.#persisted, durableDraft);
      if (this.#persisted && draftMatchesProgress(mergedDraft, this.#persisted)) {
        this.#clearPersistedDraft();
      } else {
        this.#latestDraft = mergedDraft;
        this.#restoredDraft = mergedDraft;
        this.#dirty = true;
        this.#localRevision = 1;
        this.#persistDraft();
      }
    }
    const initialStatus = this.#dirty
      ? createStatus(this.#connectivity.isOnline() ? "pending" : "offline", {
          dirty: true,
          message: this.#connectivity.isOnline()
            ? "Recovered unsaved progress. Saving…"
            : "Recovered unsaved progress. It will save when you reconnect.",
        })
      : this.#persisted
        ? createStatus("saved", {
            dirty: false,
            savedAt: this.#persisted.updatedAt,
          })
        : createStatus("idle", { dirty: false });
    this.#status = { ...initialStatus, restoredDraft: this.#restoredDraft };
  }

  readonly getSnapshot = (): ProgressAutosaveStatus => this.#status;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Keeps long-lived hook controllers pointed at the current identity callbacks. */
  setCallbacks(saveProgress: ProgressSaver, resolveConflict: ProgressConflictResolver): void {
    this.#saveProgress = saveProgress;
    this.#resolveConflict = resolveConflict;
  }

  start(): number {
    const lease = ++this.#lifecycleLease;
    if (this.#active) return lease;
    this.#active = true;
    this.#unsubscribeConnectivity = this.#connectivity.subscribe((online) => {
      this.#handleConnectivityChange(online);
    });
    if (!this.#connectivity.isOnline()) {
      this.#publish(createStatus("offline", { dirty: this.#dirty }));
    } else if (this.#dirty) {
      this.#publish(createStatus("pending", { dirty: true }));
      this.#schedule(0);
    }
    return lease;
  }

  stop(lease?: number): void {
    if (lease !== undefined && lease !== this.#lifecycleLease) return;
    if (!this.#active) return;
    this.#active = false;
    this.#generation += 1;
    this.#clearTimer();
    this.#inFlight = null;
    this.#unsubscribeConnectivity?.();
    this.#unsubscribeConnectivity = null;
  }

  queue(draft: ProgressDraft): void {
    assertDraft(draft);
    this.#latestDraft = mergeQueuedDraft(this.#persisted, this.#latestDraft, draft);
    this.#restoredDraft = null;
    this.#dirty = true;
    this.#localRevision += 1;
    this.#retryCount = 0;
    this.#clearTimer();
    this.#persistDraft();

    if (!this.#connectivity.isOnline()) {
      this.#publish(createStatus("offline", { dirty: true }));
      return;
    }
    this.#publish(
      createStatus("pending", {
        dirty: true,
        ...(this.#inFlight
          ? { message: "New progress is waiting for the current save to finish." }
          : {}),
      }),
    );
    if (!this.#inFlight) this.#schedule(this.#debounceMs);
  }

  async flush(): Promise<void> {
    this.#clearTimer();
    if (!this.#dirty || !this.#latestDraft) return;
    if (!this.#connectivity.isOnline()) {
      this.#publish(createStatus("offline", { dirty: true }));
      return;
    }

    for (;;) {
      await this.#performSave();
      if (!this.#status.dirty) return;
      if (
        this.#status.phase !== "pending" &&
        this.#status.phase !== "saving"
      ) {
        return;
      }
      this.#clearTimer();
    }
  }

  retry(): void {
    if (!this.#dirty || !this.#latestDraft) return;
    this.#retryCount = 0;
    this.#clearTimer();
    if (!this.#connectivity.isOnline()) {
      this.#publish(createStatus("offline", { dirty: true }));
      return;
    }
    this.#publish(createStatus("pending", { dirty: true, message: "Retrying progress save…" }));
    this.#schedule(0);
  }

  /** Explicitly discards queued edits, including their durable recovery copy. */
  cancel(): void {
    this.#generation += 1;
    this.#clearTimer();
    this.#inFlight = null;
    this.#dirty = false;
    this.#latestDraft = null;
    this.#clearPersistedDraft();
    this.#retryCount = 0;
    this.#publish(
      this.#persisted
        ? createStatus("saved", {
            dirty: false,
            savedAt: this.#persisted.updatedAt,
          })
        : createStatus("idle", { dirty: false }),
    );
  }

  /** Applies a newer bootstrap/refetch result without letting an older response regress state. */
  rebase(progress: LessonProgress | null): void {
    if (!progress || !progressMatchesLesson(progress, this.#lessonId, this.#lessonVersion)) return;
    if (this.#persisted && progress.revision <= this.#persisted.revision) return;
    this.#persisted = progress;
    if (!this.#dirty || !this.#latestDraft) {
      this.#latestDraft = null;
      this.#dirty = false;
      this.#publish(createStatus("saved", { dirty: false, savedAt: progress.updatedAt }));
      return;
    }
    const wasRecoveringDraft = this.#restoredDraft !== null;
    this.#latestDraft = mergeProgressConflict(progress, this.#latestDraft);
    if (draftMatchesProgress(this.#latestDraft, progress)) {
      this.#dirty = false;
      this.#latestDraft = null;
      this.#clearTimer();
      this.#clearPersistedDraft();
      this.#publish(createStatus("saved", { dirty: false, savedAt: progress.updatedAt }));
      return;
    }
    if (wasRecoveringDraft) this.#restoredDraft = this.#latestDraft;
    this.#persistDraft();
    if (this.#connectivity.isOnline()) {
      this.#publish(createStatus("pending", { dirty: true }));
      if (!this.#inFlight) this.#schedule(this.#debounceMs);
    } else {
      this.#publish(createStatus("offline", { dirty: true }));
    }
  }

  #publish(status: ProgressAutosaveStatus): void {
    this.#status = { ...status, restoredDraft: this.#restoredDraft };
    for (const listener of this.#listeners) listener();
  }

  #loadPersistedDraft(): ProgressDraft | null {
    if (!this.#draftPersistence || !this.#draftScope) return null;
    try {
      return this.#draftPersistence.load(this.#draftScope);
    } catch {
      return null;
    }
  }

  #persistDraft(): void {
    if (!this.#draftPersistence || !this.#draftScope || !this.#latestDraft) return;
    try {
      this.#draftPersistence.save(this.#draftScope, this.#latestDraft);
    } catch {
      // Durable recovery is best-effort; server progress saving must remain available.
    }
  }

  #clearPersistedDraft(): void {
    this.#restoredDraft = null;
    if (!this.#draftPersistence || !this.#draftScope) return;
    try {
      this.#draftPersistence.remove(this.#draftScope);
    } catch {
      // A failed cleanup may restore an already-saved draft, which rebase safely reconciles.
    }
  }

  #handleConnectivityChange(online: boolean): void {
    if (!online) {
      this.#clearTimer();
      this.#publish(createStatus("offline", { dirty: this.#dirty }));
      return;
    }
    if (this.#dirty && this.#latestDraft) {
      this.#retryCount = 0;
      this.#publish(
        createStatus("pending", {
          dirty: true,
          message: "Back online. Saving progress…",
        }),
      );
      if (!this.#inFlight) this.#schedule(0);
      return;
    }
    this.#publish(
      this.#persisted
        ? createStatus("saved", { dirty: false, savedAt: this.#persisted.updatedAt })
        : createStatus("idle", { dirty: false }),
    );
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    if (!this.#active) return;
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#performSave();
    }, delayMs);
  }

  #performSave(): Promise<void> {
    if (this.#inFlight) return this.#inFlight.promise;
    if (!this.#dirty || !this.#latestDraft || !this.#connectivity.isOnline()) {
      return Promise.resolve();
    }
    const generation = this.#generation;
    const promise = this.#runSave(generation);
    const inFlight = { generation, promise };
    this.#inFlight = inFlight;
    void promise.finally(() => {
      if (this.#inFlight === inFlight) this.#inFlight = null;
    });
    return promise;
  }

  async #runSave(generation: number): Promise<void> {
    let hasResolvedConflict = false;
    for (;;) {
      if (generation !== this.#generation || !this.#latestDraft) return;
      const draft = this.#latestDraft;
      const requestRevision = this.#localRevision;
      const input: ProgressUpdateInput = {
        lessonVersion: this.#lessonVersion,
        expectedRevision: this.#persisted?.revision ?? null,
        status: draft.status,
        currentStep: draft.currentStep,
        percentage: draft.percentage,
        ...(draft.codeSnapshot === undefined ? {} : { codeSnapshot: draft.codeSnapshot }),
        ...(draft.uploadEvidenceId === undefined
          ? {}
          : { uploadEvidenceId: draft.uploadEvidenceId }),
      };
      this.#publish(
        createStatus(hasResolvedConflict ? "retrying" : "saving", {
          dirty: true,
          ...(hasResolvedConflict
            ? { message: "Saved progress changed elsewhere. Merging and trying once more…" }
            : {}),
        }),
      );

      try {
        const saved = await this.#saveProgress(this.#lessonId, input);
        if (generation !== this.#generation) return;
        this.#handleSuccess(saved, requestRevision);
        return;
      } catch (error) {
        if (generation !== this.#generation) return;
        if (isConflict(error) && !hasResolvedConflict) {
          hasResolvedConflict = true;
          this.#publish(
            createStatus("retrying", {
              dirty: true,
              message: "Saved progress changed elsewhere. Checking the newest checkpoint…",
              errorCode: detailsFrom(error).code,
              requestId: detailsFrom(error).requestId,
            }),
          );
          try {
            const newest = await this.#resolveConflict(this.#lessonId, this.#lessonVersion);
            const latestDraft = this.#readLatestDraft();
            if (generation !== this.#generation || !latestDraft) return;
            if (newest && !progressMatchesLesson(newest, this.#lessonId, this.#lessonVersion)) {
              throw new Error("The conflict resolver returned progress for another lesson.");
            }
            this.#persisted = newest;
            this.#latestDraft = mergeProgressConflict(newest, latestDraft);
            if (newest && draftMatchesProgress(this.#latestDraft, newest)) {
              this.#dirty = false;
              this.#latestDraft = null;
              this.#clearPersistedDraft();
              this.#publish(
                createStatus("saved", { dirty: false, savedAt: newest.updatedAt }),
              );
              return;
            }
            this.#persistDraft();
            continue;
          } catch (resolutionError) {
            if (generation !== this.#generation) return;
            this.#handleTerminalConflict(resolutionError);
            return;
          }
        }
        if (isConflict(error)) {
          this.#handleTerminalConflict(error);
          return;
        }
        this.#handleFailure(error);
        return;
      }
    }
  }

  #readLatestDraft(): ProgressDraft | null {
    return this.#latestDraft;
  }

  #handleSuccess(saved: LessonProgress, requestRevision: number): void {
    if (!progressMatchesLesson(saved, this.#lessonId, this.#lessonVersion)) {
      this.#handleFailure(new Error("The progress service returned another lesson."));
      return;
    }
    if (this.#persisted && saved.revision < this.#persisted.revision) {
      // A bootstrap/refetch already supplied a newer revision while this request was in flight.
      // Keep the merged local draft dirty and send it against that newer revision.
      if (this.#dirty && this.#latestDraft) {
        if (this.#connectivity.isOnline()) {
          this.#publish(createStatus("pending", { dirty: true }));
          this.#schedule(this.#debounceMs);
        } else {
          this.#publish(createStatus("offline", { dirty: true }));
        }
      }
      return;
    }
    this.#persisted = saved;
    this.#retryCount = 0;
    if (this.#localRevision === requestRevision) {
      this.#dirty = false;
      this.#latestDraft = null;
      this.#clearPersistedDraft();
      this.#publish(
        this.#connectivity.isOnline()
          ? createStatus("saved", { dirty: false, savedAt: saved.updatedAt })
          : createStatus("offline", { dirty: false, savedAt: saved.updatedAt }),
      );
      return;
    }

    if (!this.#latestDraft) return;
    this.#latestDraft = mergeAfterOwnSave(saved, this.#latestDraft);
    if (draftMatchesProgress(this.#latestDraft, saved)) {
      this.#dirty = false;
      this.#latestDraft = null;
      this.#clearPersistedDraft();
      this.#publish(createStatus("saved", { dirty: false, savedAt: saved.updatedAt }));
      return;
    }
    this.#dirty = true;
    this.#persistDraft();
    if (!this.#connectivity.isOnline()) {
      this.#publish(createStatus("offline", { dirty: true, savedAt: saved.updatedAt }));
      return;
    }
    this.#publish(createStatus("pending", { dirty: true, savedAt: saved.updatedAt }));
    this.#schedule(this.#debounceMs);
  }

  #handleTerminalConflict(error: unknown): void {
    const details = detailsFrom(error);
    this.#publish(
      createStatus("conflict", {
        dirty: true,
        message:
          "Progress changed again while Firelight was merging it. Retry to check the newest checkpoint.",
        errorCode: details.code ?? "PROGRESS_CONFLICT",
        requestId: details.requestId,
      }),
    );
  }

  #handleFailure(error: unknown): void {
    const details = detailsFrom(error);
    if (!this.#connectivity.isOnline()) {
      this.#publish(
        createStatus("offline", {
          dirty: true,
          errorCode: details.code,
          requestId: details.requestId,
        }),
      );
      return;
    }
    if (isTransient(error) && this.#retryCount < this.#maximumRetries) {
      const delay = Math.min(
        this.#retryMaximumDelayMs,
        this.#retryInitialDelayMs * 2 ** this.#retryCount,
      );
      this.#retryCount += 1;
      this.#publish(
        createStatus("retrying", {
          dirty: true,
          retryAttempt: this.#retryCount,
          errorCode: details.code,
          requestId: details.requestId,
        }),
      );
      this.#schedule(delay);
      return;
    }
    this.#publish(
      createStatus("error", {
        dirty: true,
        message: `Progress could not be saved. ${details.message}`,
        retryAttempt: this.#retryCount,
        errorCode: details.code,
        requestId: details.requestId,
      }),
    );
  }
}
