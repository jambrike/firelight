import type { LessonSlug } from "../../../shared/curriculum";
import type { BootstrapData, LessonProgress, ProgressUpdateInput } from "../../../shared/identity";

export const legacyKeys = {
  displayName: "firelight-student-name",
  email: "firelight-student-email",
  kitUnlocked: "firelight-kit-unlocked",
  firstSparkComplete: "firelight-first-tutorial-complete",
  morseNameComplete: "firelight-second-tutorial-complete",
  plaintextPassword: "firelight-local-password",
} as const;

interface LegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

type LegacyStorageRemoval = Pick<LegacyStorage, "removeItem">;

interface LegacyMigrationApi {
  updateProfile(displayName: string): Promise<unknown>;
  saveProgress(lessonId: LessonSlug, input: ProgressUpdateInput): Promise<LessonProgress>;
}

interface LegacySnapshot {
  readonly displayName: string | null;
  readonly ownerEmail: string | null;
  readonly firstSparkValue: string | null;
  readonly morseNameValue: string | null;
}

export function purgeLegacyPlaintextPassword(storage: LegacyStorageRemoval): void {
  try {
    storage.removeItem(legacyKeys.plaintextPassword);
  } catch {
    // Web Storage can be unavailable or reject writes in restricted browser contexts.
  }
}

export function readLegacySnapshot(storage: LegacyStorage): LegacySnapshot {
  const rawName = storage.getItem(legacyKeys.displayName);
  const displayName = rawName?.trim() ?? "";
  return {
    displayName:
      displayName.length >= 1 && Array.from(displayName).length <= 40 ? displayName : null,
    ownerEmail: storage.getItem(legacyKeys.email)?.trim().toLowerCase() ?? null,
    firstSparkValue: storage.getItem(legacyKeys.firstSparkComplete),
    morseNameValue: storage.getItem(legacyKeys.morseNameComplete),
  };
}

function currentCompletion(progress: readonly LessonProgress[], lessonId: LessonSlug): boolean {
  return progress.some(
    (item) =>
      item.lessonId === lessonId && item.lessonVersion === 1 && item.status === "completed",
  );
}

function currentRevision(
  progress: readonly LessonProgress[],
  lessonId: LessonSlug,
): number | null {
  return (
    progress.find(
      (item) => item.lessonId === lessonId && item.lessonVersion === 1,
    )?.revision ?? null
  );
}

function currentProgress(
  progress: readonly LessonProgress[],
  lessonId: LessonSlug,
): LessonProgress | null {
  return (
    progress.find(
      (item) => item.lessonId === lessonId && item.lessonVersion === 1,
    ) ?? null
  );
}

export async function migrateLegacyData(
  storage: LegacyStorage,
  bootstrap: BootstrapData,
  api: LegacyMigrationApi,
): Promise<boolean> {
  if (!bootstrap.activation) return false;

  const snapshot = readLegacySnapshot(storage);
  const hasTransferableData =
    snapshot.displayName !== null ||
    snapshot.firstSparkValue !== null ||
    snapshot.morseNameValue !== null;
  if (
    hasTransferableData &&
    snapshot.ownerEmail !== bootstrap.profile.email.trim().toLowerCase()
  ) {
    throw new Error(
      "Legacy progress was left on this browser because it belongs to a different or unverifiable account.",
    );
  }
  let changed = false;

  if (
    snapshot.displayName &&
    bootstrap.profile.displayName === "Builder" &&
    snapshot.displayName !== bootstrap.profile.displayName
  ) {
    await api.updateProfile(snapshot.displayName);
    changed = true;
  }

  const completionFlags = [
    ["first-spark", snapshot.firstSparkValue, legacyKeys.firstSparkComplete],
    ["morse-name", snapshot.morseNameValue, legacyKeys.morseNameComplete],
  ] as const;

  let pendingLegacyCompletion = false;
  for (const [lessonId, value, storageKey] of completionFlags) {
    if (value === null) continue;
    if (value !== "true" || currentCompletion(bootstrap.progress, lessonId)) {
      storage.removeItem(storageKey);
      continue;
    }

    // Legacy booleans cannot prove that the exact current sketch reached a board.
    // Preserve the learner's head start at the compile checkpoint, then require the
    // normal compile, Web Serial upload, observation, and evidence-backed completion.
    const prerequisitesSatisfied =
      lessonId === "first-spark" || currentCompletion(bootstrap.progress, "first-spark");
    if (!prerequisitesSatisfied) {
      pendingLegacyCompletion = true;
      continue;
    }

    const existing = currentProgress(bootstrap.progress, lessonId);
    if (!existing || existing.percentage < 50) {
      await api.saveProgress(lessonId, {
        lessonVersion: 1,
        expectedRevision: currentRevision(bootstrap.progress, lessonId),
        status: "in_progress",
        currentStep: "compile-sketch",
        percentage: 50,
      });
      changed = true;
    }
    storage.removeItem(storageKey);
  }

  if (snapshot.displayName !== null) storage.removeItem(legacyKeys.displayName);
  if (!pendingLegacyCompletion) {
    storage.removeItem(legacyKeys.email);
    storage.removeItem(legacyKeys.kitUnlocked);
  }

  return changed;
}
