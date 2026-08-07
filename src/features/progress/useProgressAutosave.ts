import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { LessonProgress } from "../../../shared/identity";
import {
  ProgressAutosaveController,
  browserProgressConnectivity,
} from "./autosave";
import type {
  ProgressAutosaveOptions,
  ProgressAutosaveStatus,
  ProgressConnectivity,
  ProgressConflictResolver,
  ProgressDraft,
  ProgressSaver,
} from "./autosave";
import { createBrowserProgressDraftPersistence } from "./draft-persistence";
import type { ProgressDraftPersistence } from "./draft-persistence";

export interface UseProgressAutosaveOptions {
  readonly lessonId: ProgressAutosaveOptions["lessonId"];
  readonly lessonVersion: number;
  readonly initialProgress: LessonProgress | null;
  readonly saveProgress: ProgressSaver;
  readonly resolveConflict: ProgressConflictResolver;
  readonly connectivity?: ProgressConnectivity;
  readonly draftOwnerId?: string | null;
  readonly draftPersistence?: ProgressDraftPersistence | null;
  readonly debounceMs?: number;
  readonly retryInitialDelayMs?: number;
  readonly retryMaximumDelayMs?: number;
  readonly maximumRetries?: number;
}

export interface ProgressAutosaveHandle {
  readonly status: ProgressAutosaveStatus;
  readonly queue: (draft: ProgressDraft) => void;
  readonly flush: () => Promise<void>;
  readonly retry: () => void;
  readonly cancel: () => void;
}

const unavailableSaver: ProgressSaver = () =>
  Promise.reject(new Error("Progress autosave has not started."));
const unavailableConflictResolver: ProgressConflictResolver = () =>
  Promise.reject(new Error("Progress autosave has not started."));
const browserDraftPersistence = createBrowserProgressDraftPersistence();

/** React adapter for the UI-agnostic progress autosave controller. */
export function useProgressAutosave(
  options: UseProgressAutosaveOptions,
): ProgressAutosaveHandle {
  const controller = useMemo(
    () =>
      new ProgressAutosaveController({
        lessonId: options.lessonId,
        lessonVersion: options.lessonVersion,
        initialProgress: null,
        saveProgress: unavailableSaver,
        resolveConflict: unavailableConflictResolver,
        connectivity: options.connectivity ?? browserProgressConnectivity,
        draftOwnerId: options.draftOwnerId ?? null,
        draftPersistence:
          options.draftPersistence === undefined
            ? browserDraftPersistence
            : options.draftPersistence,
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
        ...(options.retryInitialDelayMs === undefined
          ? {}
          : { retryInitialDelayMs: options.retryInitialDelayMs }),
        ...(options.retryMaximumDelayMs === undefined
          ? {}
          : { retryMaximumDelayMs: options.retryMaximumDelayMs }),
        ...(options.maximumRetries === undefined
          ? {}
          : { maximumRetries: options.maximumRetries }),
      }),
    [
      options.connectivity,
      options.debounceMs,
      options.draftOwnerId,
      options.draftPersistence,
      options.lessonId,
      options.lessonVersion,
      options.maximumRetries,
      options.retryInitialDelayMs,
      options.retryMaximumDelayMs,
    ],
  );

  useEffect(() => {
    controller.setCallbacks(options.saveProgress, options.resolveConflict);
  }, [controller, options.resolveConflict, options.saveProgress]);

  useEffect(() => {
    const lease = controller.start();
    return () => {
      void controller.flush().finally(() => {
        controller.stop(lease);
      });
    };
  }, [controller]);

  useEffect(() => {
    controller.rebase(options.initialProgress);
  }, [controller, options.initialProgress]);

  const status = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const queue = useCallback((draft: ProgressDraft) => {
    controller.queue(draft);
  }, [controller]);
  const flush = useCallback(() => controller.flush(), [controller]);
  const retry = useCallback(() => {
    controller.retry();
  }, [controller]);
  const cancel = useCallback(() => {
    controller.cancel();
  }, [controller]);

  return { status, queue, flush, retry, cancel };
}
