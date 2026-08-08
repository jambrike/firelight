import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ProgressUpdateInput } from "../shared/identity";
import { createSupabaseIdentityRepository } from "./identity-repository";
import type { RepositoryError, RepositoryFetcher } from "./identity-repository";

const userId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-07T12:00:00.000Z";
const repositoryEnv = {
  ENVIRONMENT: "development",
  BUILD_ID: "local",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  KIT_CODE_PEPPER: "firelight-local-kit-pepper",
  COMPILER_SERVICE_URL: "http://127.0.0.1:9000/",
  COMPILER_SERVICE_ORIGIN: "http://127.0.0.1:9000",
  COMPILER_SERVICE_TOKEN:
    "test-service-token-that-is-at-least-thirty-two-characters",
  ASSETS: exports.default,
} as unknown as Env;

function progressRow(revision: number) {
  return {
    lesson_id: "first-spark",
    lesson_version: 1,
    revision,
    status: "in_progress",
    current_step: "edit-code",
    percentage: 20,
    code_snapshot: "void setup() {}",
    completion_evidence_id: null,
    completed_at: null,
    updated_at: now,
  };
}

function update(expectedRevision: number | null): ProgressUpdateInput {
  return {
    lessonVersion: 1,
    expectedRevision,
    status: "in_progress",
    currentStep: "edit-code",
    percentage: 20,
    codeSnapshot: "void setup() {}",
  };
}

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") throw new TypeError("Expected a JSON request body.");
  return JSON.parse(body) as Record<string, unknown>;
}

