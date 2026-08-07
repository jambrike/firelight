import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ProgressUpdateInput } from "../shared/identity";
import { createFirelightApp } from "./index";
import { RepositoryError } from "./identity-repository";
import type {
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
      completedAt: now,
      updatedAt: now,
    },
  ],
};

function makeRepository(overrides: Partial<IdentityRepository> = {}): IdentityRepository {
  return {
    authenticate: vi.fn(async () => user),
    getBootstrap: vi.fn(async () => bootstrap),
    updateProfile: vi.fn(async (_userId, displayName) => ({
      ...profile,
      displayName,
    })),
    claimKit: vi.fn(async () => bootstrap.activation!),
    hasActivation: vi.fn(async () => true),
    upsertProgress: vi.fn(async (_userId, lessonId, input: ProgressUpdateInput) => ({
      lessonId: lessonId as "first-spark",
      lessonVersion: input.lessonVersion,
      revision: (input.expectedRevision ?? 0) + 1,
      status: input.status,
      currentStep: input.currentStep,
      percentage: input.percentage,
      codeSnapshot: input.codeSnapshot ?? null,
      completedAt: input.status === "completed" ? now : null,
      updatedAt: now,
    })),
    deleteAccount: vi.fn(async () => undefined),
    ...overrides,
  };
}

const testEnv: Env = {
  ENVIRONMENT: "development",
  BUILD_ID: "local",
  SUPABASE_URL: "https://supabase.firelight.test",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  KIT_CODE_PEPPER: "firelight-local-kit-pepper",
  ASSETS: exports.default,
};

function requestWithRepository(
  repository: IdentityRepository,
  path: string,
  init: RequestInit = {},
) {
  const app = createFirelightApp({ createRepository: () => repository });
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", "Bearer valid-token");
  return app.request(`https://firelight.test${path}`, { ...init, headers }, testEnv);
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
      url: "https://supabase.firelight.test",
      publishableKey: "test-publishable-key",
    });
    expect(body.data.hardware).toEqual({
      fqbn: "arduino:avr:nano:cpu=atmega328old",
      uploadBaud: 57_600,
    });
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

  it("keeps compile as an authenticated, activated not-ready boundary", async () => {
    const response = await requestWithRepository(makeRepository(), "/api/compile", {
      method: "POST",
    });
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("COMPILER_NOT_READY");
  });

  it("requires a recent online sign-in before account deletion", async () => {
    const repository = makeRepository({
      authenticate: vi.fn(async () => ({
        ...user,
        lastSignInAt: "2026-01-01T00:00:00.000Z",
      })),
    });
    const response = await requestWithRepository(repository, "/api/account", {
      method: "DELETE",
    });
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("RECENT_SIGN_IN_REQUIRED");
    expect(repository.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes the recently authenticated account through the server boundary", async () => {
    const repository = makeRepository();
    const response = await requestWithRepository(repository, "/api/account", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(repository.deleteAccount).toHaveBeenCalledWith(user.id);
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
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
