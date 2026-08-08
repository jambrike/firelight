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
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-service-role-key");
    expect(headers.get("apikey")).toBe("test-service-role-key");
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
    expect(headers.get("authorization")).toBe("Bearer test-service-role-key");
    expect(headers.get("apikey")).toBe("test-service-role-key");
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

describe("Supabase request deadline", () => {
  const authenticatedUser = {
    id: userId,
    email: "deadline@example.test",
    email_confirmed_at: now,
    last_sign_in_at: now,
    is_anonymous: false,
  };

  it("fails a never-resolving header fetch and aborts the request", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetcher: RepositoryFetcher = vi.fn(async (_url, init) => {
      requestSignal = init.signal;
      return new Promise<Response>(() => undefined);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
      5,
    );

    await expect(repository.authenticate()).rejects.toMatchObject({
      kind: "unavailable",
      message: "Supabase request timed out.",
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("cancels a stalled response reader when the same deadline expires", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      vi.fn(async () => new Response(stream)),
      5,
    );

    await expect(repository.authenticate()).rejects.toMatchObject({
      kind: "unavailable",
      message: "Supabase request timed out.",
    });
    expect(cancellations).toBe(1);
  });

  it("clears the deadline timer after a complete response", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      vi.fn(async (_url, init) => {
        requestSignal = init.signal;
        return Response.json(authenticatedUser);
      }),
      10,
    );

    await expect(repository.authenticate()).resolves.toMatchObject({ id: userId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestSignal?.aborted).toBe(false);
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

describe("Supabase account export repository", () => {
  const activationId = "22222222-2222-4222-8222-222222222222";
  const compileJobId = "33333333-3333-4333-8333-333333333333";
  const evidenceId = "44444444-4444-4444-8444-444444444444";

  function profileRow() {
    return {
      id: userId,
      display_name: "Ada",
      role: "learner",
      access_source: "code",
      access_granted_at: now,
      created_at: now,
      updated_at: now,
    };
  }

  function exportProgressRow(version: number, owner = userId) {
    return {
      user_id: owner,
      lesson_id: "first-spark",
      lesson_version: version,
      revision: version,
      status: "in_progress",
      current_step: "edit-code",
      percentage: 20,
      code_snapshot: `// lesson version ${String(version)}`,
      completion_evidence_id: null,
      completed_at: null,
      updated_at: now,
    };
  }

  function exportFetcher(
    requests: { url: URL; init: RequestInit }[],
    progressRows: readonly unknown[] = [exportProgressRow(1), exportProgressRow(2)],
    activationRows: readonly unknown[] = [{
      id: activationId,
      batch: "pilot-a",
      kind: "code",
      claimed_at: now,
      code_hash: "must-not-cross-the-projection",
    }],
  ): RepositoryFetcher {
    return vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({ url, init });
      if (url.pathname === "/rest/v1/profiles") return Response.json([profileRow()]);
      if (url.pathname === "/rest/v1/kit_codes") {
        return Response.json(activationRows);
      }
      if (url.pathname === "/rest/v1/lesson_progress") {
        return Response.json(progressRows);
      }
      if (url.pathname === "/rest/v1/compile_jobs") {
        return Response.json([{
          user_id: userId,
          id: compileJobId,
          lesson_id: "first-spark",
          lesson_version: 2,
          board_target: "arduino:avr:nano:cpu=atmega328old",
          source_hash: "a".repeat(64),
          state: "succeeded",
          duration_ms: 500,
          safe_error_code: null,
          artifact_hash: "b".repeat(64),
          diagnostic_summary: "Compilation completed.",
          created_at: now,
          started_at: now,
          finished_at: now,
          source: "must-not-cross-the-projection",
        }]);
      }
      if (url.pathname === "/rest/v1/hardware_upload_evidence") {
        return Response.json([{
          user_id: userId,
          id: evidenceId,
          compile_job_id: compileJobId,
          lesson_id: "first-spark",
          lesson_version: 2,
          source_hash: "a".repeat(64),
          artifact_hash: "b".repeat(64),
          bytes_written: 256,
          attestation_kind: "browser-web-serial-v1",
          recorded_at: now,
          hex: "must-not-cross-the-projection",
        }]);
      }
      throw new Error(`Unexpected export request ${url.pathname}`);
    });
  }

  it("reads every owner dataset through the learner JWT with strict projections", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      exportFetcher(requests),
    );

    const result = await repository.getAccountExport(userId);

    expect(result.progress.map((row) => row.lessonVersion)).toEqual([1, 2]);
    expect(result.activation).toMatchObject({ id: activationId, batch: "pilot-a" });
    expect(result.compileJobs).toHaveLength(1);
    expect(result.uploadEvidence).toHaveLength(1);
    expect(result.activation).not.toHaveProperty("code_hash");
    expect(result.compileJobs[0]).not.toHaveProperty("source");
    expect(result.uploadEvidence[0]).not.toHaveProperty("hex");

    expect(requests.map((request) => request.url.pathname).sort()).toEqual([
      "/rest/v1/compile_jobs",
      "/rest/v1/hardware_upload_evidence",
      "/rest/v1/kit_codes",
      "/rest/v1/lesson_progress",
      "/rest/v1/profiles",
    ]);
    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Bearer learner-token");
      expect(headers.get("apikey")).toBe("test-publishable-key");
    }
    const kitRequest = requests.find((request) =>
      request.url.pathname === "/rest/v1/kit_codes"
    );
    expect(kitRequest?.url.searchParams.get("select")).toBe("id,batch,kind,claimed_at");
    expect(kitRequest?.url.href).not.toContain("code_hash");
    for (const table of ["lesson_progress", "compile_jobs", "hardware_upload_evidence"]) {
      const request = requests.find((item) => item.url.pathname.endsWith(`/${table}`));
      expect(request?.url.searchParams.get("user_id")).toBe(`eq.${userId}`);
    }
  });

  it("fails rather than truncating a complete export above its record bound", async () => {
    const rows = Array.from({ length: 257 }, (_, index) =>
      exportProgressRow((index % 1_000_000) + 1)
    );
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      exportFetcher([], rows),
    );

    await expect(repository.getAccountExport(userId)).rejects.toMatchObject({
      kind: "export_too_large",
    });
  });

  it("rejects any projected row whose owner does not match the authenticated request", async () => {
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      exportFetcher([], [
        exportProgressRow(1, "99999999-9999-4999-8999-999999999999"),
      ]),
    );

    await expect(repository.getAccountExport(userId)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("fails instead of silently omitting a code activation that the owner cannot read", async () => {
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      exportFetcher([], [], []),
    );

    await expect(repository.getAccountExport(userId)).rejects.toMatchObject({
      kind: "unavailable",
      message: "The learner activation is missing.",
    });
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
      SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    } as unknown as Env;

    expect(() => createSupabaseIdentityRepository(
      productionEnv,
      tokenFor(`${expectedOrigin}/auth/v1`),
    )).not.toThrow();
    expect(() => createSupabaseIdentityRepository(
      { ...productionEnv, SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co" },
      tokenFor(`${expectedOrigin}/auth/v1`),
    )).toThrow("Supabase is not configured.");
  });
});

