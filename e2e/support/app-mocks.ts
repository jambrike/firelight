import type { Page, Request, Route } from "@playwright/test";
import type { Session, User } from "@supabase/supabase-js";
import type { AccountExport } from "../../shared/account-export";
import type { AdminPage } from "../../shared/admin";
import type {
  BootstrapData,
  KitActivation,
  LessonProgress,
  ProfileRole,
} from "../../shared/identity";

export const E2E_BASE_URL = "http://127.0.0.1:4173";
export const E2E_TIMESTAMP = "2026-08-08T10:00:00.000Z";
export const E2E_LEARNER_ID = "11111111-1111-4111-8111-111111111111";
export const E2E_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
export const E2E_FIRST_SPARK_SOURCE = `const unsigned int BLINK_MS = 500;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(BLINK_MS);
  digitalWrite(LED_BUILTIN, LOW);
  delay(BLINK_MS);
}
`;

const SESSION_STORAGE_KEY = "sb-127-auth-token";
const FAR_FUTURE_EXPIRY = 4_102_444_800;
const BUILD_ID = "a".repeat(40);

export type AppScenario = "anonymous" | "learner" | "admin";
export type SerialScenario = "supported" | "unsupported";

export interface RecordedJsonRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface AppMockOptions {
  readonly initiallyActivated?: boolean;
  readonly signup?: {
    readonly email: string;
    readonly displayName: string;
  };
  readonly kitClaimCode?: string;
  readonly accountExport?: boolean;
  readonly compileFailure?: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export interface InstalledAppMocks {
  readonly unexpectedRequests: readonly string[];
  readonly protectedRequests: readonly string[];
  readonly signupRequests: readonly RecordedJsonRequest[];
  readonly kitClaimRequests: readonly RecordedJsonRequest[];
  readonly accountExportRequests: readonly RecordedJsonRequest[];
  readonly compileRequests: readonly RecordedJsonRequest[];
}

interface MutableInstalledAppMocks {
  readonly unexpectedRequests: string[];
  readonly protectedRequests: string[];
  readonly signupRequests: RecordedJsonRequest[];
  readonly kitClaimRequests: RecordedJsonRequest[];
  readonly accountExportRequests: RecordedJsonRequest[];
  readonly compileRequests: RecordedJsonRequest[];
}

interface MutableScenarioState {
  activated: boolean;
}

function encodeJwtPart(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeAccessToken(ownerId: string, role: ProfileRole): string {
  const header = encodeJwtPart({ alg: "HS256", typ: "JWT" });
  const payload = encodeJwtPart({
    aud: "authenticated",
    exp: FAR_FUTURE_EXPIRY,
    iat: 1_786_180_800,
    iss: `${E2E_BASE_URL}/auth/v1`,
    role: "authenticated",
    session_id: role === "admin"
      ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sub: ownerId,
  });
  return `${header}.${payload}.ZTItdGVybWluYWwtc2lnbmF0dXJl`;
}

export const E2E_LEARNER_ACCESS_TOKEN = fakeAccessToken(E2E_LEARNER_ID, "learner");
export const E2E_ADMIN_ACCESS_TOKEN = fakeAccessToken(E2E_ADMIN_ID, "admin");

function fakeUser(role: ProfileRole): User {
  const admin = role === "admin";
  const id = admin ? E2E_ADMIN_ID : E2E_LEARNER_ID;
  const email = admin ? "support@example.test" : "ada@example.test";
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: E2E_TIMESTAMP,
    confirmed_at: E2E_TIMESTAMP,
    last_sign_in_at: E2E_TIMESTAMP,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { display_name: admin ? "Riley Support" : "Ada Builder" },
    identities: [],
    created_at: E2E_TIMESTAMP,
    updated_at: E2E_TIMESTAMP,
    is_anonymous: false,
  };
}

function fakeSession(role: ProfileRole): Session {
  const user = fakeUser(role);
  return {
    access_token: role === "admin" ? E2E_ADMIN_ACCESS_TOKEN : E2E_LEARNER_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: FAR_FUTURE_EXPIRY - 1_786_180_800,
    expires_at: FAR_FUTURE_EXPIRY,
    refresh_token: role === "admin" ? "e2e-admin-refresh" : "e2e-learner-refresh",
    user,
  };
}

function fakePendingUser(email: string, displayName: string): User {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    aud: "authenticated",
    role: "authenticated",
    email,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { display_name: displayName },
    identities: [],
    created_at: E2E_TIMESTAMP,
    updated_at: E2E_TIMESTAMP,
    is_anonymous: false,
  };
}

const firstSparkProgress: LessonProgress = {
  lessonId: "first-spark",
  lessonVersion: 1,
  revision: 7,
  status: "in_progress",
  currentStep: "compile-sketch",
  percentage: 50,
  codeSnapshot: E2E_FIRST_SPARK_SOURCE,
  completionEvidenceId: null,
  completedAt: null,
  updatedAt: E2E_TIMESTAMP,
};

