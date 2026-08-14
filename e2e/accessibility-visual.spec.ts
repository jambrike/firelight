import { expect, test, type Page } from "@playwright/test";
import {
  expectHermeticRequests,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  stabilizeVisualPage,
} from "./support/assertions";
import {
  E2E_FIRST_SPARK_SOURCE,
  E2E_LEARNER_ACCESS_TOKEN,
  installAppMocks,
  type AppMockOptions,
  type AppScenario,
  type InstalledAppMocks,
  type SerialScenario,
} from "./support/app-mocks";

const DESKTOP = { width: 1_440, height: 1_000 };
const MOBILE = { width: 390, height: 844 };
const SHORT_MOBILE = { width: 390, height: 667 };

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

async function assertAccessibleVisual(
  page: Page,
  mocks: InstalledAppMocks,
  snapshotName: string,
): Promise<void> {
  await expectNoAxeViolations(page);
  await expectNoHorizontalOverflow(page);
  await stabilizeVisualPage(page);
  await expect(page).toHaveScreenshot(snapshotName, { fullPage: true });
  expectHermeticRequests(mocks);
}

test.describe("deterministic accessibility and visual states", () => {
  test("public home", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const mocks = await openApp(page, "/", "anonymous");

    await expect(page.getByRole("button", { name: "Skip intro" })).toBeVisible();
    await expectNoAxeViolations(page);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Skip intro" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Firelight" }),
    ).toBeVisible();
    await assertAccessibleVisual(page, mocks, "public-home.png");
  });

  test("mobile public home", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const mocks = await openApp(page, "/", "anonymous");

    await expect(page.getByText("Tap to continue")).toBeVisible();
    await expectNoAxeViolations(page);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Skip intro" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Firelight" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Begin the first spark" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Buy a Kit!" })).toBeVisible();
    await assertAccessibleVisual(page, mocks, "mobile-public-home.png");
  });

  test("short mobile home keeps the start action above the fold", async ({ page }) => {
    await page.setViewportSize(SHORT_MOBILE);
    const mocks = await openApp(page, "/", "anonymous");
    await page.getByRole("button", { name: "Skip intro" }).click();
    const startLink = page.getByRole("link", { name: "Begin the first spark" });

    await expect(startLink).toBeVisible();
    const startBox = await startLink.boundingBox();
    expect(startBox).not.toBeNull();
    expect((startBox?.y ?? 0) + (startBox?.height ?? 0)).toBeLessThanOrEqual(
      SHORT_MOBILE.height,
    );
    await expectNoHorizontalOverflow(page);
    expectHermeticRequests(mocks);
  });

  test("authenticated learners do not receive the opening story", async ({ page }) => {
    const mocks = await openApp(page, "/", "learner");

    await expect(page.getByRole("heading", { level: 1, name: "Firelight" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
    expectHermeticRequests(mocks);
  });

  test("mobile auth entry", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const mocks = await openApp(page, "/auth", "anonymous");

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Your builds should be waiting when you return.",
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    await assertAccessibleVisual(page, mocks, "mobile-auth.png");
  });

  test("activated learner camp with resume", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const mocks = await openApp(page, "/camp", "learner");

    await expect(
      page.getByRole("heading", { level: 1, name: "Welcome back, Ada Builder." }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Resume trail" })).toHaveAttribute(
      "href",
      "/learn/first-spark",
    );
    expect(mocks.protectedRequests).toContain("GET /api/bootstrap");
    await assertAccessibleVisual(page, mocks, "activated-camp.png");
  });

  test("admin support console", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const mocks = await openApp(page, "/admin", "admin");

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "A small console for keeping builders moving.",
      }),
    ).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Pilot support data loaded." }))
      .toBeVisible();
    expect(mocks.protectedRequests).toEqual(expect.arrayContaining([
      "GET /api/bootstrap",
      "GET /api/admin/kits",
      "GET /api/admin/learners",
      "GET /api/admin/compile-diagnostics",
      "GET /api/admin/audit",
    ]));
    await assertAccessibleVisual(page, mocks, "admin-console.png");
  });

  test("supported First Spark hardware step", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const mocks = await openApp(page, "/learn/first-spark", "learner", "supported");

    await expect(page.getByRole("heading", { level: 1, name: "First Spark" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Build the sketch" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compile sketch" })).toBeEnabled();
    await expect(
      page.getByText(
        "Connect the board by USB, then choose its serial port in desktop Chrome or Edge.",
      ).first(),
    ).toBeVisible();
    expect(mocks.protectedRequests).toContain("GET /api/bootstrap");
    await assertAccessibleVisual(page, mocks, "first-spark-supported.png");
  });

  test("unsupported First Spark hardware guidance", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const mocks = await openApp(page, "/learn/first-spark", "learner", "unsupported");

    await expect(page.getByRole("heading", { level: 1, name: "First Spark" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Build the sketch" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compile sketch" })).toBeDisabled();
    await expect(
      page.getByText("Web Serial requires a current desktop Chrome or Microsoft Edge browser.")
        .first(),
    ).toBeVisible();
    await assertAccessibleVisual(page, mocks, "first-spark-unsupported.png");
  });
});

