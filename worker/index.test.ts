import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ProgressUpdateInput } from "../shared/identity";
import { FIRELIGHT_BOARD_FQBN } from "../shared/hardware";
import { findLesson } from "../src/features/lessons/catalog";
import { sha256Hex } from "./compiler-gateway";
import {
  classifyLogMethod,
  classifyLogRoute,
  contentSecurityPolicy,
  createFirelightApp,
} from "./index";
import { hashKitCode } from "./kit-codes";
import { RepositoryError } from "./identity-repository";
import type {
  AccountExportRecords,
  AdminPageInput,
  AuthenticatedUser,
  BootstrapRecords,
  IdentityRepository,
  ProfileRecord,
} from "./identity-repository";

const now = "2026-08-06T12:00:00.000Z";

const user: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "builder@example.com",
  emailConfirmed: true,
  lastSignInAt: new Date().toISOString(),
  sessionId: "55555555-5555-4555-8555-555555555555",
  isAnonymous: false,
};

const profile: ProfileRecord = {
  id: user.id,
  displayName: "Ada",
  role: "learner",
  accessSource: "code",
  accessGrantedAt: now,
  createdAt: now,
  updatedAt: now,
};

const bootstrap: BootstrapRecords = {
  profile,
  activation: {
    id: "22222222-2222-4222-8222-222222222222",
    batch: "pilot-one",
    kind: "code",
    claimedAt: now,
  },
  progress: [
    {
      lessonId: "first-spark",
      lessonVersion: 1,
      revision: 1,
      status: "completed",
      currentStep: "complete",
      percentage: 100,
      codeSnapshot: null,
      completionEvidenceId: null,
      completedAt: now,
      updatedAt: now,
    },
  ],
};

const accountExportRecords: AccountExportRecords = {
  profile,
  activation: bootstrap.activation,
  progress: [
    ...bootstrap.progress,
    {
      ...bootstrap.progress[0]!,
      lessonVersion: 2,
      revision: 3,
      codeSnapshot: "void setup() { pinMode(LED_BUILTIN, OUTPUT); }",
    },
  ],
  compileJobs: [{
    id: "33333333-3333-4333-8333-333333333333",
    lessonId: "first-spark",
    lessonVersion: 2,
    boardTarget: FIRELIGHT_BOARD_FQBN,
    sourceHash: "a".repeat(64),
    state: "succeeded",
    durationMs: 500,
    safeErrorCode: null,
    artifactHash: "b".repeat(64),
    diagnosticSummary: "Compilation completed.",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  }],
  uploadEvidence: [{
    id: "44444444-4444-4444-8444-444444444444",
    compileJobId: "33333333-3333-4333-8333-333333333333",
    lessonId: "first-spark",
    lessonVersion: 2,
    sourceHash: "a".repeat(64),
    artifactHash: "b".repeat(64),
    bytesWritten: 256,
    recordedAt: now,
    attestation: "browser-web-serial-v1",
  }],
};

function makeRepository(overrides: Partial<IdentityRepository> = {}): IdentityRepository {
  return {
    authenticate: vi.fn(async () => user),
    getBootstrap: vi.fn(async () => bootstrap),
    getAccountExport: vi.fn(async () => accountExportRecords),
    updateProfile: vi.fn(async (_userId, displayName) => ({
      ...profile,
      displayName,
    })),
    claimKit: vi.fn(async () => bootstrap.activation!),
    hasActivation: vi.fn(async () => true),
    beginCompileJob: vi.fn(async () => ({
      result: "started" as const,
      jobId: "33333333-3333-4333-8333-333333333333",
    })),
    finishCompileJob: vi.fn(async () => undefined),
    recordUploadEvidence: vi.fn(async (_userId, compileJobId, artifactHash, bytesWritten) => ({
      id: "44444444-4444-4444-8444-444444444444",
      compileJobId,
      lessonId: "first-spark" as const,
      lessonVersion: 1,
      sourceHash: "a".repeat(64),
      artifactHash,
      bytesWritten,
      recordedAt: now,
      attestation: "browser-web-serial-v1" as const,
    })),
    upsertProgress: vi.fn(async (_userId, lessonId, input: ProgressUpdateInput) => ({
      lessonId: lessonId as "first-spark",
      lessonVersion: input.lessonVersion,
      revision: (input.expectedRevision ?? 0) + 1,
      status: input.status,
      currentStep: input.currentStep,
      percentage: input.percentage,
      codeSnapshot: input.codeSnapshot ?? null,
      completionEvidenceId: input.uploadEvidenceId ?? null,
      completedAt: input.status === "completed" ? now : null,
      updatedAt: now,
    })),
    hasRecentSession: vi.fn(async () => true),
    deleteAccount: vi.fn(async () => undefined),
    isAdmin: vi.fn(async () => true),
    createAdminKitBatch: vi.fn(async (_actorId, batch, _codeIds, codeHashes) => ({
      batch,
      count: codeHashes.length,
      createdAt: now,
    })),
    listAdminKits: vi.fn(async (_actorId, _query, _state, page: AdminPageInput) => ({
      items: [],
      ...page,
      nextOffset: null,
    })),
    revokeAdminKit: vi.fn(async (_actorId, kitId) => ({
      id: kitId,
      state: "revoked" as const,
      accessRevoked: true,
    })),
    listAdminLearners: vi.fn(async (_actorId, _query, page: AdminPageInput) => ({
      items: [],
      ...page,
      nextOffset: null,
    })),
    listAdminProgress: vi.fn(async (_actorId, _learnerId, page: AdminPageInput) => ({
      items: [],
      ...page,
      nextOffset: null,
    })),
    listAdminCompileDiagnostics: vi.fn(async (
      _actorId,
      _state,
      _errorCode,
      page: AdminPageInput,
    ) => ({
      items: [],
      ...page,
      nextOffset: null,
    })),
    listAdminAudit: vi.fn(async (_actorId, _action, page: AdminPageInput) => ({
      items: [],
      ...page,
      nextOffset: null,
    })),
    ...overrides,
  };
}