function activation(role: ProfileRole): KitActivation {
  const admin = role === "admin";
  return {
    id: admin
      ? "44444444-4444-4444-8444-444444444444"
      : "33333333-3333-4333-8333-333333333333",
    batch: "e2e-pilot",
    kind: "code",
    claimedAt: E2E_TIMESTAMP,
  };
}

function bootstrap(role: ProfileRole, activated: boolean): BootstrapData {
  const admin = role === "admin";
  return {
    profile: {
      id: admin ? E2E_ADMIN_ID : E2E_LEARNER_ID,
      displayName: admin ? "Riley Support" : "Ada Builder",
      role,
      email: admin ? "support@example.test" : "ada@example.test",
      emailConfirmed: true,
      createdAt: E2E_TIMESTAMP,
      updatedAt: E2E_TIMESTAMP,
    },
    activation: activated ? activation(role) : null,
    progress: [firstSparkProgress],
    achievements: [
      { id: "first-upload", label: "First Upload", earned: false },
      { id: "name-signal", label: "Name Signal", earned: false },
      { id: "trail-complete", label: "Trail Complete", earned: false },
    ],
    nextLesson: { id: "first-spark", title: "First Spark" },
  };
}

function accountExport(): AccountExport {
  const data = bootstrap("learner", true);
  return {
    schema: "firelight.account-export",
    version: 2,
    exportedAt: E2E_TIMESTAMP,
    data: {
      profile: data.profile,
      activation: data.activation,
      progress: data.progress,
      compileJobs: [],
      uploadEvidence: [],
    },
  };
}

function emptyAdminPage<T>(): AdminPage<T> {
  return { items: [], limit: 20, offset: 0, nextOffset: null };
}

async function fulfillData(route: Route, data: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ data }),
  });
}

async function fulfillError(
  route: Route,
  error: NonNullable<AppMockOptions["compileFailure"]>,
): Promise<void> {
  await route.fulfill({
    status: error.status,
    contentType: "application/json; charset=utf-8",
    headers: { "X-Request-ID": error.requestId },
    body: JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        requestId: error.requestId,
      },
    }),
  });
}

function captureJsonRequest(request: Request): RecordedJsonRequest {
  const postData = request.postData();
  return {
    method: request.method(),
    url: request.url(),
    authorization: request.headers().authorization ?? null,
    body: postData === null ? null : JSON.parse(postData) as unknown,
  };
}

async function abortUnexpected(
  route: Route,
  request: Request,
  state: MutableInstalledAppMocks,
  reason: string,
): Promise<void> {
  state.unexpectedRequests.push(`${request.method()} ${request.url()} (${reason})`);
  await route.abort("blockedbyclient");
}

function expectedToken(scenario: Exclude<AppScenario, "anonymous">): string {
  const role: ProfileRole = scenario === "admin" ? "admin" : "learner";
  return fakeSession(role).access_token;
}

async function handleProtectedApi(
  route: Route,
  request: Request,
  scenario: Exclude<AppScenario, "anonymous">,
  state: MutableInstalledAppMocks,
  scenarioState: MutableScenarioState,
  options: AppMockOptions,
): Promise<boolean> {
  const authorization = request.headers().authorization;
  if (authorization !== `Bearer ${expectedToken(scenario)}`) {
    await abortUnexpected(route, request, state, "wrong bearer token");
    return true;
  }
  state.protectedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  const url = new URL(request.url());

  if (url.pathname === "/api/bootstrap" && request.method() === "GET") {
    const role: ProfileRole = scenario === "admin" ? "admin" : "learner";
    await fulfillData(route, bootstrap(role, scenarioState.activated));
    return true;
  }

  if (
    url.pathname === "/api/kits/claim" &&
    request.method() === "POST" &&
    options.kitClaimCode !== undefined
  ) {
    state.kitClaimRequests.push(captureJsonRequest(request));
    scenarioState.activated = true;
    await fulfillData(route, activation(scenario === "admin" ? "admin" : "learner"));
    return true;
  }

  if (
    url.pathname === "/api/account/export" &&
    request.method() === "GET" &&
    options.accountExport === true
  ) {
    state.accountExportRequests.push(captureJsonRequest(request));
    await fulfillData(route, accountExport());
    return true;
  }

  if (
    url.pathname === "/api/compile" &&
    request.method() === "POST" &&
    options.compileFailure !== undefined
  ) {
    state.compileRequests.push(captureJsonRequest(request));
    await fulfillError(route, options.compileFailure);
    return true;
  }

  if (scenario === "admin" && request.method() === "GET") {
    if (url.pathname === "/api/admin/kits") {
      await fulfillData(route, emptyAdminPage());
      return true;
    }
    if (url.pathname === "/api/admin/learners") {
      await fulfillData(route, emptyAdminPage());
      return true;
    }
    if (url.pathname === "/api/admin/compile-diagnostics") {
      await fulfillData(route, emptyAdminPage());
      return true;
    }
    if (url.pathname === "/api/admin/audit") {
      await fulfillData(route, emptyAdminPage());
      return true;
    }
  }

  const progressMatch = /^\/api\/lessons\/([^/]+)\/progress$/.exec(url.pathname);
  if (progressMatch && request.method() === "PUT") {
    const body = request.postDataJSON() as {
      readonly lessonVersion: number;
      readonly expectedRevision: number | null;
      readonly status: LessonProgress["status"];
      readonly currentStep: string;
      readonly percentage: number;
      readonly codeSnapshot?: string | null;
      readonly uploadEvidenceId?: string;
    };
    await fulfillData(route, {
      lessonId: progressMatch[1],
      lessonVersion: body.lessonVersion,
      revision: (body.expectedRevision ?? 0) + 1,
      status: body.status,
      currentStep: body.currentStep,
      percentage: body.percentage,
      codeSnapshot: body.codeSnapshot ?? null,
      completionEvidenceId: body.uploadEvidenceId ?? null,
      completedAt: body.status === "completed" ? E2E_TIMESTAMP : null,
      updatedAt: E2E_TIMESTAMP,
    });
    return true;
  }

  return false;
}

