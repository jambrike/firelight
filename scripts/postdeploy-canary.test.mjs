import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  CanaryError,
  FIRELIGHT_BOARD_FQBN,
  buildFirstSparkProgressReplay,
  fetchBounded,
  makeSupabaseFetch,
  parseDataEnvelope,
  parsePostdeployEnvironment,
  readBoundedBytes,
  runPostdeployCanary,
  safeCanaryErrorCode,
  sha256Hex,
  validateCompileArtifact,
  validateBootstrap,
  validateFirstSparkProgressResponse,
  validateIntelHex,
  validateRuntimeConfig,
} from "./postdeploy-canary.mjs";

/* global ReadableStream, Response */

const BUILD_SHA = "a".repeat(40);
const PROJECT_REF = "abcdefghijklmnopqrst";
const BASE_URL = "https://staging.firelight.ie";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const PUBLISHABLE_KEY = "sb_publishable_canary_public_key";
const ACCESS_TOKEN = "canary-access-token-that-stays-private";
const CANARY_USER_ID = "11111111-1111-4111-8111-111111111111";
const STARTER_CODE = `const unsigned int BLINK_MS = 500;

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
const VALID_HEX = ":100000000C945C000C946E000C946E000C946E00CA\n:00000001FF\n";
const FIRST_SPARK_LESSON = {
  id: "first-spark",
  version: 1,
  starterCode: STARTER_CODE,
};
const PROGRESS_UPDATED_AT = "2026-08-08T10:00:00.000Z";

const environment = {
  FIRELIGHT_BASE_URL: BASE_URL,
  FIRELIGHT_EXPECTED_ENVIRONMENT: "staging",
  FIRELIGHT_EXPECTED_BUILD_ID: BUILD_SHA,
  FIRELIGHT_EXPECTED_SUPABASE_PROJECT_REF: PROJECT_REF,
  FIRELIGHT_CANARY_EMAIL: "release-canary@example.test",
  FIRELIGHT_CANARY_PASSWORD: "not-a-real-password",
};
const authenticatedIdentity = {
  userId: CANARY_USER_ID,
  email: environment.FIRELIGHT_CANARY_EMAIL,
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function statusBody(status) {
  return {
    data: {
      status,
      environment: "staging",
      buildId: BUILD_SHA,
    },
  };
}

function runtimeConfigBody(overrides = {}) {
  return {
    data: {
      apiVersion: "v1",
      environment: "staging",
      buildId: BUILD_SHA,
      supabase: {
        url: SUPABASE_URL,
        publishableKey: PUBLISHABLE_KEY,
        ...overrides,
      },
      hardware: {
        fqbn: FIRELIGHT_BOARD_FQBN,
        uploadBaud: 57_600,
      },
    },
  };
}

function bootstrapBody(progress = []) {
  return {
    data: {
      profile: {
        id: CANARY_USER_ID,
        displayName: "Release Canary",
        role: "learner",
        email: "release-canary@example.test",
        emailConfirmed: true,
        createdAt: "2026-08-08T10:00:00.000Z",
        updatedAt: "2026-08-08T10:00:00.000Z",
      },
      activation: {
        id: "22222222-2222-4222-8222-222222222222",
        batch: "release-canary",
        kind: "code",
        claimedAt: "2026-08-08T10:00:00.000Z",
      },
      progress,
      achievements: [],
      nextLesson: null,
    },
  };
}

function progressRecord(overrides = {}) {
  return {
    lessonId: "first-spark",
    lessonVersion: 1,
    revision: 7,
    status: "in_progress",
    currentStep: "compile-sketch",
    percentage: 50,
    codeSnapshot: STARTER_CODE,
    completionEvidenceId: null,
    completedAt: null,
    updatedAt: PROGRESS_UPDATED_AT,
    ...overrides,
  };
}

function progressBody(overrides = {}) {
  return { data: progressRecord(overrides) };
}

function compileBody(source = STARTER_CODE, hex = VALID_HEX) {
  return {
    data: {
      compileJobId: "33333333-3333-4333-8333-333333333333",
      format: "intel-hex",
      fqbn: FIRELIGHT_BOARD_FQBN,
      sourceHash: sha256Hex(source),
      artifactHash: sha256Hex(hex),
      hex,
      diagnostics: [],
    },
  };
}

function assertCanaryCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof CanaryError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

test("parsePostdeployEnvironment accepts only a hosted release identity", () => {
  const parsed = parsePostdeployEnvironment(environment);
  const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  assert.deepEqual(parsed, {
    baseUrl: BASE_URL,
    expectedEnvironment: "staging",
    expectedBuildId: BUILD_SHA,
    expectedSupabaseProjectRef: PROJECT_REF,
    email: environment.FIRELIGHT_CANARY_EMAIL,
    password: environment.FIRELIGHT_CANARY_PASSWORD,
    repositoryRoot,
  });

  assert.throws(
    () => parsePostdeployEnvironment({ ...environment, FIRELIGHT_BASE_URL: `${BASE_URL}/` }),
    assertCanaryCode("INVALID_FIRELIGHT_BASE_URL"),
  );
  assert.throws(
    () => parsePostdeployEnvironment({
      ...environment,
      FIRELIGHT_BASE_URL: "https://attacker.example",
    }),
    assertCanaryCode("FIRELIGHT_BASE_URL_MISMATCH"),
  );
  assert.throws(
    () => parsePostdeployEnvironment({
      ...environment,
      FIRELIGHT_EXPECTED_BUILD_ID: BUILD_SHA.toUpperCase(),
    }),
    assertCanaryCode("INVALID_FIRELIGHT_EXPECTED_BUILD_ID"),
  );
  assert.throws(
    () => parsePostdeployEnvironment({
      ...environment,
      FIRELIGHT_EXPECTED_SUPABASE_PROJECT_REF: `${PROJECT_REF.slice(0, 19)}!`,
    }),
    assertCanaryCode("INVALID_FIRELIGHT_EXPECTED_SUPABASE_PROJECT_REF"),
  );
  assert.equal(parsePostdeployEnvironment({
    ...environment,
    FIRELIGHT_BASE_URL: "https://firelight.ie",
    FIRELIGHT_EXPECTED_ENVIRONMENT: "production",
  }).baseUrl, "https://firelight.ie");
  assert.equal(parsePostdeployEnvironment({
    ...environment,
    FIRELIGHT_CANARY_REPOSITORY_ROOT: repositoryRoot,
  }).repositoryRoot, repositoryRoot);
  assert.throws(
    () => parsePostdeployEnvironment({
      ...environment,
      FIRELIGHT_CANARY_REPOSITORY_ROOT: "relative/checkout",
    }),
    assertCanaryCode("INVALID_FIRELIGHT_CANARY_REPOSITORY_ROOT"),
  );
});

test("bootstrap requires a confirmed, activated learner canary", () => {
  assert.deepEqual(validateBootstrap(bootstrapBody(), authenticatedIdentity), {
    profileId: CANARY_USER_ID,
    activationId: "22222222-2222-4222-8222-222222222222",
  });
  const admin = bootstrapBody();
  admin.data.profile.role = "admin";
  assert.throws(
    () => validateBootstrap(admin, authenticatedIdentity),
    assertCanaryCode("CANARY_PROFILE_NOT_CONFIRMED"),
  );
  const unconfirmed = bootstrapBody();
  unconfirmed.data.profile.emailConfirmed = false;
  assert.throws(
    () => validateBootstrap(unconfirmed, authenticatedIdentity),
    assertCanaryCode("CANARY_PROFILE_NOT_CONFIRMED"),
  );
  const inactive = bootstrapBody();
  inactive.data.activation = null;
  assert.throws(
    () => validateBootstrap(inactive, authenticatedIdentity),
    assertCanaryCode("CANARY_ACTIVATION_REQUIRED"),
  );
  const wrongOwner = bootstrapBody();
  wrongOwner.data.profile.id = "99999999-9999-4999-8999-999999999999";
  assert.throws(
    () => validateBootstrap(wrongOwner, authenticatedIdentity),
    assertCanaryCode("CANARY_PROFILE_NOT_CONFIRMED"),
  );
  const wrongEmail = bootstrapBody();
  wrongEmail.data.profile.email = "other@example.test";
  assert.throws(
    () => validateBootstrap(wrongEmail, authenticatedIdentity),
    assertCanaryCode("CANARY_PROFILE_NOT_CONFIRMED"),
  );
});

test("First Spark progress creates safely or replays the current checkpoint", () => {
  const createdReplay = buildFirstSparkProgressReplay(
    bootstrapBody(),
    FIRST_SPARK_LESSON,
  );
  assert.deepEqual(createdReplay, {
    request: {
      lessonVersion: 1,
      expectedRevision: null,
      status: "not_started",
      currentStep: "meet-the-build",
      percentage: 0,
    },
    previous: null,
  });
  assert.deepEqual(
    validateFirstSparkProgressResponse(
      progressBody({
        revision: 1,
        status: "not_started",
        currentStep: "meet-the-build",
        percentage: 0,
        codeSnapshot: null,
      }),
      createdReplay,
    ),
    { revision: 1, updatedAt: PROGRESS_UPDATED_AT },
  );

  const current = progressRecord();
  const replay = buildFirstSparkProgressReplay(
    bootstrapBody([current]),
    FIRST_SPARK_LESSON,
  );
  assert.deepEqual(replay.request, {
    lessonVersion: 1,
    expectedRevision: 7,
    status: "in_progress",
    currentStep: "compile-sketch",
    percentage: 50,
  });
  assert.deepEqual(
    validateFirstSparkProgressResponse(
      progressBody({ revision: 8, updatedAt: "2026-08-08T10:01:00.000Z" }),
      replay,
    ),
    { revision: 8, updatedAt: "2026-08-08T10:01:00.000Z" },
  );
  assert.throws(
    () => validateFirstSparkProgressResponse({
      data: {
        ...progressBody({ revision: 8 }).data,
        unexpected: true,
      },
    }, replay),
    assertCanaryCode("INVALID_PROGRESS_RESPONSE"),
  );
  assert.throws(
    () => buildFirstSparkProgressReplay(
      bootstrapBody([current, current]),
      FIRST_SPARK_LESSON,
    ),
    assertCanaryCode("INVALID_BOOTSTRAP_PROGRESS"),
  );
  assert.throws(
    () => buildFirstSparkProgressReplay(
      bootstrapBody(Array.from({ length: 257 }, () => ({}))),
      FIRST_SPARK_LESSON,
    ),
    assertCanaryCode("INVALID_BOOTSTRAP_PROGRESS"),
  );
});

test("completed First Spark replay carries evidence and rejects revision drift", () => {
  const evidenceId = "44444444-4444-4444-8444-444444444444";
  const completedAt = "2026-08-08T09:00:00.000Z";
  const current = progressRecord({
    revision: 11,
    status: "completed",
    currentStep: "finish-lesson",
    percentage: 100,
    completionEvidenceId: evidenceId,
    completedAt,
  });
  const replay = buildFirstSparkProgressReplay(
    bootstrapBody([current]),
    FIRST_SPARK_LESSON,
  );
  assert.deepEqual(replay.request, {
    lessonVersion: 1,
    expectedRevision: 11,
    status: "completed",
    currentStep: "finish-lesson",
    percentage: 100,
    codeSnapshot: STARTER_CODE,
    uploadEvidenceId: evidenceId,
  });
  const response = progressBody({
    revision: 12,
    status: "completed",
    currentStep: "finish-lesson",
    percentage: 100,
    completionEvidenceId: evidenceId,
    completedAt,
    updatedAt: "2026-08-08T10:02:00.000Z",
  });
  assert.deepEqual(validateFirstSparkProgressResponse(response, replay), {
    revision: 12,
    updatedAt: "2026-08-08T10:02:00.000Z",
  });
  assert.throws(
    () => validateFirstSparkProgressResponse({
      data: { ...response.data, revision: 11 },
    }, replay),
    assertCanaryCode("INVALID_PROGRESS_RESPONSE"),
  );

  const missingEvidence = progressRecord({
    status: "completed",
    currentStep: "finish-lesson",
    percentage: 100,
    codeSnapshot: null,
    completionEvidenceId: null,
    completedAt,
  });
  assert.throws(
    () => buildFirstSparkProgressReplay(
      bootstrapBody([missingEvidence]),
      FIRST_SPARK_LESSON,
    ),
    assertCanaryCode("INVALID_BOOTSTRAP_PROGRESS"),
  );
});

test("runtime config rejects a different Supabase project and extra envelope fields", () => {
  const parsed = parsePostdeployEnvironment(environment);
  assert.deepEqual(validateRuntimeConfig(runtimeConfigBody(), parsed), {
    supabaseUrl: SUPABASE_URL,
    publishableKey: PUBLISHABLE_KEY,
  });
  assert.throws(
    () => validateRuntimeConfig(
      runtimeConfigBody({ url: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }),
      parsed,
    ),
    assertCanaryCode("SUPABASE_PROJECT_MISMATCH"),
  );
  assert.throws(
    () => parseDataEnvelope({ data: {}, metadata: {} }),
    assertCanaryCode("INVALID_DATA_ENVELOPE"),
  );
});

test("bounded response reader rejects declared and streamed overflow", async () => {
  await assert.rejects(
    readBoundedBytes(
      new Response("small", { headers: { "Content-Length": "999" } }),
      10,
    ),
    assertCanaryCode("RESPONSE_TOO_LARGE"),
  );

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedBytes(new Response(stream), 10),
    assertCanaryCode("RESPONSE_TOO_LARGE"),
  );
});

test("bounded fetch fails closed when its deadline expires", async () => {
  const stalledFetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(
    fetchBounded(stalledFetch, BASE_URL, {}, { timeoutMs: 1, maximumBytes: 10 }),
    assertCanaryCode("REQUEST_TIMEOUT"),
  );
});

test("Supabase fetch wrapper preserves bodyless response statuses", async () => {
  const wrappedFetch = makeSupabaseFetch(async () =>
    new Response(null, { status: 204 }),
  );

  const response = await wrappedFetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method: "POST",
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("compile validation binds the source, artifact hash, and Intel HEX image", () => {
  assert.deepEqual(validateCompileArtifact(compileBody(), STARTER_CODE), {
    compileJobId: "33333333-3333-4333-8333-333333333333",
    dataBytes: 16,
  });
  assert.throws(
    () => validateCompileArtifact({
      data: { ...compileBody().data, artifactHash: "b".repeat(64) },
    }, STARTER_CODE),
    assertCanaryCode("INVALID_COMPILE_ARTIFACT"),
  );
  assert.throws(
    () => validateIntelHex(":00000001FF\n"),
    assertCanaryCode("INVALID_COMPILE_ARTIFACT"),
  );
});

test("runPostdeployCanary checks every dependency and globally signs out", async () => {
  const configuration = parsePostdeployEnvironment(environment);
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname, init });
    if (url.pathname === "/api/health") return jsonResponse(statusBody("ok"));
    if (url.pathname === "/api/readiness") return jsonResponse(statusBody("ready"));
    if (url.pathname === "/api/config") return jsonResponse(runtimeConfigBody());
    if (url.pathname === "/api/bootstrap") return jsonResponse(bootstrapBody());
    if (url.pathname === "/api/lessons/first-spark/progress") {
      return jsonResponse(progressBody({
        revision: 1,
        status: "not_started",
        currentStep: "meet-the-build",
        percentage: 0,
        codeSnapshot: null,
      }));
    }
    if (url.pathname === "/api/compile") return jsonResponse(compileBody());
    throw new Error("unexpected mocked request");
  };
  const signOutScopes = [];
  let clientOptions;
  const createClientImpl = (url, key, options) => {
    assert.equal(url, SUPABASE_URL);
    assert.equal(key, PUBLISHABLE_KEY);
    clientOptions = options;
    return {
      auth: {
        signInWithPassword: async (credentials) => {
          assert.equal(credentials.email, environment.FIRELIGHT_CANARY_EMAIL);
          assert.equal(credentials.password, environment.FIRELIGHT_CANARY_PASSWORD);
          return {
            data: {
              session: { access_token: ACCESS_TOKEN },
              user: {
                id: CANARY_USER_ID,
                email: environment.FIRELIGHT_CANARY_EMAIL,
              },
            },
            error: null,
          };
        },
        signOut: async (options_) => {
          signOutScopes.push(options_.scope);
          return { error: null };
        },
      },
    };
  };

  const result = await runPostdeployCanary(configuration, {
    fetchImpl,
    createClientImpl,
    loadLessonImpl: async (repositoryRoot) => {
      assert.equal(repositoryRoot, configuration.repositoryRoot);
      return FIRST_SPARK_LESSON;
    },
  });

  assert.deepEqual(result, {
    environment: "staging",
    buildId: BUILD_SHA,
    compileJobId: "33333333-3333-4333-8333-333333333333",
    progressRevision: 1,
  });
  assert.deepEqual(signOutScopes, ["global"]);
  assert.equal(clientOptions.auth.persistSession, false);
  assert.equal(clientOptions.auth.autoRefreshToken, false);
  assert.equal(clientOptions.auth.detectSessionInUrl, false);
  assert.equal(typeof clientOptions.global.fetch, "function");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/health",
    "/api/readiness",
    "/api/config",
    "/api/bootstrap",
    "/api/lessons/first-spark/progress",
    "/api/compile",
  ]);
  const progressCall = calls.at(-2);
  assert.equal(progressCall.init.method, "PUT");
  assert.equal(progressCall.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(progressCall.init.body), {
    lessonVersion: 1,
    expectedRevision: null,
    status: "not_started",
    currentStep: "meet-the-build",
    percentage: 0,
  });
  const compileCall = calls.at(-1);
  assert.equal(compileCall.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(JSON.parse(compileCall.init.body), {
    lessonId: "first-spark",
    lessonVersion: 1,
    fqbn: FIRELIGHT_BOARD_FQBN,
    source: STARTER_CODE,
  });
});

test("runPostdeployCanary signs out after an authenticated failure", async () => {
  const configuration = parsePostdeployEnvironment(environment);
  let signedOut = false;
  const fetchImpl = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return jsonResponse(statusBody("ok"));
    if (path === "/api/readiness") return jsonResponse(statusBody("ready"));
    if (path === "/api/config") return jsonResponse(runtimeConfigBody());
    if (path === "/api/bootstrap") {
      return jsonResponse({
        error: { code: "SERVICE_NOT_READY", message: "not ready", requestId: "request" },
      }, 503);
    }
    throw new Error("unexpected mocked request");
  };
  const createClientImpl = () => ({
    auth: {
      signInWithPassword: async () => ({
        data: {
          session: { access_token: ACCESS_TOKEN },
          user: {
            id: CANARY_USER_ID,
            email: environment.FIRELIGHT_CANARY_EMAIL,
          },
        },
        error: null,
      }),
      signOut: async ({ scope }) => {
        assert.equal(scope, "global");
        signedOut = true;
        return { error: null };
      },
    },
  });

  await assert.rejects(
    runPostdeployCanary(configuration, {
      fetchImpl,
      createClientImpl,
      loadLessonImpl: async () => FIRST_SPARK_LESSON,
    }),
    assertCanaryCode("SERVICE_NOT_READY"),
  );
  assert.equal(signedOut, true);
});

test("runPostdeployCanary fails closed on progress drift and still signs out", async () => {
  const configuration = parsePostdeployEnvironment(environment);
  let signedOut = false;
  let compileCalled = false;
  const fetchImpl = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return jsonResponse(statusBody("ok"));
    if (path === "/api/readiness") return jsonResponse(statusBody("ready"));
    if (path === "/api/config") return jsonResponse(runtimeConfigBody());
    if (path === "/api/bootstrap") return jsonResponse(bootstrapBody());
    if (path === "/api/lessons/first-spark/progress") {
      return jsonResponse(progressBody({
        revision: 2,
        status: "not_started",
        currentStep: "meet-the-build",
        percentage: 0,
        codeSnapshot: null,
      }));
    }
    if (path === "/api/compile") compileCalled = true;
    throw new Error("unexpected mocked request");
  };
  const createClientImpl = () => ({
    auth: {
      signInWithPassword: async () => ({
        data: {
          session: { access_token: ACCESS_TOKEN },
          user: {
            id: CANARY_USER_ID,
            email: environment.FIRELIGHT_CANARY_EMAIL,
          },
        },
        error: null,
      }),
      signOut: async ({ scope }) => {
        assert.equal(scope, "global");
        signedOut = true;
        return { error: null };
      },
    },
  });

  await assert.rejects(
    runPostdeployCanary(configuration, {
      fetchImpl,
      createClientImpl,
      loadLessonImpl: async () => FIRST_SPARK_LESSON,
    }),
    assertCanaryCode("INVALID_PROGRESS_RESPONSE"),
  );
  assert.equal(compileCalled, false);
  assert.equal(signedOut, true);
});

test("safe error output exposes only stable codes", () => {
  const secret = "should-never-be-printed";
  assert.equal(safeCanaryErrorCode(new Error(secret)), "CANARY_FAILED");
  assert.equal(safeCanaryErrorCode(new CanaryError("COMPILER_FAILED")), "COMPILER_FAILED");
  assert.equal(safeCanaryErrorCode(new CanaryError(secret)), "CANARY_FAILED");
});