const testEnv = {
  ENVIRONMENT: "development",
  BUILD_ID: "local",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PROJECT_REF: "local",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  KIT_CODE_PEPPER: "firelight-local-kit-pepper",
  COMPILER_SERVICE_URL: "http://127.0.0.1:9000/",
  COMPILER_SERVICE_ORIGIN: "http://127.0.0.1:9000",
  COMPILER_SERVICE_HOST: "127.0.0.1",
  COMPILER_SERVICE_TOKEN:
    "test-service-token-that-is-at-least-thirty-two-characters",
  ASSETS: exports.default,
} as unknown as Env;

function hostedEnv(environment: "staging" | "production", projectRef: string): Env {
  return {
    ...testEnv,
    ENVIRONMENT: environment,
    BUILD_ID: "a".repeat(40),
    SUPABASE_URL: `https://${projectRef}.supabase.co`,
    SUPABASE_PROJECT_REF: projectRef,
    COMPILER_SERVICE_URL:
      "https://firelightcompiler.lambda-url.eu-west-1.on.aws/",
    COMPILER_SERVICE_ORIGIN:
      "https://firelightcompiler.lambda-url.eu-west-1.on.aws",
    COMPILER_SERVICE_HOST: "firelightcompiler.lambda-url.eu-west-1.on.aws",
  } as unknown as Env;
}

function requestWithRepository(
  repository: IdentityRepository,
  path: string,
  init: RequestInit = {},
  compilerFetcher?: (request: Request) => Promise<Response>,
) {
  const app = createFirelightApp({
    createRepository: () => repository,
    ...(compilerFetcher ? { compilerFetcher } : {}),
  });
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", "Bearer valid-token");
  return app.request(`https://firelight.test${path}`, { ...init, headers }, testEnv);
}

const firstSpark = findLesson("first-spark")!;
const validHex = ":100000000C945C000C946E000C946E000C946E00CA\n:00000001FF\n";

function compileRequest(source = firstSpark.starterCode): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lessonId: "first-spark",
      lessonVersion: firstSpark.version,
      fqbn: FIRELIGHT_BOARD_FQBN,
      source,
    }),
  };
}

async function successfulCompiler(request: Request): Promise<Response> {
  const body = await request.clone().json<{
    fqbn: string;
    source: string;
  }>();
  return Response.json({
    ok: true,
    artifact: {
      format: "intel-hex",
      fqbn: body.fqbn,
      sourceHash: await sha256Hex(body.source),
      artifactHash: await sha256Hex(validHex),
      hex: validHex,
    },
    diagnostics: [],
  });
}

const legacyRedirects = [
  ["/index.html", "/"],
  ["/dashboard.html", "/camp"],
  ["/learn.html", "/learn"],
  ["/product.html", "/kit"],
  ["/tutorial.html", "/learn/first-spark"],
  ["/second-tutorial", "/learn/morse-name"],
  ["/second-tutorial/", "/learn/morse-name"],
  ["/second-tutorial/index.html", "/learn/morse-name"],
] as const;