async function handleAuthProtocol(
  route: Route,
  request: Request,
  scenario: AppScenario,
  state: MutableInstalledAppMocks,
  options: AppMockOptions,
): Promise<void> {
  const url = new URL(request.url());
  if (
    scenario === "anonymous" &&
    url.pathname === "/auth/v1/signup" &&
    request.method() === "POST" &&
    options.signup !== undefined
  ) {
    state.signupRequests.push(captureJsonRequest(request));
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(fakePendingUser(options.signup.email, options.signup.displayName)),
    });
    return;
  }
  if (scenario === "anonymous") {
    await abortUnexpected(route, request, state, "anonymous auth request");
    return;
  }
  const role: ProfileRole = scenario === "admin" ? "admin" : "learner";
  const session = fakeSession(role);
  if (url.pathname === "/auth/v1/user" && request.method() === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(session.user),
    });
    return;
  }
  if (url.pathname === "/auth/v1/token" && request.method() === "POST") {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(session),
    });
    return;
  }
  if (url.pathname === "/auth/v1/logout" && request.method() === "POST") {
    await route.fulfill({ status: 204, body: "" });
    return;
  }
  await abortUnexpected(route, request, state, "unexpected auth protocol request");
}

export async function installAppMocks(
  page: Page,
  scenario: AppScenario,
  serial: SerialScenario = "unsupported",
  options: AppMockOptions = {},
): Promise<InstalledAppMocks> {
  const state: MutableInstalledAppMocks = {
    unexpectedRequests: [],
    protectedRequests: [],
    signupRequests: [],
    kitClaimRequests: [],
    accountExportRequests: [],
    compileRequests: [],
  };
  const scenarioState: MutableScenarioState = {
    activated: options.initiallyActivated ?? true,
  };
  const session = scenario === "anonymous"
    ? null
    : fakeSession(scenario === "admin" ? "admin" : "learner");

  await page.clock.setFixedTime(new Date(E2E_TIMESTAMP));
  await page.addInitScript(
    ({ storageKey, storedSession, serialScenario }) => {
      if (storedSession) {
        window.localStorage.setItem(storageKey, JSON.stringify(storedSession));
      } else {
        window.localStorage.removeItem(storageKey);
      }
      const serialValue = serialScenario === "supported"
        ? {
            requestPort: () => Promise.reject(
              new Error("The hermetic acceptance test never opens a real serial picker."),
            ),
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }
        : undefined;
      Object.defineProperty(window.navigator, "serial", {
        configurable: true,
        value: serialValue,
      });
    },
    { storageKey: SESSION_STORAGE_KEY, storedSession: session, serialScenario: serial },
  );

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== E2E_BASE_URL) {
      await abortUnexpected(route, request, state, "off-origin request");
      return;
    }

    if (url.pathname === "/api/config" && request.method() === "GET") {
      await fulfillData(route, {
        apiVersion: "v1",
        environment: "development",
        buildId: BUILD_ID,
        supabase: {
          url: E2E_BASE_URL,
          publishableKey: "e2e-public-publishable-key",
        },
        hardware: {
          fqbn: "arduino:avr:nano:cpu=atmega328old",
          uploadBaud: 57_600,
        },
      });
      return;
    }

    if (url.pathname.startsWith("/auth/v1/")) {
      await handleAuthProtocol(route, request, scenario, state, options);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (
        scenario !== "anonymous" &&
        await handleProtectedApi(route, request, scenario, state, scenarioState, options)
      ) {
        return;
      }
      await abortUnexpected(route, request, state, "unexpected application API request");
      return;
    }

    if (
      url.pathname.startsWith("/rest/v1/") ||
      url.pathname.startsWith("/realtime/v1/") ||
      url.pathname.startsWith("/storage/v1/") ||
      url.pathname.startsWith("/functions/v1/")
    ) {
      await abortUnexpected(route, request, state, "unexpected Supabase service request");
      return;
    }

    await route.continue();
  });

  return state;
}
