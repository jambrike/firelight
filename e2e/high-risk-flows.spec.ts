import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { LessonProgress } from "../shared/identity";
import {
  expectHermeticRequests,
  expectNoAxeViolations,
} from "./support/assertions";
import {
  E2E_LEARNER_ACCESS_TOKEN,
  E2E_PUBLIC_KEY,
  E2E_TIMESTAMP,
  installAppMocks,
  type AppMockOptions,
  type AppScenario,
  type InstalledAppMocks,
  type SerialScenario,
} from "./support/app-mocks";

const SESSION_STORAGE_KEY = "sb-127-auth-token";
const RECOVERY_VERIFIER_STORAGE_KEY = `${SESSION_STORAGE_KEY}-code-verifier`;
const LEGACY_STORAGE_KEYS = {
  email: "firelight-student-email",
  kitUnlocked: "firelight-kit-unlocked",
  firstSparkComplete: "firelight-first-tutorial-complete",
  plaintextPassword: "firelight-local-password",
} as const;

async function openApp(
  page: Page,
  path: string,
  scenario: AppScenario,
  serial: SerialScenario = "unsupported",
  options: AppMockOptions = {},
): Promise<InstalledAppMocks> {
  const mocks = await installAppMocks(page, scenario, serial, options);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  return mocks;
}

function completedFirstSpark(): LessonProgress {
  return {
    lessonId: "first-spark",
    lessonVersion: 1,
    revision: 8,
    status: "completed",
    currentStep: "finish-lesson",
    percentage: 100,
    codeSnapshot: null,
    completionEvidenceId: "77777777-7777-4777-8777-777777777777",
    completedAt: E2E_TIMESTAMP,
    updatedAt: E2E_TIMESTAMP,
  };
}