describe("Supabase recent-session verification", () => {
  it("asks a service-only RPC about the exact authenticated session", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return Response.json(true);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      fetcher,
    );

    await expect(repository.hasRecentSession(userId, sessionId)).resolves.toBe(true);
    expect(requests[0]?.url.pathname).toBe(
      "/rest/v1/rpc/firelight_has_recent_session",
    );
    expect(parseRequestBody(requests[0]?.init.body)).toEqual({
      p_user_id: userId,
      p_session_id: sessionId,
      p_max_age_seconds: 900,
    });
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-service-role-key");
  });

  it("fails closed when session freshness is not a boolean", async () => {
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "learner-token",
      vi.fn(async () => Response.json({ recent: true })),
    );

    await expect(
      repository.hasRecentSession(
        userId,
        "55555555-5555-4555-8555-555555555555",
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("Supabase admin operations repository", () => {
  it("checks the authenticated account's own role before privileged RPCs", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      return Response.json([{ role: "admin" }]);
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "admin-token",
      fetcher,
    );

    await expect(repository.isAdmin(userId)).resolves.toBe(true);
    expect(requests[0]?.url.pathname).toBe("/rest/v1/profiles");
    expect(requests[0]?.url.searchParams.get("id")).toBe(`eq.${userId}`);
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer admin-token",
    );
  });

  it("uses service-only audited RPCs for batch creation and revocation", async () => {
    const kitId = "44444444-4444-4444-8444-444444444444";
    const codeIds = [
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ];
    const hashes = ["a".repeat(64), "b".repeat(64)];
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetcher: RepositoryFetcher = vi.fn(async (url, init) => {
      requests.push({ url, init });
      if (url.pathname.endsWith("firelight_admin_create_kit_batch")) {
        return Response.json({
          result: "created",
          batch: "pilot-a",
          count: 2,
          createdAt: now,
        });
      }
      return Response.json({
        result: "revoked",
        id: kitId,
        accessRevoked: true,
        failedActiveCompileJobs: 1,
        revokedAt: now,
      });
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "admin-token",
      fetcher,
    );

    await expect(
      repository.createAdminKitBatch(userId, "pilot-a", codeIds, hashes),
    ).resolves.toEqual({ batch: "pilot-a", count: 2, createdAt: now });
    await expect(
      repository.revokeAdminKit(userId, kitId, "security"),
    ).resolves.toEqual({ id: kitId, state: "revoked", accessRevoked: true });

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/rest/v1/rpc/firelight_admin_create_kit_batch",
      "/rest/v1/rpc/firelight_admin_revoke_kit",
    ]);
    expect(parseRequestBody(requests[0]?.init.body)).toEqual({
      p_actor_id: userId,
      p_batch: "pilot-a",
      p_code_ids: codeIds,
      p_code_hashes: hashes,
    });
    expect(parseRequestBody(requests[1]?.init.body)).toEqual({
      p_actor_id: userId,
      p_kit_id: kitId,
      p_reason: "security",
    });
    for (const request of requests) {
      expect(new Headers(request.init.headers).get("authorization")).toBe(
        "Bearer test-service-role-key",
      );
    }
  });

  it("parses bounded support projections and drops non-contract fields", async () => {
    const learnerId = "66666666-6666-4666-8666-666666666666";
    const kitId = "44444444-4444-4444-8444-444444444444";
    const jobId = "55555555-5555-4555-8555-555555555555";
    const fetcher: RepositoryFetcher = vi.fn(async (url) => {
      if (url.pathname.endsWith("firelight_admin_list_kits")) {
        return Response.json({
          items: [{
            id: kitId,
            batch: "pilot-a",
            state: "claimed",
            claimedBy: learnerId,
            claimedAt: now,
            revokedAt: null,
            createdAt: now,
            codeHash: "a".repeat(64),
          }],
          hasMore: true,
        });
      }
      if (url.pathname.endsWith("firelight_admin_list_learners")) {
        return Response.json({
          items: [{
            id: learnerId,
            email: "grace@example.com",
            displayName: "Grace",
            role: "learner",
            accessSource: "code",
            activationBatch: "pilot-a",
            completedLessons: 1,
            progressRecords: 2,
            createdAt: now,
            updatedAt: now,
          }],
          hasMore: false,
        });
      }
      if (url.pathname.endsWith("firelight_admin_list_progress")) {
        return Response.json({
          items: [{
            lessonId: "first-spark",
            lessonVersion: 1,
            status: "completed",
            currentStep: "complete",
            percentage: 100,
            completedAt: now,
            updatedAt: now,
            codeSnapshot: "must not leave the database projection",
          }],
          hasMore: false,
        });
      }
      if (url.pathname.endsWith("firelight_admin_list_compile_jobs")) {
        return Response.json({
          items: [{
            id: jobId,
            userId: learnerId,
            lessonId: "first-spark",
            lessonVersion: 1,
            state: "failed",
            durationMs: 250,
            safeErrorCode: "COMPILER_FAILED",
            diagnosticSummary: "Expected a semicolon.",
            createdAt: now,
            finishedAt: now,
            sourceHash: "a".repeat(64),
          }],
          hasMore: false,
        });
      }
      return Response.json({
        items: [{
          id: 1,
          actorId: userId,
          action: "kit.revoke",
          targetType: "kit",
          targetId: kitId,
          metadata: { reason: "security" },
          createdAt: now,
        }],
        hasMore: false,
      });
    });
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "admin-token",
      fetcher,
    );
    const page = { limit: 10, offset: 20 };

    const kits = await repository.listAdminKits(userId, "pilot", "claimed", page);
    const learners = await repository.listAdminLearners(userId, "Grace", page);
    const progress = await repository.listAdminProgress(userId, learnerId, page);
    const diagnostics = await repository.listAdminCompileDiagnostics(
      userId,
      "failed",
      "COMPILER_FAILED",
      page,
    );
    const audit = await repository.listAdminAudit(userId, "kit.revoke", page);

    expect(kits.nextOffset).toBe(30);
    expect(kits.items[0]).not.toHaveProperty("codeHash");
    expect(learners.items[0]).toMatchObject({ id: learnerId, displayName: "Grace" });
    expect(progress.items[0]).not.toHaveProperty("codeSnapshot");
    expect(diagnostics.items[0]).not.toHaveProperty("sourceHash");
    expect(audit.items[0]).toMatchObject({ action: "kit.revoke" });
  });

  it("fails closed on oversized or malformed support projections", async () => {
    const repository = createSupabaseIdentityRepository(
      repositoryEnv,
      "admin-token",
      vi.fn(async () => Response.json({
        items: [{
          id: "55555555-5555-4555-8555-555555555555",
          userId,
          lessonId: "first-spark",
          lessonVersion: 1,
          state: "failed",
          durationMs: 60_001,
          safeErrorCode: "COMPILER_FAILED",
          diagnosticSummary: "bounded",
          createdAt: now,
          finishedAt: now,
        }],
        hasMore: false,
      })),
    );

    await expect(
      repository.listAdminCompileDiagnostics(
        userId,
        "failed",
        null,
        { limit: 10, offset: 0 },
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
