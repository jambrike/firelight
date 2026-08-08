import type { LessonSlug } from "../../../shared/curriculum";
import type { ProgressDraft } from "./autosave";

const RECORD_VERSION = 1;
const MAX_OWNER_ID_LENGTH = 128;
const MAX_STEP_LENGTH = 100;
const MAX_CODE_BYTES = 65_536;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProgressDraftScope {
  readonly ownerId: string;
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
}

export interface ProgressDraftPersistence {
  load(scope: ProgressDraftScope): ProgressDraft | null;
  save(scope: ProgressDraftScope, draft: ProgressDraft): void;
  remove(scope: ProgressDraftScope): void;
}

interface StoredDraftRecord {
  readonly schemaVersion: typeof RECORD_VERSION;
  readonly ownerId: string;
  readonly lessonId: LessonSlug;
  readonly lessonVersion: number;
  readonly savedAt: number;
  readonly draft: ProgressDraft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validScope(scope: ProgressDraftScope): boolean {
  return (
    validOwnerId(scope.ownerId) &&
    Number.isSafeInteger(scope.lessonVersion) &&
    scope.lessonVersion > 0
  );
}

function validOwnerId(ownerId: string): boolean {
  return ownerId.length > 0 && ownerId.length <= MAX_OWNER_ID_LENGTH;
}

function validCodeSnapshot(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && new TextEncoder().encode(value).byteLength <= MAX_CODE_BYTES)
  );
}

export function isValidPersistedDraft(value: unknown): value is ProgressDraft {
  if (!isRecord(value)) return false;
  const status = value.status;
  const currentStep = value.currentStep;
  const percentage = value.percentage;
  if (
    typeof currentStep !== "string" ||
    currentStep !== currentStep.trim() ||
    currentStep.length < 1 ||
    currentStep.length > MAX_STEP_LENGTH ||
    !Number.isSafeInteger(percentage) ||
    Number(percentage) < 0 ||
    Number(percentage) > 100 ||
    !validCodeSnapshot(value.codeSnapshot)
  ) {
    return false;
  }
  const numericPercentage = Number(percentage);
  if (status === "completed" && numericPercentage === 100) {
    return (
      typeof value.codeSnapshot === "string" &&
      value.codeSnapshot.length > 0 &&
      typeof value.uploadEvidenceId === "string" &&
      UUID_PATTERN.test(value.uploadEvidenceId)
    );
  }
  if (value.uploadEvidenceId !== undefined) return false;
  return (
    (status === "not_started" && numericPercentage === 0) ||
    (status === "in_progress" && numericPercentage < 100)
  );
}

function storageKey(scope: ProgressDraftScope): string {
  return `firelight:progress-draft:v1:${encodeURIComponent(scope.ownerId)}:${scope.lessonId}:${String(scope.lessonVersion)}`;
}

function ownerStoragePrefix(ownerId: string): string {
  return `firelight:progress-draft:v1:${encodeURIComponent(ownerId)}:`;
}

/**
 * Same-origin durable storage for at most one bounded draft per user/lesson/version.
 * Records are identity-checked on read so a shared browser never returns another user's draft.
 */
export class WebStorageProgressDraftPersistence implements ProgressDraftPersistence {
  readonly #storage: Storage;
  readonly #now: () => number;

  constructor(storage: Storage, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  load(scope: ProgressDraftScope): ProgressDraft | null {
    if (!validScope(scope)) return null;
    const key = storageKey(scope);
    let value: string | null;
    try {
      value = this.#storage.getItem(key);
    } catch {
      return null;
    }
    if (value === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      this.#removeKey(key);
      return null;
    }
    if (!isRecord(parsed)) {
      this.#removeKey(key);
      return null;
    }
    const savedAt = parsed.savedAt;
    if (
      parsed.schemaVersion !== RECORD_VERSION ||
      parsed.ownerId !== scope.ownerId ||
      parsed.lessonId !== scope.lessonId ||
      parsed.lessonVersion !== scope.lessonVersion ||
      typeof savedAt !== "number" ||
      !Number.isFinite(savedAt) ||
      savedAt > this.#now() + 60_000 ||
      this.#now() - savedAt > DRAFT_TTL_MS ||
      !isValidPersistedDraft(parsed.draft)
    ) {
      this.#removeKey(key);
      return null;
    }
    return parsed.draft;
  }

  save(scope: ProgressDraftScope, draft: ProgressDraft): void {
    if (!validScope(scope) || !isValidPersistedDraft(draft)) return;
    const record: StoredDraftRecord = {
      schemaVersion: RECORD_VERSION,
      ownerId: scope.ownerId,
      lessonId: scope.lessonId,
      lessonVersion: scope.lessonVersion,
      savedAt: this.#now(),
      draft,
    };
    try {
      this.#storage.setItem(storageKey(scope), JSON.stringify(record));
    } catch {
      // Saving to the server remains available when browser storage is blocked or full.
    }
  }

  remove(scope: ProgressDraftScope): void {
    if (!validScope(scope)) return;
    this.#removeKey(storageKey(scope));
  }

  /** Removes only recovery records whose encoded owner segment exactly matches this user. */
  removeOwner(ownerId: string): void {
    if (!validOwnerId(ownerId)) return;
    const prefix = ownerStoragePrefix(ownerId);
    try {
      for (let index = this.#storage.length - 1; index >= 0; index -= 1) {
        const key = this.#storage.key(index);
        if (key?.startsWith(prefix)) this.#storage.removeItem(key);
      }
    } catch {
      // Account deletion must continue even when browser storage is unavailable.
    }
  }

  #removeKey(key: string): void {
    try {
      this.#storage.removeItem(key);
    } catch {
      // Storage may be disabled; removal is best-effort and must not break lesson progress.
    }
  }
}

export function createBrowserProgressDraftPersistence(): ProgressDraftPersistence | null {
  if (typeof window === "undefined") return null;
  try {
    return new WebStorageProgressDraftPersistence(window.localStorage);
  } catch {
    return null;
  }
}

export function purgeBrowserProgressDraftsForOwner(ownerId: string): void {
  if (typeof window === "undefined") return;
  try {
    new WebStorageProgressDraftPersistence(window.localStorage).removeOwner(ownerId);
  } catch {
    // Browser storage cleanup is best-effort after the server confirms account deletion.
  }
}