test.describe("high-risk account and curriculum journeys", () => {
  test("password recovery completes one continuous, verifier-bound PKCE session", async ({
    page,
  }) => {
    const email = "ada@example.test";
    const authCode = "fixed-firelight-recovery-code";
    const newPassword = "new-robotics-8";
    const mocks = await openApp(page, "/auth", "anonymous", "unsupported", {
      passwordRecovery: { email, authCode, newPassword },
    });

    await page.getByRole("button", { name: "Reset password", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Send a recovery link" }))
      .toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();

    await expect(
      page.getByRole("status").filter({ hasText: "Check your email for a secure reset link." }),
    ).toBeVisible();
    expect(mocks.passwordRecoveryRequests).toHaveLength(1);
    const recoveryRequest = mocks.passwordRecoveryRequests[0];
    expect(recoveryRequest).toBeDefined();
    if (!recoveryRequest) throw new Error("The password recovery request was not captured.");
    const recoveryUrl = new URL(recoveryRequest.url);
    expect(recoveryRequest.method).toBe("POST");
    expect(recoveryRequest.authorization).toBe(`Bearer ${E2E_PUBLIC_KEY}`);
    expect(recoveryUrl.pathname).toBe("/auth/v1/recover");
    expect([...recoveryUrl.searchParams.entries()]).toEqual([
      ["redirect_to", "http://127.0.0.1:4173/auth?mode=reset"],
    ]);
    expect(recoveryRequest.body).toEqual({
      email,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "s256",
      gotrue_meta_security: {},
    });

    const storedRecoveryVerifier = await page.evaluate(
      (storageKey) => {
        const raw = window.localStorage.getItem(storageKey);
        return raw === null ? null : JSON.parse(raw) as unknown;
      },
      RECOVERY_VERIFIER_STORAGE_KEY,
    );
    expect(typeof storedRecoveryVerifier).toBe("string");
    expect(storedRecoveryVerifier).toMatch(/^[A-Za-z0-9._~-]+\/recovery$/);
    if (
      typeof storedRecoveryVerifier !== "string" ||
      !storedRecoveryVerifier.endsWith("/recovery")
    ) {
      throw new Error("Supabase did not persist a recovery verifier.");
    }
    const verifier = storedRecoveryVerifier.slice(0, -"/recovery".length);
    const recoveryBody = recoveryRequest.body as { readonly code_challenge?: unknown };
    expect(
      createHash("sha256").update(verifier).digest("base64url"),
    ).toBe(recoveryBody.code_challenge);

    await page.goto(`/auth?mode=reset&code=${encodeURIComponent(authCode)}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("heading", { level: 2, name: "Choose a new password" }))
      .toBeVisible();
    await expect.poll(() => mocks.passwordExchangeRequests.length).toBe(1);
    expect(mocks.passwordExchangeRequests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:4173/auth/v1/token?grant_type=pkce",
        authorization: `Bearer ${E2E_PUBLIC_KEY}`,
        apiKey: E2E_PUBLIC_KEY,
        body: {
          auth_code: authCode,
          code_verifier: verifier,
        },
      },
    ]);
    await expect.poll(async () => page.evaluate(
      (storageKey) => window.localStorage.getItem(storageKey),
      RECOVERY_VERIFIER_STORAGE_KEY,
    )).toBeNull();

    await page.getByLabel("New password").fill(newPassword);
    await page.getByRole("button", { name: "Update password" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome back, Ada Builder." }),
    ).toBeVisible();
    await expect(page).toHaveURL("http://127.0.0.1:4173/auth");
    expect(mocks.passwordUpdateRequests).toEqual([
      {
        method: "PUT",
        url: "http://127.0.0.1:4173/auth/v1/user",
        authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
        body: {
          password: newPassword,
          code_challenge: null,
          code_challenge_method: null,
        },
      },
    ]);
    await expect.poll(async () => page.evaluate(
      (storageKey) => window.localStorage.getItem(storageKey),
      SESSION_STORAGE_KEY,
    )).not.toBeNull();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome back, Ada Builder." }),
    ).toBeVisible();
    await expect(page).toHaveURL("http://127.0.0.1:4173/auth");
    expect(mocks.passwordExchangeRequests).toHaveLength(1);
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });

  test("a failed Kit route chunk keeps the shell and presents durable recovery controls", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    const mocks = await installAppMocks(page, "anonymous");
    let failedChunkRequests = 0;
    await page.route(/\/assets\/KitPage-[^/]+\.js$/u, async (route) => {
      failedChunkRequests += 1;
      await route.abort("failed");
    });

    await page.goto("/kit", { waitUntil: "domcontentloaded" });

    await expect.poll(() => failedChunkRequests).toBe(1);
    await expect(page.locator("header.site-header")).toBeVisible();
    await expect(page.locator("footer.site-footer")).toBeVisible();
    await expect(page.getByRole("link", { name: "Firelight home" })).toHaveCount(2);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Trail interrupted");
    await expect(alert).toContainText("This part of camp did not arrive.");
    await expect(page.getByRole("button", { name: "Reload this page" })).toBeVisible();
    const homeLink = page.getByRole("link", { name: "Return to the campfire" });
    await expect(homeLink).toHaveAttribute("href", "/");
    await expectNoAxeViolations(page);

    await homeLink.click();
    await expect(page.getByRole("heading", { level: 1, name: "Firelight" })).toBeVisible();
    await page.getByRole("button", { name: "Begin the first spark" }).click();
    await expect(page.getByRole("button", { name: "Skip intro" })).toBeVisible();
    await page.getByRole("button", { name: "Skip intro" }).click();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Your builds should be waiting when you return.",
      }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
    expectHermeticRequests(mocks);
  });

  test("legacy completion remains local until its server checkpoint is confirmed", async ({
    page,
  }) => {
    const legacyPassword = "must-never-leave-this-browser";
    const mocks = await openApp(page, "/camp", "learner", "unsupported", {
      initialProgress: [],
      holdProgressSave: true,
      legacyStorage: {
        [LEGACY_STORAGE_KEYS.email]: "ada@example.test",
        [LEGACY_STORAGE_KEYS.kitUnlocked]: "true",
        [LEGACY_STORAGE_KEYS.firstSparkComplete]: "true",
        [LEGACY_STORAGE_KEYS.plaintextPassword]: legacyPassword,
      },
    });

    await expect.poll(() => mocks.progressRequests.length).toBe(1);
    await expect.poll(async () => page.evaluate(
      ({ completionKey, passwordKey }) => ({
        completion: window.localStorage.getItem(completionKey),
        password: window.localStorage.getItem(passwordKey),
      }),
      {
        completionKey: LEGACY_STORAGE_KEYS.firstSparkComplete,
        passwordKey: LEGACY_STORAGE_KEYS.plaintextPassword,
      },
    )).toEqual({ completion: "true", password: null });

    expect(mocks.progressRequests[0]).toEqual({
      method: "PUT",
      url: "http://127.0.0.1:4173/api/lessons/first-spark/progress",
      authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
      body: {
        lessonVersion: 1,
        expectedRevision: null,
        status: "in_progress",
        currentStep: "compile-sketch",
        percentage: 50,
      },
    });
    mocks.releaseProgressSave();
    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome back, Ada Builder." }),
    ).toBeVisible();
    await expect.poll(async () => page.evaluate(
      (keys) => keys.map((key) => window.localStorage.getItem(key)),
      [
        LEGACY_STORAGE_KEYS.email,
        LEGACY_STORAGE_KEYS.kitUnlocked,
        LEGACY_STORAGE_KEYS.firstSparkComplete,
      ],
    )).toEqual([null, null, null]);
    expect(mocks.protectedRequests.filter((request) => request === "GET /api/bootstrap"))
      .toHaveLength(2);
    for (const request of mocks.allRequests) {
      expect(request.url).not.toContain(legacyPassword);
      expect(JSON.stringify(request.headers)).not.toContain(legacyPassword);
      expect(request.body ?? "").not.toContain(legacyPassword);
    }
    expectHermeticRequests(mocks);
  });

  test("confirmed account deletion calls the API, signs out locally, and closes the route", async ({
    page,
  }) => {
    const mocks = await openApp(page, "/account", "learner", "unsupported", {
      accountDeletion: true,
    });

    await page.getByLabel("Type DELETE exactly to confirm").fill("DELETE");
    await page.getByRole("button", { name: "Permanently delete my account" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to open this part of camp." }),
    ).toBeVisible();
    expect(mocks.accountDeletionRequests).toEqual([
      {
        method: "DELETE",
        url: "http://127.0.0.1:4173/api/account",
        authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
        body: { confirmation: "DELETE" },
      },
    ]);
    expect(mocks.logoutRequests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:4173/auth/v1/logout?scope=local",
        authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
        body: null,
      },
    ]);
    await expect.poll(async () => page.evaluate(
      (storageKey) => window.localStorage.getItem(storageKey),
      SESSION_STORAGE_KEY,
    )).toBeNull();
    expect(mocks.protectedRequests).toContain("DELETE /api/account");
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });

  test("a locked lesson stays read-only and begins saving only after its current prerequisite", async ({
    page,
  }) => {
    const mocks = await openApp(page, "/learn/morse-name", "learner", "supported", {
      initialProgress: [],
    });

    await expect(
      page.getByRole("status").filter({ hasText: "Preview mode · complete First Spark first" }),
    ).toBeVisible();
    await expect(page.locator(".lesson-workspace")).toHaveAttribute("data-access", "preview");
    await page.getByRole("button", { name: "Edit the Arduino sketch" }).click();
    await expect(page.getByRole("textbox", { name: "Arduino sketch" }))
      .toHaveAttribute("readonly", "");
    await page.waitForTimeout(1_000);
    expect(mocks.progressRequests).toHaveLength(0);

    mocks.replaceProgress([completedFirstSpark()]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("status").filter({ hasText: "Builder mode · progress sync is on" }),
    ).toBeVisible();
    await expect(page.locator(".lesson-workspace")).toHaveAttribute("data-access", "builder");
    await page.getByRole("button", { name: "Edit the Arduino sketch" }).click();
    await expect(page.getByRole("textbox", { name: "Arduino sketch" }))
      .not.toHaveAttribute("readonly", "");
    await expect.poll(() => mocks.progressRequests.length).toBe(1);
    expect(mocks.progressRequests[0]).toMatchObject({
      method: "PUT",
      url: "http://127.0.0.1:4173/api/lessons/morse-name/progress",
      authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
      body: {
        lessonVersion: 1,
        expectedRevision: null,
        status: "in_progress",
        currentStep: "meet-the-build",
        percentage: 0,
      },
    });
    expect(mocks.progressRequests[0]?.body).toEqual(expect.objectContaining({
      codeSnapshot: expect.stringContaining("void setup()"),
    }));
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });
});
