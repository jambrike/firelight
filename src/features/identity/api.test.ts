import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_EXPORT_SCHEMA,
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  type AccountExport,
} from "../../../shared/account-export";
import { FirelightApi, FirelightApiError } from "./api";

function requestPath(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function jsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON string request body.");
  return JSON.parse(init.body) as unknown;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Firelight API client", () => {
  const validEvidence = {
    id: "44444444-4444-4444-8444-444444444444",
    compileJobId: "33333333-3333-4333-8333-333333333333",
    lessonId: "first-spark",
    lessonVersion: 1,
    sourceHash: "a".repeat(64),
    artifactHash: "b".repeat(64),
    bytesWritten: 256,
    recordedAt: "2026-08-07T12:00:00.000Z",
    attestation: "browser-web-serial-v1",
  };

  it("adds the current bearer token and JSON headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer session-token");
      expect(headers.get("Content-Type")).toBe("application/json");
      return Response.json({ data: { displayName: "Ada" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new FirelightApi(() => "session-token").updateProfile("Ada");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails locally rather than sending an unauthenticated protected request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new FirelightApi().getBootstrap()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads the authenticated, versioned account export", async () => {
    const accountExport: AccountExport = {
      schema: ACCOUNT_EXPORT_SCHEMA,
      version: ACCOUNT_EXPORT_SCHEMA_VERSION,
      exportedAt: "2026-08-08T10:00:00.000Z",
      data: {
        profile: {
          id: "11111111-1111-4111-8111-111111111111",
          displayName: "Ada",
          role: "learner",
          email: "ada@example.com",
          emailConfirmed: true,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-08T10:00:00.000Z",
        },
        activation: null,
        progress: [],
        compileJobs: [],
        uploadEvidence: [],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestPath(input)).toBe("/api/account/export");
      expect(init?.method).toBeUndefined();
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer learner-token");
      return Response.json({ data: accountExport });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new FirelightApi(() => "learner-token").getAccountExport()).resolves.toEqual(
      accountExport,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends the exact hard-delete confirmation in the request body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(jsonRequestBody(init)).toEqual({ confirmation: "DELETE" });
      return Response.json({ data: { deleted: true } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new FirelightApi(() => "token").deleteAccount("DELETE")).resolves.toEqual({
      deleted: true,
    });
  });

  it("builds bounded, encoded admin endpoint requests", async () => {
    const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ path: requestPath(input), init });
        return Response.json({ data: { items: [], limit: 20, offset: 0, nextOffset: null } });
      }),
    );
    const api = new FirelightApi(() => "admin-token");

    await api.listAdminKits({ q: " pilot one ", state: "issued", limit: 20, offset: 40 });
    await api.searchAdminLearners({ q: " ada@example.com ", limit: 20, offset: 0 });
    await api.getAdminLearnerProgress("learner/id", { limit: 20, offset: 20 });
    await api.listAdminCompileDiagnostics({
      state: "failed",
      errorCode: " COMPILE_FAILED ",
      limit: 20,
      offset: 0,
    });
    await api.listAdminAudit({ action: " kit.revoke ", limit: 20, offset: 60 });

    expect(requests.map((request) => request.path)).toEqual([
      "/api/admin/kits?q=pilot+one&state=issued&limit=20&offset=40",
      "/api/admin/learners?q=ada%40example.com&limit=20&offset=0",
      "/api/admin/learners/learner%2Fid/progress?limit=20&offset=20",
      "/api/admin/compile-diagnostics?state=failed&errorCode=COMPILE_FAILED&limit=20&offset=0",
      "/api/admin/audit?action=kit.revoke&limit=20&offset=60",
    ]);
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get("Authorization")).toBe("Bearer admin-token");
    }
  });

  it("uses typed mutation bodies for admin kit operations", async () => {
    const requests: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ path: requestPath(input), init });
        return Response.json({ data: {} });
      }),
    );
    const api = new FirelightApi(() => "admin-token");

    await api.createAdminKitBatch({ batch: "pilot-august", count: 12 });
    await api.revokeAdminKit("kit/id", { reason: "security" });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.path).toBe("/api/admin/kits/batches");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(jsonRequestBody(requests[0]?.init)).toEqual({
      batch: "pilot-august",
      count: 12,
    });
    expect(requests[1]?.path).toBe("/api/admin/kits/kit%2Fid/revoke");
    expect(requests[1]?.init?.method).toBe("POST");
    expect(jsonRequestBody(requests[1]?.init)).toEqual({ reason: "security" });
  });

  it("preserves structured API error codes and request IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "ACTIVATION_REQUIRED",
              message: "Activate first.",
              requestId: "request-123",
            },
          },
          { status: 403 },
        ),
      ),
    );

    const error = await new FirelightApi(() => "token")
      .saveProgress("first-spark", {
        lessonVersion: 1,
        expectedRevision: null,
        status: "in_progress",
        currentStep: "intro",
        percentage: 10,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FirelightApiError);
    expect(error).toMatchObject({
      code: "ACTIVATION_REQUIRED",
      requestId: "request-123",
      status: 403,
    });
  });

  it("parses every upload-evidence response field before returning it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: validEvidence })),
    );

    await expect(
      new FirelightApi(() => "token").recordUploadEvidence({
        compileJobId: validEvidence.compileJobId,
        artifactHash: validEvidence.artifactHash,
        bytesWritten: validEvidence.bytesWritten,
      }),
    ).resolves.toEqual(validEvidence);
  });

  it.each([
    ["evidence UUID", { id: "not-a-uuid" }],
    ["compile UUID version", { compileJobId: "33333333-3333-1333-8333-333333333333" }],
    ["lesson", { lessonId: "custom-board" }],
    ["lesson version", { lessonVersion: 1.5 }],
    ["source hash casing", { sourceHash: "A".repeat(64) }],
    ["artifact hash", { artifactHash: "b".repeat(63) }],
    ["byte count", { bytesWritten: 0 }],
    ["recorded timestamp", { recordedAt: "2026-02-30T12:00:00Z" }],
    ["attestation", { attestation: "cryptographic-device-proof" }],
  ])("rejects malformed upload-evidence %s metadata", async (_label, override) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { ...validEvidence, ...override } })),
    );

    await expect(
      new FirelightApi(() => "token").recordUploadEvidence({
        compileJobId: validEvidence.compileJobId,
        artifactHash: validEvidence.artifactHash,
        bytesWritten: validEvidence.bytesWritten,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });

  it.each([
    ["compile job", { compileJobId: "55555555-5555-4555-8555-555555555555" }],
    ["artifact", { artifactHash: "c".repeat(64) }],
    ["byte count", { bytesWritten: 255 }],
  ])("rejects valid-looking upload evidence that changes the requested %s", async (_label, override) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { ...validEvidence, ...override } })),
    );

    await expect(
      new FirelightApi(() => "token").recordUploadEvidence({
        compileJobId: validEvidence.compileJobId,
        artifactHash: validEvidence.artifactHash,
        bytesWritten: validEvidence.bytesWritten,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });
});
