import { afterEach, describe, expect, it, vi } from "vitest";
import { FirelightApi, FirelightApiError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Firelight API client", () => {
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
});
