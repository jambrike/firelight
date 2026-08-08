import { afterEach, describe, expect, it, vi } from "vitest";
import { FirelightApi, FirelightApiError } from "./api";

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
