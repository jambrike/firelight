import { afterEach, describe, expect, it } from "vitest";
import {
  WebStorageProgressDraftPersistence,
  isValidPersistedDraft,
} from "./draft-persistence";
import type { ProgressDraftScope } from "./draft-persistence";

const now = Date.parse("2026-08-07T12:00:00.000Z");
const firstScope: ProgressDraftScope = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  lessonId: "first-spark",
  lessonVersion: 1,
};
const secondScope: ProgressDraftScope = {
  ...firstScope,
  ownerId: "22222222-2222-4222-8222-222222222222",
};

afterEach(() => {
  window.localStorage.clear();
});

describe("WebStorageProgressDraftPersistence", () => {
  it("round-trips one bounded draft without exposing it to another user", () => {
    const persistence = new WebStorageProgressDraftPersistence(window.localStorage, () => now);
    const draft = {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 30,
      codeSnapshot: "void setup() {}",
    } as const;

    persistence.save(firstScope, draft);

    expect(persistence.load(firstScope)).toEqual(draft);
    expect(persistence.load(secondScope)).toBeNull();
  });

  it("rejects invalid and oversized records before writing", () => {
    const persistence = new WebStorageProgressDraftPersistence(window.localStorage, () => now);
    const oversized = {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 30,
      codeSnapshot: "x".repeat(65_537),
    } as const;

    expect(isValidPersistedDraft(oversized)).toBe(false);
    persistence.save(firstScope, oversized);
    expect(window.localStorage).toHaveLength(0);
  });

  it("retains a retryable completion only with its sketch and upload evidence", () => {
    const persistence = new WebStorageProgressDraftPersistence(window.localStorage, () => now);
    const completed = {
      status: "completed",
      currentStep: "finish-lesson",
      percentage: 100,
      codeSnapshot: "void setup() {}\nvoid loop() {}",
      uploadEvidenceId: "55555555-5555-4555-8555-555555555555",
    } as const;

    persistence.save(firstScope, completed);

    expect(persistence.load(firstScope)).toEqual(completed);
    expect(
      isValidPersistedDraft({
        status: "completed",
        currentStep: "finish-lesson",
        percentage: 100,
        codeSnapshot: completed.codeSnapshot,
      }),
    ).toBe(false);
    expect(
      isValidPersistedDraft({
        status: "in_progress",
        currentStep: "compile-sketch",
        percentage: 50,
        uploadEvidenceId: completed.uploadEvidenceId,
      }),
    ).toBe(false);
  });

  it("removes expired drafts instead of restoring them", () => {
    let clock = now;
    const persistence = new WebStorageProgressDraftPersistence(
      window.localStorage,
      () => clock,
    );
    persistence.save(firstScope, {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 30,
    });

    clock += 31 * 24 * 60 * 60 * 1_000;

    expect(persistence.load(firstScope)).toBeNull();
    expect(window.localStorage).toHaveLength(0);
  });

  it("purges every exact owner-scoped draft without touching another owner", () => {
    const persistence = new WebStorageProgressDraftPersistence(window.localStorage, () => now);
    const anotherLesson: ProgressDraftScope = {
      ...firstScope,
      lessonId: "morse-name",
      lessonVersion: 2,
    };
    const lookalikeOwner: ProgressDraftScope = {
      ...firstScope,
      ownerId: `${firstScope.ownerId}-shared`,
    };
    const value = {
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 30,
    } as const;
    persistence.save(firstScope, value);
    persistence.save(anotherLesson, value);
    persistence.save(secondScope, value);
    persistence.save(lookalikeOwner, value);
    window.localStorage.setItem("unrelated-account-setting", "keep");

    persistence.removeOwner(firstScope.ownerId);

    expect(persistence.load(firstScope)).toBeNull();
    expect(persistence.load(anotherLesson)).toBeNull();
    expect(persistence.load(secondScope)).toEqual(value);
    expect(persistence.load(lookalikeOwner)).toEqual(value);
    expect(window.localStorage.getItem("unrelated-account-setting")).toBe("keep");
  });
});
