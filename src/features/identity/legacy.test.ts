import { describe, expect, it, vi } from "vitest";
import type { BootstrapData, LessonProgress } from "../../../shared/identity";
import {
  legacyKeys,
  migrateLegacyData,
  purgeLegacyPlaintextPassword,
  readLegacySnapshot,
} from "./legacy";

function bootstrap(overrides: Partial<BootstrapData> = {}): BootstrapData {
  return {
    profile: {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Builder",
      role: "learner",
      email: "builder@example.com",
      emailConfirmed: true,
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    },
    activation: {
      id: "22222222-2222-4222-8222-222222222222",
      batch: "pilot",
      kind: "code",
      claimedAt: "2026-08-06T00:00:00.000Z",
    },
    progress: [],
    achievements: [],
    nextLesson: { id: "first-spark", title: "First Spark" },
    ...overrides,
  };
}

function createStorage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

const savedProgress: LessonProgress = {
  lessonId: "first-spark",
  lessonVersion: 1,
  revision: 1,
  status: "completed",
  currentStep: "legacy-complete",
  percentage: 100,
  codeSnapshot: null,
  completionEvidenceId: null,
  completedAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

describe("legacy progress migration", () => {
  it("reads only the allowlisted name and completion keys, never the legacy password", () => {
    const storage = createStorage({
      [legacyKeys.displayName]: " Ada ",
      [legacyKeys.email]: "BUILDER@example.com",
      [legacyKeys.firstSparkComplete]: "true",
      [legacyKeys.plaintextPassword]: "do-not-read",
    });

    expect(readLegacySnapshot(storage)).toEqual({
      displayName: "Ada",
      ownerEmail: "builder@example.com",
      firstSparkValue: "true",
      morseNameValue: null,
    });
    expect(storage.getItem).not.toHaveBeenCalledWith(legacyKeys.plaintextPassword);
  });

  it("never reads or transmits the legacy password during migration", async () => {
    const plaintextPassword = "do-not-read-or-send";
    const storage = createStorage({
      [legacyKeys.displayName]: "Ada",
      [legacyKeys.email]: "builder@example.com",
      [legacyKeys.firstSparkComplete]: "true",
      [legacyKeys.plaintextPassword]: plaintextPassword,
    });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => savedProgress),
    };

    await migrateLegacyData(storage, bootstrap(), api);

    expect(storage.getItem).not.toHaveBeenCalledWith(legacyKeys.plaintextPassword);
    expect(
      JSON.stringify({
        updateProfile: api.updateProfile.mock.calls,
        saveProgress: api.saveProgress.mock.calls,
      }),
    ).not.toContain(plaintextPassword);
  });

  it("preserves a legacy head start without fabricating hardware upload evidence", async () => {
    const storage = createStorage({
      [legacyKeys.displayName]: "Ada",
      [legacyKeys.email]: "builder@example.com",
      [legacyKeys.kitUnlocked]: "true",
      [legacyKeys.firstSparkComplete]: "true",
      [legacyKeys.morseNameComplete]: "true",
    });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async (lessonId: "first-spark" | "morse-name") => ({
        ...savedProgress,
        lessonId,
      })),
    };

    await expect(migrateLegacyData(storage, bootstrap(), api)).resolves.toBe(true);

    expect(api.updateProfile).toHaveBeenCalledWith("Ada");
    expect(api.saveProgress).toHaveBeenCalledOnce();
    expect(api.saveProgress).toHaveBeenNthCalledWith(
      1,
      "first-spark",
      {
        lessonVersion: 1,
        expectedRevision: null,
        status: "in_progress",
        currentStep: "compile-sketch",
        percentage: 50,
      },
    );
    expect(storage.values.has(legacyKeys.displayName)).toBe(false);
    expect(storage.values.has(legacyKeys.firstSparkComplete)).toBe(false);
    expect(storage.values.has(legacyKeys.morseNameComplete)).toBe(true);
    expect(storage.values.has(legacyKeys.email)).toBe(true);
    expect(storage.values.has(legacyKeys.kitUnlocked)).toBe(true);
  });

  it("migrates the Morse checkpoint once First Spark is evidence-backed on the server", async () => {
    const storage = createStorage({
      [legacyKeys.email]: "builder@example.com",
      [legacyKeys.morseNameComplete]: "true",
    });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => ({
        ...savedProgress,
        lessonId: "morse-name" as const,
        status: "in_progress" as const,
        currentStep: "compile-sketch",
        percentage: 50,
        completionEvidenceId: null,
        completedAt: null,
      })),
    };

    await expect(
      migrateLegacyData(storage, bootstrap({ progress: [savedProgress] }), api),
    ).resolves.toBe(true);

    expect(api.saveProgress).toHaveBeenCalledWith("morse-name", {
      lessonVersion: 1,
      expectedRevision: null,
      status: "in_progress",
      currentStep: "compile-sketch",
      percentage: 50,
    });
    expect(storage.values.has(legacyKeys.morseNameComplete)).toBe(false);
    expect(storage.values.has(legacyKeys.email)).toBe(false);
  });

  it("does not overwrite an established cross-device name or duplicate completion", async () => {
    const storage = createStorage({
      [legacyKeys.displayName]: "Old browser name",
      [legacyKeys.email]: "builder@example.com",
      [legacyKeys.firstSparkComplete]: "true",
    });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => savedProgress),
    };

    await expect(
      migrateLegacyData(
        storage,
        bootstrap({
          profile: { ...bootstrap().profile, displayName: "Server name" },
          progress: [savedProgress],
        }),
        api,
      ),
    ).resolves.toBe(false);

    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith(legacyKeys.displayName);
  });

  it("does not transfer or remove legacy progress owned by another account", async () => {
    const storage = createStorage({
      [legacyKeys.email]: "someone-else@example.com",
      [legacyKeys.firstSparkComplete]: "true",
    });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => savedProgress),
    };

    await expect(migrateLegacyData(storage, bootstrap(), api)).rejects.toThrow(
      "different or unverifiable account",
    );
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("keeps every migration key when synchronization fails so a later visit can retry", async () => {
    const storage = createStorage({
      [legacyKeys.email]: "builder@example.com",
      [legacyKeys.firstSparkComplete]: "true",
    });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(migrateLegacyData(storage, bootstrap(), api)).rejects.toThrow("offline");
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("does not migrate or remove progress before kit access exists", async () => {
    const storage = createStorage({ [legacyKeys.firstSparkComplete]: "true" });
    const api = {
      updateProfile: vi.fn(async () => undefined),
      saveProgress: vi.fn(async () => savedProgress),
    };

    await expect(
      migrateLegacyData(storage, bootstrap({ activation: null }), api),
    ).resolves.toBe(false);
    expect(api.saveProgress).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});

describe("legacy plaintext password purge", () => {
  it("removes exactly the obsolete password key", () => {
    const storage = createStorage({
      [legacyKeys.plaintextPassword]: "obsolete-secret",
      [legacyKeys.displayName]: "Ada",
    });

    purgeLegacyPlaintextPassword(storage);

    expect(storage.removeItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).toHaveBeenCalledWith(legacyKeys.plaintextPassword);
    expect(storage.values.has(legacyKeys.plaintextPassword)).toBe(false);
    expect(storage.values.get(legacyKeys.displayName)).toBe("Ada");
  });

  it("does not fail startup when storage rejects the removal", () => {
    const removeItem = vi.fn(() => {
      throw new DOMException("Storage is unavailable.", "SecurityError");
    });

    expect(() => {
      purgeLegacyPlaintextPassword({ removeItem });
    }).not.toThrow();
    expect(removeItem).toHaveBeenCalledWith(legacyKeys.plaintextPassword);
  });
});
