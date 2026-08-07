import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ProgressUpdateInput } from "../shared/identity";
import { createSupabaseIdentityRepository } from "./identity-repository";
import type { RepositoryError, RepositoryFetcher } from "./identity-repository";

const userId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-07T12:00:00.000Z";
const repositoryEnv: Env = {
  ENVIRONMENT: "development",
  BUILD_ID: "local",
  SUPABASE_URL: "https://supabase.firelight.test",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  KIT_CODE_PEPPER: "firelight-local-kit-pepper",
  ASSETS: exports.default,
};

function progressRow(revision: number) {
  return {
    lesson_id: "first-spark",
    lesson_version: 1,
    revision,
    status: "in_progress",
    current_step: "edit-code",
    percentage: 20,
    code_snapshot: "void setup() {}",
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
});