describe("Firelight Worker", () => {
  it("reports liveness without probing secrets and readiness only when configured", async () => {
    const app = createFirelightApp();
    const health = await app.request("https://firelight.test/api/health", {}, testEnv);
    const ready = await app.request("https://firelight.test/api/readiness", {}, testEnv);
    const unavailable = await app.request("https://firelight.test/api/readiness", {}, {
      ...testEnv,
      COMPILER_SERVICE_TOKEN: "",
    });

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      data: { status: "ok", environment: "development", buildId: "local" },
    });
    expect(ready.status).toBe(200);
    expect((await ready.json<{ data: { status: string } }>()).data.status).toBe("ready");
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json<{ error: { code: string } }>()).error.code).toBe(
      "SERVICE_NOT_READY",
    );
  });

  it("pins hosted readiness to the exact build, Supabase project, and compiler host", async () => {
    const app = createFirelightApp();
    const hosted = {
      ...testEnv,
      ENVIRONMENT: "staging",
      BUILD_ID: "a".repeat(40),
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
      COMPILER_SERVICE_URL:
        "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws/",
      COMPILER_SERVICE_ORIGIN:
        "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws",
      COMPILER_SERVICE_HOST:
        "abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws",
    } as unknown as Env;

    const ready = await app.request("https://firelight.test/api/readiness", {}, hosted);
    const wrongProject = await app.request("https://firelight.test/api/readiness", {}, {
      ...hosted,
      SUPABASE_PROJECT_REF: "zyxwvutsrqponmlkjihg",
    });
    const wrongCompiler = await app.request("https://firelight.test/api/readiness", {}, {
      ...hosted,
      COMPILER_SERVICE_HOST: "zyxwvutsrqponmlkjihg.lambda-url.eu-west-1.on.aws",
    });
    const placeholderBuild = await app.request("https://firelight.test/api/readiness", {}, {
      ...hosted,
      BUILD_ID: "staging",
    });

    expect(ready.status).toBe(200);
    expect(wrongProject.status).toBe(503);
    expect(wrongCompiler.status).toBe(503);
    expect(placeholderBuild.status).toBe(503);
  });

  it("returns public runtime configuration in the shared response envelope", async () => {
    const response = await exports.default.fetch("https://firelight.test/api/config");
    const body = await response.json<{
      data: {
        apiVersion: string;
        environment: string;
        supabase: { url: string; publishableKey: string };
        hardware: { fqbn: string; uploadBaud: number };
      };
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(body.data.apiVersion).toBe("v1");
    expect(body.data.environment).toBe("development");
    expect(body.data.supabase).toEqual({
      url: "http://127.0.0.1:54321",
      publishableKey: "test-publishable-key",
    });
    expect(body.data.hardware).toEqual({
      fqbn: "arduino:avr:nano:cpu=atmega328old",
      uploadBaud: 57_600,
    });
  });

  it.each([
    ["staging", "abcdefghijklmnopqrst"],
    ["production", "zyxwvutsrqponmlkjihg"],
  ] as const)(
    "pins %s CSP and HSTS to its exact validated Supabase origin",
    async (environment, projectRef) => {
      const env = hostedEnv(environment, projectRef);
      const app = createFirelightApp();
      const response = await app.request("https://firelight.test/api/health", {}, env);
      const csp = response.headers.get("content-security-policy") ?? "";

      expect(csp).toContain(
        `connect-src 'self' https://${projectRef}.supabase.co wss://${projectRef}.supabase.co`,
      );
      expect(csp).toContain("upgrade-insecure-requests");
      expect(csp).not.toContain("*.supabase.co");
      expect(csp).not.toContain("127.0.0.1");
      expect(csp).not.toContain("localhost");
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
    },
  );

  it("keeps development CSP loopback-only without hosted HSTS or HTTPS upgrades", async () => {
    const app = createFirelightApp();
    const response = await app.request("https://firelight.test/api/health", {}, testEnv);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain(
      "connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321",
    );
    expect(csp).not.toContain("*.supabase.co");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("fails CSP closed when a hosted Supabase origin is not valid", () => {
    const env: Env = {
      ...hostedEnv("production", "zyxwvutsrqponmlkjihg"),
      SUPABASE_URL: "https://attacker.test",
    };
    const csp = contentSecurityPolicy(env);

    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toContain("attacker.test");
    expect(csp).not.toContain("supabase.co");
    expect(csp).not.toContain("127.0.0.1");
  });

  it("fails closed when public identity configuration is missing", async () => {
    const app = createFirelightApp();
    const response = await app.request("https://firelight.test/api/config", {}, {
      ...testEnv,
      SUPABASE_URL: "",
    });
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("IDENTITY_SERVICE_UNAVAILABLE");
  });

  it("requires a bearer session before calling protected repositories", async () => {
    const repository = makeRepository();
    const app = createFirelightApp({ createRepository: () => repository });
    const response = await app.request("https://firelight.test/api/bootstrap", {}, testEnv);
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it("rejects a session that Supabase does not recognize online", async () => {
    const repository = makeRepository({
      authenticate: vi.fn(async () => {
        throw new RepositoryError("unauthorized", "rejected");
      }),
    });
    const response = await requestWithRepository(repository, "/api/bootstrap");
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("SESSION_INVALID");
  });

  it("maps a Supabase request deadline to the stable identity-unavailable error", async () => {
    const repository = makeRepository({
      authenticate: vi.fn(async () => {
        throw new RepositoryError("unavailable", "Supabase request timed out.");
      }),
    });
    const response = await requestWithRepository(repository, "/api/bootstrap");
    const body = await response.json<{ error: { code: string; message: string } }>();

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      code: "IDENTITY_SERVICE_UNAVAILABLE",
      message: "Account services are temporarily unavailable.",
    });
  });

  it("builds bootstrap achievements and the next lesson from synchronized progress", async () => {
    const response = await requestWithRepository(makeRepository(), "/api/bootstrap");
    const body = await response.json<{
      data: {
        profile: { displayName: string; email: string };
        achievements: { id: string; earned: boolean }[];
        nextLesson: { id: string };
      };
    }>();

    expect(response.status).toBe(200);
    expect(body.data.profile).toMatchObject({ displayName: "Ada", email: user.email });
    expect(body.data.achievements).toContainEqual({
      id: "first-upload",
      label: "First Upload",
      earned: true,
    });
    expect(body.data.nextLesson.id).toBe("morse-name");
  });

  it("validates and updates only the signed-in profile", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "  Grace  " }),
    });

    expect(response.status).toBe(200);
    expect(repository.updateProfile).toHaveBeenCalledWith(user.id, "Grace");
  });

  it.each(["Ada\u0000", "Ada\nMallory", "Ada\u007f"])(
    "rejects control characters in profile display names",
    async (displayName) => {
      const repository = makeRepository();
      const response = await requestWithRepository(repository, "/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const body = await response.json<{ error: { code: string } }>();

      expect(response.status).toBe(422);
      expect(body.error.code).toBe("DISPLAY_NAME_INVALID");
      expect(repository.updateProfile).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-site mutation requests before authentication", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/profile", {
      method: "PATCH",
      headers: {
        Origin: "https://attacker.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Mallory" }),
    });
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ORIGIN_REJECTED");
    expect(repository.authenticate).not.toHaveBeenCalled();
  });

  it("normalizes and HMACs a kit code before the atomic repository claim", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/kits/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abcd efgh-jkmp nrst" }),
    });

    expect(response.status).toBe(200);
    expect(repository.claimKit).toHaveBeenCalledWith(
      user.id,
      "159958faa2079365bf52f59e3198e67401517ebd5a5f0eda3fbacef865db5554",
    );
  });

  it("rejects malformed Crockford kit codes without querying stored hashes", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/kits/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "IIII-OOOO-1234-5678" }),
    });
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("KIT_CODE_FORMAT_INVALID");
    expect(repository.claimKit).not.toHaveBeenCalled();
  });

  it("requires activation before saving current-version progress", async () => {
    const repository = makeRepository({ hasActivation: vi.fn(async () => false) });
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: null,
          status: "in_progress",
          currentStep: "meet-the-build",
          percentage: 0,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ACTIVATION_REQUIRED");
    expect(repository.upsertProgress).not.toHaveBeenCalled();
  });

  it("rejects stale lesson versions before writing progress", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 2,
          expectedRevision: null,
          status: "in_progress",
          currentStep: "intro",
          percentage: 20,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("LESSON_VERSION_CHANGED");
    expect(repository.hasActivation).not.toHaveBeenCalled();
  });

  it("upserts validated progress idempotently for the authenticated learner", async () => {
    const repository = makeRepository();
    const input = {
      lessonVersion: 1,
      expectedRevision: null,
      status: "completed",
      currentStep: "finish-lesson",
      percentage: 100,
      codeSnapshot: "void setup() {}",
      uploadEvidenceId: "44444444-4444-4444-8444-444444444444",
    } as const;
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    expect(response.status).toBe(200);
    expect(repository.upsertProgress).toHaveBeenCalledWith(user.id, "first-spark", input);
  });

  it("fails a progress revocation race with the activation contract", async () => {
    const repository = makeRepository({
      upsertProgress: vi.fn(async () => {
        throw new RepositoryError("forbidden", "Kit access is no longer active.");
      }),
    });
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: null,
          status: "in_progress",
          currentStep: "meet-the-build",
          percentage: 0,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "ACTIVATION_REQUIRED",
    );
  });

  it("requires upload evidence and the uploaded sketch for terminal progress", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: 4,
          status: "completed",
          currentStep: "finish-lesson",
          percentage: 100,
          codeSnapshot: firstSpark.starterCode,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("UPLOAD_EVIDENCE_REQUIRED");
    expect(repository.upsertProgress).not.toHaveBeenCalled();
  });

  it("requires an optimistic revision on every progress mutation", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          status: "in_progress",
          currentStep: "intro",
          percentage: 10,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("PROGRESS_REVISION_INVALID");
    expect(repository.upsertProgress).not.toHaveBeenCalled();
  });

  it("reports a stable conflict code when another device wins a progress save", async () => {
    const repository = makeRepository({
      upsertProgress: vi.fn(async () => {
        throw new RepositoryError("conflict", "revision changed");
      }),
    });
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: 3,
          status: "in_progress",
          currentStep: "edit-code",
          percentage: 20,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("PROGRESS_REVISION_CONFLICT");
  });

  it("rejects checkpoints that are not part of the requested lesson version", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: null,
          status: "in_progress",
          currentStep: "invented-checkpoint",
          percentage: 0,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("CURRENT_STEP_INVALID");
    expect(repository.hasActivation).not.toHaveBeenCalled();
    expect(repository.upsertProgress).not.toHaveBeenCalled();
  });

  it("rejects percentages that do not match the requested checkpoint", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: null,
          status: "in_progress",
          currentStep: "edit-code",
          percentage: 99,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("PROGRESS_PERCENTAGE_INVALID");
    expect(repository.upsertProgress).not.toHaveBeenCalled();
  });

  it("accepts an older saved percentage that remains within its checkpoint range", async () => {
    const repository = makeRepository();
    const input = {
      lessonVersion: 1,
      expectedRevision: 7,
      status: "in_progress",
      currentStep: "edit-code",
      percentage: 18,
    } as const;
    const response = await requestWithRepository(
      repository,
      "/api/lessons/first-spark/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    expect(response.status).toBe(200);
    expect(repository.upsertProgress).toHaveBeenCalledWith(user.id, "first-spark", input);
  });

  it("refuses to save a locked lesson until current-version prerequisites are complete", async () => {
    const repository = makeRepository({
      getBootstrap: vi.fn(async () => ({ ...bootstrap, progress: [] })),
    });
    const response = await requestWithRepository(
      repository,
      "/api/lessons/morse-name/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonVersion: 1,
          expectedRevision: null,
          status: "in_progress",
          currentStep: "meet-the-build",
          percentage: 0,
        }),
      },
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("LESSON_PREREQUISITE_REQUIRED");
    expect(repository.getBootstrap).toHaveBeenCalledWith(user.id);
    expect(repository.upsertProgress).not.toHaveBeenCalled();
  });

  it("accepts a lesson checkpoint after its current-version prerequisite is complete", async () => {
    const repository = makeRepository();
    const input = {
      lessonVersion: 1,
      expectedRevision: null,
      status: "in_progress",
      currentStep: "meet-the-build",
      percentage: 0,
    } as const;
    const response = await requestWithRepository(
      repository,
      "/api/lessons/morse-name/progress",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    expect(response.status).toBe(200);
    expect(repository.upsertProgress).toHaveBeenCalledWith(user.id, "morse-name", input);
  });

  it("compiles a validated allowlisted sketch and records only its hashes", async () => {
    const repository = makeRepository();
    const compiler = vi.fn(successfulCompiler);
    const response = await requestWithRepository(
      repository,
      "/api/compile",
      compileRequest(),
      compiler,
    );
    const body = await response.json<{
      data: {
        compileJobId: string;
        fqbn: string;
        sourceHash: string;
        artifactHash: string;
        hex: string;
      };
    }>();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      compileJobId: "33333333-3333-4333-8333-333333333333",
      fqbn: FIRELIGHT_BOARD_FQBN,
      hex: validHex,
    });
    expect(body.data).not.toHaveProperty("source");
    expect(JSON.stringify(body)).not.toContain(testEnv.COMPILER_SERVICE_URL);
    expect(repository.beginCompileJob).toHaveBeenCalledWith(user.id, {
      lessonId: "first-spark",
      lessonVersion: 1,
      sourceHash: body.data.sourceHash,
    });
    expect(repository.finishCompileJob).toHaveBeenCalledWith(
      user.id,
      expect.objectContaining({
        jobId: body.data.compileJobId,
        state: "succeeded",
        artifactHash: body.data.artifactHash,
      }),
    );
    expect(compiler).toHaveBeenCalledOnce();
  });

  it("rejects anonymous or unconfirmed sessions before creating compile work", async () => {
    const repository = makeRepository({
      authenticate: vi.fn(async () => ({ ...user, isAnonymous: true })),
    });
    const compiler = vi.fn(successfulCompiler);
    const response = await requestWithRepository(
      repository,
      "/api/compile",
      compileRequest(),
      compiler,
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("NON_ANONYMOUS_ACCOUNT_REQUIRED");
    expect(repository.beginCompileJob).not.toHaveBeenCalled();
    expect(compiler).not.toHaveBeenCalled();
  });

  it("does not return an artifact when access is revoked before compile commit", async () => {
    const finishCompileJob = vi.fn(async () => {
      throw new RepositoryError("forbidden", "Kit access is no longer active.");
    });
    const repository = makeRepository({ finishCompileJob });
    const response = await requestWithRepository(
      repository,
      "/api/compile",
      compileRequest(),
      vi.fn(successfulCompiler),
    );
    const body = await response.json<{ data?: unknown; error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ACTIVATION_REQUIRED");
    expect(body.data).toBeUndefined();
    expect(finishCompileJob).toHaveBeenCalledOnce();
  });

  it("enforces the exact Nano target and 64 KiB source limit before job creation", async () => {
    const repository = makeRepository();
    const wrongTarget = compileRequest();
    if (typeof wrongTarget.body !== "string") throw new TypeError("Expected JSON body.");
    const wrongBody = JSON.parse(wrongTarget.body) as Record<string, unknown>;
    wrongBody.fqbn = "arduino:avr:uno";
    const wrongBoardResponse = await requestWithRepository(repository, "/api/compile", {
      ...wrongTarget,
      body: JSON.stringify(wrongBody),
    });
    const wrongBoardError = await wrongBoardResponse.json<{ error: { code: string } }>();
    expect(wrongBoardResponse.status).toBe(422);
    expect(wrongBoardError.error.code).toBe("BOARD_TARGET_UNSUPPORTED");

    const oversizedResponse = await requestWithRepository(
      repository,
      "/api/compile",
      compileRequest(`${firstSpark.starterCode}\n/*${"x".repeat(65_536)}*/`),
    );
    const oversizedError = await oversizedResponse.json<{ error: { code: string } }>();
    expect(oversizedResponse.status).toBe(413);
    expect(oversizedError.error.code).toBe("SKETCH_TOO_LARGE");
    expect(repository.beginCompileJob).not.toHaveBeenCalled();
  });

  it("maps atomic active and rolling rate gates without calling the compiler", async () => {
    const compiler = vi.fn(successfulCompiler);
    const activeRepository = makeRepository({
      beginCompileJob: vi.fn(async () => ({ result: "active" as const })),
    });
    const active = await requestWithRepository(
      activeRepository,
      "/api/compile",
      compileRequest(),
      compiler,
    );
    expect(active.status).toBe(409);
    expect((await active.json<{ error: { code: string } }>()).error.code).toBe(
      "COMPILE_ALREADY_RUNNING",
    );

    const limitedRepository = makeRepository({
      beginCompileJob: vi.fn(async () => ({
        result: "rate_limited" as const,
        scope: "hour" as const,
        retryAfterSeconds: 3600,
      })),
    });
    const limited = await requestWithRepository(
      limitedRepository,
      "/api/compile",
      compileRequest(),
      compiler,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3600");
    expect(compiler).not.toHaveBeenCalled();
  });

  it("records upload success only against the authenticated learner's artifact", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(
      repository,
      "/api/hardware/upload-evidence",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compileJobId: "33333333-3333-4333-8333-333333333333",
          artifactHash: "b".repeat(64),
          bytesWritten: 256,
        }),
      },
    );
    const body = await response.json<{ data: { id: string; attestation: string } }>();

    expect(response.status).toBe(200);
    expect(body.data.attestation).toBe("browser-web-serial-v1");
    expect(repository.recordUploadEvidence).toHaveBeenCalledWith(
      user.id,
      "33333333-3333-4333-8333-333333333333",
      "b".repeat(64),
      256,
    );

    const oversized = await requestWithRepository(
      repository,
      "/api/hardware/upload-evidence",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compileJobId: "33333333-3333-4333-8333-333333333333",
          artifactHash: "b".repeat(64),
          bytesWritten: 30_721,
        }),
      },
    );
    const oversizedBody = await oversized.json<{ error: { code: string } }>();
    expect(oversized.status).toBe(422);
    expect(oversizedBody.error.code).toBe("UPLOAD_SIZE_INVALID");
    expect(repository.recordUploadEvidence).toHaveBeenCalledOnce();
  });

  it("fails an upload-evidence revocation race with the activation contract", async () => {
    const repository = makeRepository({
      recordUploadEvidence: vi.fn(async () => {
        throw new RepositoryError("forbidden", "Kit access is no longer active.");
      }),
    });
    const response = await requestWithRepository(
      repository,
      "/api/hardware/upload-evidence",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compileJobId: "33333333-3333-4333-8333-333333333333",
          artifactHash: "b".repeat(64),
          bytesWritten: 256,
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "ACTIVATION_REQUIRED",
    );
  });

  it("exports the authenticated owner's complete versioned server snapshot", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/account/export");
    const body = await response.json<{ data: Record<string, unknown> }>();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      schema: "firelight.account-export",
      version: 2,
      exportedAt: expect.any(String),
      data: {
        profile: { id: user.id, email: user.email },
        activation: { id: bootstrap.activation!.id, batch: "pilot-one" },
        progress: [
          { lessonId: "first-spark", lessonVersion: 1 },
          { lessonId: "first-spark", lessonVersion: 2 },
        ],
        compileJobs: [{ id: "33333333-3333-4333-8333-333333333333" }],
        uploadEvidence: [{ id: "44444444-4444-4444-8444-444444444444" }],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/codeHash|code_hash|serviceRole|hex/i);
    expect(repository.getAccountExport).toHaveBeenCalledWith(user.id);
  });

  it("fails a bounded export explicitly and guards non-GET methods", async () => {
    const repository = makeRepository({
      getAccountExport: vi.fn(async () => {
        throw new RepositoryError("export_too_large", "bounded");
      }),
    });
    const oversized = await requestWithRepository(repository, "/api/account/export");
    expect(oversized.status).toBe(409);
    expect((await oversized.json<{ error: { code: string } }>()).error.code).toBe(
      "ACCOUNT_EXPORT_TOO_LARGE",
    );

    const wrongMethod = await requestWithRepository(repository, "/api/account/export", {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("fails the whole export when valid projected records exceed the JSON response bound", async () => {
    const template = accountExportRecords.compileJobs[0]!;
    const compileJobs = Array.from({ length: 520 }, (_, index) => ({
      ...template,
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      diagnosticSummary: "x".repeat(8_192),
    }));
    const repository = makeRepository({
      getAccountExport: vi.fn(async () => ({
        ...accountExportRecords,
        compileJobs,
      })),
    });

    const response = await requestWithRepository(repository, "/api/account/export");
    expect(response.status).toBe(409);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "ACCOUNT_EXPORT_TOO_LARGE",
    );
  });

  it("requires a recent online sign-in before account deletion", async () => {
    const repository = makeRepository({
      hasRecentSession: vi.fn(async () => false),
    });
    const response = await requestWithRepository(repository, "/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("RECENT_SIGN_IN_REQUIRED");
    expect(repository.hasRecentSession).toHaveBeenCalledWith(user.id, user.sessionId);
    expect(repository.deleteAccount).not.toHaveBeenCalled();
  });

  it("rejects account deletion without an exact explicit confirmation", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "delete" }),
    });

    expect(response.status).toBe(422);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "ACCOUNT_DELETE_CONFIRMATION_REQUIRED",
    );
    expect(repository.hasRecentSession).not.toHaveBeenCalled();
    expect(repository.deleteAccount).not.toHaveBeenCalled();
  });

  it("rejects deletion from a token without an authenticated session id", async () => {
    const repository = makeRepository({
      authenticate: vi.fn(async () => ({ ...user, sessionId: null })),
    });
    const response = await requestWithRepository(repository, "/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });

    expect(response.status).toBe(403);
    expect(repository.hasRecentSession).not.toHaveBeenCalled();
    expect(repository.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes the recently authenticated account through the server boundary", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });

    expect(response.status).toBe(200);
    expect(repository.deleteAccount).toHaveBeenCalledWith(user.id);
  });

  it("denies support APIs to normal learners before privileged repository calls", async () => {
    const listAdminKits = vi.fn(async (
      _actorId: string,
      _query: string,
      _state: "issued" | "claimed" | "revoked" | null,
      page: AdminPageInput,
    ) => ({ items: [], ...page, nextOffset: null }));
    const repository = makeRepository({
      isAdmin: vi.fn(async () => false),
      listAdminKits,
    });
    const response = await requestWithRepository(repository, "/api/admin/kits");
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ADMIN_REQUIRED");
    expect(listAdminKits).not.toHaveBeenCalled();
  });

  it("pairs one-time kit codes with revocation IDs while sending only HMACs to storage", async () => {
    let receivedIds: readonly string[] = [];
    let receivedHashes: readonly string[] = [];
    const createAdminKitBatch = vi.fn(async (
      _actorId: string,
      batch: string,
      codeIds: readonly string[],
      codeHashes: readonly string[],
    ) => {
      receivedIds = [...codeIds];
      receivedHashes = [...codeHashes];
      return { batch, count: codeHashes.length, createdAt: now };
    });
    const repository = makeRepository({ createAdminKitBatch });
    const response = await requestWithRepository(
      repository,
      "/api/admin/kits/batches",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch: "autumn-pilot", count: 3 }),
      },
    );
    const body = await response.json<{
      data: { batch: string; codes: { id: string; code: string }[]; generatedAt: string };
    }>();

    expect(response.status).toBe(200);
    expect(body.data.batch).toBe("autumn-pilot");
    expect(body.data.generatedAt).toBe(now);
    expect(body.data.codes).toHaveLength(3);
    expect(new Set(body.data.codes.map((entry) => entry.id)).size).toBe(3);
    expect(new Set(body.data.codes.map((entry) => entry.code)).size).toBe(3);
    expect(body.data.codes.every((entry) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.id) &&
      /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(entry.code)
    )).toBe(true);

    const canonicalCodes = body.data.codes.map((entry) => entry.code.replaceAll("-", ""));
    const expectedHashes = await Promise.all(
      canonicalCodes.map((code) => hashKitCode(code, testEnv.KIT_CODE_PEPPER)),
    );
    expect(receivedHashes).toEqual(expectedHashes);
    expect(receivedHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(receivedHashes.some((hash) => canonicalCodes.includes(hash))).toBe(false);
    expect(receivedIds).toEqual(body.data.codes.map((entry) => entry.id));
    expect(createAdminKitBatch).toHaveBeenCalledWith(
      user.id,
      "autumn-pilot",
      receivedIds,
      expectedHashes,
    );
  });

  it("passes bounded kit filters and pagination through the safe admin projection", async () => {
    const listAdminKits = vi.fn(async (
      _actorId: string,
      _query: string,
      _state: "issued" | "claimed" | "revoked" | null,
      page: AdminPageInput,
    ) => ({
      items: [{
        id: "44444444-4444-4444-8444-444444444444",
        batch: "pilot-a",
        state: "claimed" as const,
        claimedBy: user.id,
        claimedAt: now,
        revokedAt: null,
        createdAt: now,
      }],
      ...page,
      nextOffset: 30,
    }));
    const repository = makeRepository({ listAdminKits });
    const response = await requestWithRepository(
      repository,
      "/api/admin/kits?q=Ada&state=claimed&limit=10&offset=20",
    );
    const body = await response.json<{ data: { items: unknown[]; nextOffset: number } }>();

    expect(response.status).toBe(200);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.nextOffset).toBe(30);
    expect(listAdminKits).toHaveBeenCalledWith(
      user.id,
      "Ada",
      "claimed",
      { limit: 10, offset: 20 },
    );
  });

  it("atomically revokes a kit through the audited admin boundary", async () => {
    const kitId = "44444444-4444-4444-8444-444444444444";
    const revokeAdminKit = vi.fn(async (
      _actorId: string,
      id: string,
    ) => ({ id, state: "revoked" as const, accessRevoked: true }));
    const repository = makeRepository({ revokeAdminKit });
    const response = await requestWithRepository(
      repository,
      `/api/admin/kits/${kitId}/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "security" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { id: kitId, state: "revoked", accessRevoked: true },
    });
    expect(revokeAdminKit).toHaveBeenCalledWith(user.id, kitId, "security");
  });

  it("returns exact learner support context without exposing code snapshots", async () => {
    const learnerId = "66666666-6666-4666-8666-666666666666";
    const learner = {
      id: learnerId,
      email: "grace@example.com",
      displayName: "Grace",
      role: "learner" as const,
      accessSource: "code" as const,
      activationBatch: "pilot-a",
      completedLessons: 1,
      progressRecords: 1,
      createdAt: now,
      updatedAt: now,
    };
    const listAdminLearners = vi.fn(async (
      _actorId: string,
      _query: string,
      page: AdminPageInput,
    ) => ({ items: [learner], ...page, nextOffset: null }));
    const listAdminProgress = vi.fn(async (
      _actorId: string,
      _learnerId: string,
      page: AdminPageInput,
    ) => ({
      items: [{
        lessonId: "first-spark" as const,
        lessonVersion: 1,
        status: "completed" as const,
        currentStep: "complete",
        percentage: 100,
        completedAt: now,
        updatedAt: now,
      }],
      ...page,
      nextOffset: null,
    }));
    const repository = makeRepository({ listAdminLearners, listAdminProgress });
    const response = await requestWithRepository(
      repository,
      `/api/admin/learners/${learnerId}/progress?limit=10&offset=0`,
    );
    const body = await response.json<{
      data: { learner: { id: string }; progress: { items: Record<string, unknown>[] } };
    }>();

    expect(response.status).toBe(200);
    expect(body.data.learner.id).toBe(learnerId);
    expect(body.data.progress.items[0]).not.toHaveProperty("codeSnapshot");
    expect(listAdminLearners).toHaveBeenCalledWith(
      user.id,
      learnerId,
      { limit: 1, offset: 0 },
    );
    expect(listAdminProgress).toHaveBeenCalledWith(
      user.id,
      learnerId,
      { limit: 10, offset: 0 },
    );
  });

  it.each([
    {
      path: "/api/admin/kits?limit=51",
      init: undefined,
      code: "PAGINATION_INVALID",
    },
    {
      path: "/api/admin/kits?q=one&q=two",
      init: undefined,
      code: "QUERY_INVALID",
    },
    {
      path: "/api/admin/compile-diagnostics?errorCode=compiler_failed",
      init: undefined,
      code: "COMPILE_ERROR_CODE_INVALID",
    },
    {
      path: "/api/admin/kits/batches",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch: "pilot", count: 101 }),
      },
      code: "KIT_BATCH_COUNT_INVALID",
    },
  ])("rejects malformed admin input with $code", async ({ path, init, code }) => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, path, init);
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe(code);
  });

  it("logs only the closed route template for parameterized requests", async () => {
    const learnerId = "66666666-6666-4666-8666-666666666666";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await requestWithRepository(
        makeRepository(),
        `/api/admin/learners/${learnerId}/progress`,
      );
      expect(response.status).toBe(404);
      const structured = log.mock.calls
        .map(([entry]) => typeof entry === "string" ? entry : "")
        .find((entry) => entry.includes('"event":"request.complete"'));
      expect(structured).toContain('"route":"api.admin_learner_progress"');
      expect(structured).not.toContain('"path"');
      expect(structured).not.toContain(learnerId);
    } finally {
      log.mockRestore();
    }
  });

  it("classifies arbitrary plain, encoded, kit, token, and control paths as constants", async () => {
    const attackerInputs = [
      "/api/unknown/builder@example.test",
      "/api/unknown/builder%40example.test",
      "/api/unknown/ABCD-EFGH-JKMP-NRST",
      "/api/unknown/eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "/api/unknown/%0Aforged-log-entry",
      "/builder@example.test",
    ];
    expect(attackerInputs.map(classifyLogRoute)).toEqual([
      "api.unknown",
      "api.unknown",
      "api.unknown",
      "api.unknown",
      "api.unknown",
      "asset_or_spa",
    ]);
    expect(classifyLogMethod("builder@example.test")).toBe("OTHER");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const path of attackerInputs) {
        await requestWithRepository(makeRepository(), path);
      }
      const serializedLogs = log.mock.calls
        .map((call) => typeof call[0] === "string" ? call[0] : "")
        .join("\n");
      for (const sensitive of [
        "builder@example.test",
        "builder%40example.test",
        "ABCD-EFGH-JKMP-NRST",
        "eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "%0Aforged-log-entry",
        "forged-log-entry",
      ]) {
        expect(serializedLogs).not.toContain(sensitive);
      }
      expect(serializedLogs).not.toContain('"path"');
      expect(serializedLogs).toContain('"route":"api.unknown"');
      expect(serializedLogs).toContain('"route":"asset_or_spa"');
    } finally {
      log.mockRestore();
    }
  });

  it("never writes attacker-controlled repository or exception data to error logs", async () => {
    const sensitive = "builder@example.test-ABCD-EFGH-JKMP-NRST-token";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const repositoryFailure = await requestWithRepository(
        makeRepository({
          getBootstrap: vi.fn(async () => {
            throw new RepositoryError("unavailable", sensitive, sensitive);
          }),
        }),
        "/api/bootstrap",
      );
      expect(repositoryFailure.status).toBe(503);

      const unexpected = new Error("safe response must not echo this");
      unexpected.name = sensitive;
      const unexpectedFailure = await requestWithRepository(
        makeRepository({
          getBootstrap: vi.fn(async () => {
            throw unexpected;
          }),
        }),
        "/api/bootstrap",
      );
      expect(unexpectedFailure.status).toBe(500);

      const serializedLogs = [...log.mock.calls, ...errorLog.mock.calls]
        .map((call) => typeof call[0] === "string" ? call[0] : "")
        .join("\n");
      expect(serializedLogs).not.toContain(sensitive);
      expect(serializedLogs).not.toContain("builder@example.test");
      expect(serializedLogs).not.toContain("ABCD-EFGH-JKMP-NRST");
      expect(serializedLogs).not.toContain('"path"');
      expect(serializedLogs).toContain('"route":"api.bootstrap"');
      expect(serializedLogs).toContain('"failureCategory":"unexpected"');
    } finally {
      errorLog.mockRestore();
      log.mockRestore();
    }
  });

  it.each(["/api", "/api/unknown"])(
    "returns a non-cacheable structured error for %s",
    async (path) => {
      const response = await exports.default.fetch(`https://firelight.test${path}`);
      const body = await response.json<{
        error: { code: string; message: string; requestId: string };
      }>();

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
    },
  );

  it("advertises every supported config method on a non-cacheable 405", async () => {
    const response = await exports.default.fetch("https://firelight.test/api/config", {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(legacyRedirects)("redirects %s to %s", async (legacyPath, destination) => {
    const response = await exports.default.fetch(`https://firelight.test${legacyPath}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://firelight.test${destination}`);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves SPA navigation through the static asset binding with security headers", async () => {
    const response = await exports.default.fetch("https://firelight.test/learn/first-spark", {
      headers: {
        "Sec-Fetch-Mode": "navigate",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321",
    );
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});
