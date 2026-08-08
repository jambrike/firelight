import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  snapshotPathTemplate:
    "{testDir}/__snapshots__/{testFilePath}/{projectName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 0,
      threshold: 0,
    },
  },
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "en-IE",
    timezoneId: "Europe/Dublin",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    viewport: { width: 1_440, height: 1_000 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-pinned",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npm run preview",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