test.describe("authorization and keyboard focus", () => {
  test("learner receives the admin denial without privileged API calls", async ({ page }) => {
    const mocks = await openApp(page, "/admin", "learner");

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "This trail is for Firelight support staff.",
      }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    expect(mocks.protectedRequests).toEqual(["GET /api/bootstrap"]);
    expectHermeticRequests(mocks);
  });

  test("skip link and client route changes move focus to main content", async ({ page }) => {
    const mocks = await openApp(page, "/", "learner");
    await expect(
      page.getByRole("heading", { level: 1, name: "Firelight" }),
    ).toBeVisible();

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    const learnLink = page.getByRole("link", { name: "Learn" });
    await learnLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/learn$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Build path loaded." }))
      .toBeAttached();
    expectHermeticRequests(mocks);
  });

  test("mobile menu is operable by keyboard and closes on navigation", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const mocks = await openApp(page, "/auth", "anonymous");
    const menuButton = page.getByRole("button", { name: "Open menu" });

    await menuButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Learn", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/learn$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expectHermeticRequests(mocks);
  });

  test("a narrow lesson step selection moves focus to the new stage heading", async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const mocks = await openApp(page, "/learn/first-spark", "learner", "supported");
    await expect(page.getByRole("heading", { level: 2, name: "Build the sketch" })).toBeVisible();

    const wiringStep = page.getByRole("button", { name: "Follow the wiring instructions" });
    await wiringStep.focus();
    await page.keyboard.press("Enter");
    const stageHeading = page.getByRole("heading", { level: 2, name: "Wire the build" });
    await expect(stageHeading).toBeVisible();
    await expect(stageHeading).toBeFocused();
    expectHermeticRequests(mocks);
  });
});

test.describe("hermetic functional journeys", () => {
  test("create account uses the normal Supabase signup protocol", async ({ page }) => {
    const email = "new.builder@example.test";
    const password = "robotics8";
    const displayName = "New Builder";
    const mocks = await openApp(page, "/auth", "anonymous", "unsupported", {
      signup: { email, displayName },
    });

    await page.getByRole("button", { name: "Create account", exact: true }).click();
    const form = page.locator("form.identity-form");
    await form.getByLabel("Builder name").fill(displayName);
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill(password);
    await form.getByRole("button", { name: "Create account", exact: true }).click();

    await expect(
      page.getByRole("status").filter({
        hasText: "Account created. Check your email if confirmation is required.",
      }),
    ).toBeVisible();
    expect(mocks.signupRequests).toHaveLength(1);
    const signupRequest = mocks.signupRequests[0];
    expect(signupRequest).toBeDefined();
    if (!signupRequest) throw new Error("The expected signup request was not captured.");
    const signupUrl = new URL(signupRequest.url);
    expect(signupRequest.method).toBe("POST");
    expect(signupUrl.pathname).toBe("/auth/v1/signup");
    expect([...signupUrl.searchParams.entries()]).toEqual([
      ["redirect_to", "http://127.0.0.1:4173/auth"],
    ]);
    expect(signupRequest.body).toEqual({
      email,
      password,
      data: { display_name: displayName },
      gotrue_meta_security: {},
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "s256",
    });
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });

  test("an unactivated learner claims one kit and refreshes connected access", async ({ page }) => {
    const kitCode = "ABCD-EFGH-JKMP-NRST";
    const mocks = await openApp(page, "/activate", "learner", "unsupported", {
      initiallyActivated: false,
      kitClaimCode: kitCode,
    });

    await expect(page.getByRole("heading", { level: 2, name: "Enter the code inside your box" }))
      .toBeVisible();
    await page.getByLabel("Kit code").fill(kitCode);
    await page.getByRole("button", { name: "Activate kit" }).click();

    await expect(page.getByRole("heading", { level: 2, name: "Kit connected" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open your camp" })).toHaveAttribute(
      "href",
      "/camp",
    );
    expect(mocks.kitClaimRequests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:4173/api/kits/claim",
        authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
        body: { code: kitCode },
      },
    ]);
    expect(mocks.protectedRequests.filter((request) => request === "GET /api/bootstrap"))
      .toHaveLength(2);
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });

  test("account export works and deletion remains gated by exact confirmation", async ({ page }) => {
    const mocks = await openApp(page, "/account", "learner", "unsupported", {
      accountExport: true,
    });

    await expect(page.getByRole("heading", { level: 1, name: "One place for your profile, kit, and data." }))
      .toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Connected kit" })).toBeVisible();
    const deleteButton = page.getByRole("button", { name: "Permanently delete my account" });
    const deleteConfirmation = page.getByLabel("Type DELETE exactly to confirm");
    await expect(deleteButton).toBeDisabled();
    await deleteConfirmation.fill("delete");
    await expect(deleteButton).toBeDisabled();

    await page.getByRole("button", { name: "Export complete JSON" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Complete account data downloaded as JSON." }),
    ).toBeVisible();
    expect(mocks.accountExportRequests).toEqual([
      {
        method: "GET",
        url: "http://127.0.0.1:4173/api/account/export",
        authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
        body: null,
      },
    ]);

    await deleteConfirmation.fill("DELETE");
    await expect(deleteButton).toBeEnabled();
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });

  test("a structured compiler rejection reaches the First Spark error state", async ({ page }) => {
    const compileFailure = {
      status: 422,
      code: "COMPILE_FAILED",
      message: "The secure compiler rejected this sketch.",
      requestId: "e2e-compile-failure",
    } as const;
    const mocks = await openApp(page, "/learn/first-spark", "learner", "supported", {
      compileFailure,
    });

    await page.getByRole("button", { name: "Compile sketch" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: compileFailure.message }).first(),
    ).toBeVisible();
    expect(mocks.compileRequests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:4173/api/compile",
        authorization: `Bearer ${E2E_LEARNER_ACCESS_TOKEN}`,
        body: {
          lessonId: "first-spark",
          lessonVersion: 1,
          fqbn: "arduino:avr:nano:cpu=atmega328old",
          source: E2E_FIRST_SPARK_SOURCE,
        },
      },
    ]);
    await expectNoAxeViolations(page);
    expectHermeticRequests(mocks);
  });
});