describe("Supabase progress repository", () => {
  it("creates revision one for a first checkpoint", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return Response.json([progressRow(1)]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    const saved = await repository.upsertProgress(
      userId,
      "first-spark",
      update(null),
    );

    expect(saved.revision).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.method).toBe("POST");
    expect(parseRequestBody(requests[0]?.init.body)).toMatchObject({
      user_id: userId,
      lesson_id: "first-spark",
      revision: 1,
    });
  });

  it("filters a later update by the expected revision and advances exactly once", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return Response.json([progressRow(8)]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    const saved = await repository.upsertProgress(
      userId,
      "first-spark",
      update(7),
    );

    expect(saved.revision).toBe(8);
    expect(requests[0]?.init.method).toBe("PATCH");
    expect(requests[0]?.url.searchParams.get("revision")).toBe("eq.7");
    expect(parseRequestBody(requests[0]?.init.body)).toMatchObject({ revision: 8 });
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer learner-token");
  });

  it("turns an empty conditional update into a revision conflict", async () => {
    const fetcher: RepositoryFetcher = vi.fn(async () => Response.json([]));
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(
      repository.upsertProgress(userId, "first-spark", update(7)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RepositoryError>>({ kind: "conflict" }),
    );
  });

  it("recognizes an exact first-write replay after a committed response is lost", async () => {
    let call = 0;
    const fetcher: RepositoryFetcher = vi.fn(async () => {
      call += 1;
      return call === 1
        ? Response.json({ code: "23505", message: "duplicate" }, { status: 409 })
        : Response.json([progressRow(1)]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(
      repository.upsertProgress(userId, "first-spark", update(null)),
    ).resolves.toMatchObject({
      lessonId: "first-spark",
      revision: 1,
      currentStep: "edit-code",
      codeSnapshot: "void setup() {}",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("recognizes an exact conditional-update replay after a committed response is lost", async () => {
    let call = 0;
    const fetcher: RepositoryFetcher = vi.fn(async () => {
      call += 1;
      return Response.json(call === 1 ? [] : [progressRow(8)]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(
      repository.upsertProgress(userId, "first-spark", update(7)),
    ).resolves.toMatchObject({
      lessonId: "first-spark",
      revision: 8,
      currentStep: "edit-code",
      codeSnapshot: "void setup() {}",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a different same-revision checkpoint for a replay", async () => {
    let call = 0;
    const fetcher: RepositoryFetcher = vi.fn(async () => {
      call += 1;
      return Response.json(call === 1 ? [] : [{
        ...progressRow(8),
        current_step: "different-step",
      }]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(
      repository.upsertProgress(userId, "first-spark", update(7)),
    ).rejects.toMatchObject({ kind: "conflict" });
  });
});

describe("Supabase hardware lifecycle repository", () => {
  it("requires a live claimed code row instead of trusting the profile flag", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return requests.length === 1
        ? Response.json([{ access_source: "code" }])
        : Response.json([]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(repository.hasActivation(userId)).resolves.toBe(false);
    expect(requests[1]?.url.searchParams.get("kind")).toBe("eq.code");
    expect(requests[1]?.url.searchParams.get("state")).toBe("eq.claimed");
    expect(requests[1]?.url.searchParams.get("revoked_at")).toBe("is.null");
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe(
      "Bearer test-service-role-key",
    );
  });

  it("accepts a profile code flag only with one live claimed kit", async () => {
    let requestCount = 0;
    const fetcher: RepositoryFetcher = vi.fn(async () => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json([{ access_source: "code" }])
        : Response.json([{ id: "22222222-2222-4222-8222-222222222222" }]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(repository.hasActivation(userId)).resolves.toBe(true);
  });

  it("uses the service-only atomic gate and parses rolling rate limits", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return Response.json({
        result: "rate_limited",
        scope: "hour",
        retryAfterSeconds: 3600,
      });
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(
      repository.beginCompileJob(userId, {
        lessonId: "first-spark",
        lessonVersion: 1,
        sourceHash: "a".repeat(64),
      }),
    ).resolves.toEqual({
      result: "rate_limited",
      scope: "hour",
      retryAfterSeconds: 3600,
    });

    expect(requests[0]?.url.pathname).toBe("/rest/v1/rpc/firelight_begin_compile_job");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer test-service-role-key",
    );
    expect(parseRequestBody(requests[0]?.init.body)).toMatchObject({
      p_user_id: userId,
      p_lesson_id: "first-spark",
      p_lesson_version: 1,
      p_source_hash: "a".repeat(64),
      p_board_target: "arduino:avr:nano:cpu=atmega328old",
    });
  });

  it("finishes a compile and records typed browser upload evidence", async () => {
    const compileJobId = "33333333-3333-4333-8333-333333333333";
    const evidenceId = "44444444-4444-4444-8444-444444444444";
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      if (url.pathname.endsWith("firelight_finish_compile_job")) {
        return Response.json({ result: "finished", jobId: compileJobId });
      }
      return Response.json({
        result: "recorded",
        evidence: {
          id: evidenceId,
          compileJobId,
          lessonId: "first-spark",
          lessonVersion: 1,
          sourceHash: "a".repeat(64),
          artifactHash: "b".repeat(64),
          bytesWritten: 256,
          recordedAt: now,
          attestation: "browser-web-serial-v1",
        },
      });
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await repository.finishCompileJob(userId, {
      jobId: compileJobId,
      state: "succeeded",
      durationMs: 500,
      safeErrorCode: null,
      artifactHash: "b".repeat(64),
      diagnosticSummary: "Compilation completed.",
    });
    await expect(
      repository.recordUploadEvidence(userId, compileJobId, "b".repeat(64), 256),
    ).resolves.toEqual({
      id: evidenceId,
      compileJobId,
      lessonId: "first-spark",
      lessonVersion: 1,
      sourceHash: "a".repeat(64),
      artifactHash: "b".repeat(64),
      bytesWritten: 256,
      recordedAt: now,
      attestation: "browser-web-serial-v1",
    });

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/rest/v1/rpc/firelight_finish_compile_job",
      "/rest/v1/rpc/firelight_record_upload_evidence",
    ]);
  });

  it("maps revocation races at finish and evidence recording to forbidden", async () => {
    const compileJobId = "33333333-3333-4333-8333-333333333333";
    const fetcher: RepositoryFetcher = vi.fn(async () =>
      Response.json({ result: "not_entitled" }),
    );
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(repository.finishCompileJob(userId, {
      jobId: compileJobId,
      state: "succeeded",
      durationMs: 500,
      safeErrorCode: null,
      artifactHash: "b".repeat(64),
      diagnosticSummary: "Compilation completed.",
    })).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      repository.recordUploadEvidence(userId, compileJobId, "b".repeat(64), 256),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it.each([
    ["evidence UUID version", { id: "44444444-4444-1444-8444-444444444444" }],
    ["compile UUID version", { compileJobId: "33333333-3333-1333-8333-333333333333" }],
    ["compile job", { compileJobId: "55555555-5555-4555-8555-555555555555" }],
    ["artifact hash", { artifactHash: "c".repeat(64) }],
    ["byte count", { bytesWritten: 255 }],
    ["lesson version", { lessonVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ["source hash", { sourceHash: "A".repeat(64) }],
    ["timestamp", { recordedAt: "2026-02-30T12:00:00Z" }],
    ["attestation", { attestation: "device-proof" }],
  ])("rejects upload evidence whose %s response field is untrusted", async (_field, override) => {
    const compileJobId = "33333333-3333-4333-8333-333333333333";
    const fetcher: RepositoryFetcher = vi.fn(async () =>
      Response.json({
        result: "recorded",
        evidence: {
          id: "44444444-4444-4444-8444-444444444444",
          compileJobId,
          lessonId: "first-spark",
          lessonVersion: 1,
          sourceHash: "a".repeat(64),
          artifactHash: "b".repeat(64),
          bytesWritten: 256,
          recordedAt: now,
          attestation: "browser-web-serial-v1",
          ...override,
        },
      }),
    );
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(
      repository.recordUploadEvidence(userId, compileJobId, "b".repeat(64), 256),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("Supabase origin pinning", () => {
  it.each([
    "http://project.supabase.co",
    "https://user@example.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co:444",
    "https://abcdefghijklmnopqrst.supabase.co/rest/v1",
    "https://abcdefghijklmnopqrst.supabase.co/?redirect=https://attacker.test",
    "https://supabase.attacker.test",
  ])("rejects credential-bearing requests to untrusted origin %s", (url) => {
    expect(() => createSupabaseIdentityRepository(
      { ...repositoryEnv, SUPABASE_URL: url },
      "learner-token",
    )).toThrow("Supabase is not configured.");
  });

  it("allows the explicit loopback development origin", () => {
    expect(() => createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
    )).not.toThrow();
  });

  it("binds production credentials to the exact Supabase issuer before fetching", () => {
    const tokenFor = (issuer: string) => [
      btoa('{"alg":"none"}'),
      btoa(JSON.stringify({ iss: issuer })),
      "signature",
    ].join(".");
    const expectedOrigin = "https://abcdefghijklmnopqrst.supabase.co";
    const productionEnv = {
      ...repositoryEnv,
      ENVIRONMENT: "production",
      SUPABASE_URL: expectedOrigin,
    } as unknown as Env;

    expect(() => createSupabaseIdentityRepository(
      productionEnv,
      tokenFor(`${expectedOrigin}/auth/v1`),
    )).not.toThrow();
    expect(() => createSupabaseIdentityRepository(
      { ...productionEnv, SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co" },
      tokenFor(`${expectedOrigin}/auth/v1`),
    )).toThrow("Session rejected.");
  });
});
