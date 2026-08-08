import { describe, expect, it, vi } from "vitest";
import { FIRELIGHT_BOARD_FQBN } from "../shared/hardware";
import type { CompilerGatewayError } from "./compiler-gateway";
import {
  diagnosticSummary,
  requestCompilation,
  sanitizeDiagnostics,
  sha256Hex,
} from "./compiler-gateway";

const config = {
  url: "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws/",
  expectedOrigin: "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws",
  token: "test-service-token-that-is-at-least-thirty-two-characters",
  environment: "production",
} as const;
const source = "void setup() {}\nvoid loop() {}\n";
const validHex = ":100000000C945C000C946E000C946E000C946E00CA\n:00000001FF\n";

describe("compiler gateway", () => {
  it("calls the service-only boundary and verifies the returned artifact", async () => {
    const sourceHash = await sha256Hex(source);
    const artifactHash = await sha256Hex(validHex);
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.url).toBe(config.url);
      expect(request.headers.get("X-Firelight-Compiler-Token")).toBe(config.token);
      expect(request.headers.get("Origin")).toBeNull();
      expect(request.redirect).toBe("manual");
      expect(await request.json()).toEqual({ fqbn: FIRELIGHT_BOARD_FQBN, source });
      return Response.json({
        ok: true,
        artifact: {
          format: "intel-hex",
          fqbn: FIRELIGHT_BOARD_FQBN,
          sourceHash,
          artifactHash,
          hex: validHex,
        },
        diagnostics: ["/tmp/firelight-sketch/sketch.ino:4: warning: compiled"],
      });
    });

    await expect(requestCompilation(config, source, sourceHash, fetcher)).resolves.toEqual({
      sourceHash,
      artifactHash,
      hex: validHex,
      diagnostics: ["[path]:4: warning: compiled"],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an artifact that is bound to a different source hash", async () => {
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(async () =>
      Response.json({
        ok: true,
        artifact: {
          format: "intel-hex",
          fqbn: FIRELIGHT_BOARD_FQBN,
          sourceHash: "a".repeat(64),
          hex: validHex,
        },
        diagnostics: [],
      }),
    );

    await expect(requestCompilation(config, source, sourceHash, fetcher)).rejects.toEqual(
      expect.objectContaining<Partial<CompilerGatewayError>>({
        code: "COMPILER_INVALID_ARTIFACT",
        kind: "invalid-response",
      }),
    );
  });

  it("rejects an EOF-only artifact before it reaches the browser", async () => {
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(async () =>
      Response.json({
        ok: true,
        artifact: {
          format: "intel-hex",
          fqbn: FIRELIGHT_BOARD_FQBN,
          sourceHash,
          hex: ":00000001FF\n",
        },
        diagnostics: [],
      }),
    );

    await expect(requestCompilation(config, source, sourceHash, fetcher)).rejects.toEqual(
      expect.objectContaining<Partial<CompilerGatewayError>>({
        code: "COMPILER_INVALID_ARTIFACT",
        kind: "invalid-response",
      }),
    );
  });

  it("bounds upstream response bytes before parsing JSON", async () => {
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(async () =>
      new Response("{}", {
        headers: { "Content-Length": String(192 * 1024 + 1) },
      }),
    );

    await expect(requestCompilation(config, source, sourceHash, fetcher)).rejects.toEqual(
      expect.objectContaining<Partial<CompilerGatewayError>>({
        code: "COMPILER_RESPONSE_TOO_LARGE",
      }),
    );
  });

  it("aborts an upstream compile after the fixed 45-second deadline", async () => {
    vi.useFakeTimers();
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    try {
      const compilation = requestCompilation(config, source, sourceHash, fetcher);
      const rejection = expect(compilation).rejects.toEqual(
        expect.objectContaining<Partial<CompilerGatewayError>>({
          code: "COMPILER_TIMEOUT",
          kind: "timeout",
        }),
      );
      await vi.advanceTimersByTimeAsync(45_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the 45-second deadline active while a response body is streaming", async () => {
    vi.useFakeTimers();
    const sourceHash = await sha256Hex(source);
    const cancel = vi.fn();
    const fetcher = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel,
        }),
      ),
    );
    try {
      const compilation = requestCompilation(config, source, sourceHash, fetcher);
      const rejection = expect(compilation).rejects.toEqual(
        expect.objectContaining<Partial<CompilerGatewayError>>({
          code: "COMPILER_TIMEOUT",
          kind: "timeout",
        }),
      );
      await vi.advanceTimersByTimeAsync(45_000);
      await rejection;
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes and bounds diagnostic persistence", () => {
    const input = Array.from(
      { length: 30 },
      (_, index) => `\u001b[31m/tmp/firelight-sketch/file-${String(index)}.ino:4: warning: check\u001b[0m`,
    );
    const diagnostics = sanitizeDiagnostics(input);
    expect(diagnostics).toHaveLength(16);
    expect(diagnostics[0]).toBe("[path]:4: warning: check");
    expect(diagnosticSummary(diagnostics)).not.toContain("\u001b");
    expect(new TextEncoder().encode(diagnosticSummary(diagnostics)).byteLength).toBeLessThanOrEqual(
      8192,
    );
    expect(
      new TextEncoder().encode(diagnosticSummary(["é".repeat(5_000)])).byteLength,
    ).toBeLessThanOrEqual(8192);
  });

  it("redacts the service credential even if an upstream response echoes it", async () => {
    const sourceHash = await sha256Hex(source);
    const artifactHash = await sha256Hex(validHex);
    const result = await requestCompilation(config, source, sourceHash, async () =>
      Response.json({
        ok: true,
        artifact: {
          format: "intel-hex",
          fqbn: FIRELIGHT_BOARD_FQBN,
          sourceHash,
          artifactHash,
          hex: validHex,
        },
        diagnostics: [`sketch.ino:4: error: unexpected credential ${config.token}`],
      }),
    );

    expect(result.diagnostics).toEqual(["sketch.ino:4: error: unexpected credential [redacted]"]);
    expect(JSON.stringify(result)).not.toContain(config.token);
  });

  it("fails closed when the upstream URL or token is not service-safe", async () => {
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    await expect(
      requestCompilation(
        {
          url: "http://compiler.test",
          expectedOrigin: "http://compiler.test",
          token: "short",
          environment: "production",
        },
        source,
        sourceHash,
        fetcher,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CompilerGatewayError>>({
        code: "COMPILER_NOT_CONFIGURED",
        kind: "configuration",
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.test/",
    "https://abcdefghijklmnopqrst.lambda-url.us-east-1.on.aws/",
    "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws/compile",
    "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws/?next=https://attacker.test",
    "https://user@abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws/",
    "https://abcdefghijklmnopqrst.lambda-url.eu-west-1.on.aws:444/",
  ])("never sends the token or learner source to untrusted compiler URL %s", async (url) => {
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(async () => Response.json({ ok: true }));

    await expect(requestCompilation(
      { ...config, url },
      source,
      sourceHash,
      fetcher,
    )).rejects.toMatchObject({ kind: "configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows an explicit loopback compiler only in development", async () => {
    const sourceHash = await sha256Hex(source);
    const artifactHash = await sha256Hex(validHex);
    const local = {
      ...config,
      url: "http://127.0.0.1:9000/",
      expectedOrigin: "http://127.0.0.1:9000",
      environment: "development",
    };

    await expect(requestCompilation(local, source, sourceHash, async () => Response.json({
      ok: true,
      artifact: {
        format: "intel-hex",
        fqbn: FIRELIGHT_BOARD_FQBN,
        sourceHash,
        artifactHash,
        hex: validHex,
      },
      diagnostics: [],
    }))).resolves.toMatchObject({ sourceHash, artifactHash });
    await expect(requestCompilation(
      { ...local, environment: "production" },
      source,
      sourceHash,
    )).rejects.toMatchObject({ kind: "configuration" });
  });

  it("binds the gateway URL to an independently configured exact origin", async () => {
    const sourceHash = await sha256Hex(source);
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    await expect(requestCompilation(
      {
        ...config,
        url: "https://zyxwvutsrqponmlkjihg.lambda-url.eu-west-1.on.aws/",
      },
      source,
      sourceHash,
      fetcher,
    )).rejects.toMatchObject({ kind: "configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("drops unstructured source, URLs, and paths from upstream errors", async () => {
    const sourceHash = await sha256Hex(source);
    await expect(requestCompilation(config, source, sourceHash, async () => Response.json({
      ok: false,
      error: {
        code: "COMPILER_FAILED",
        message: "source at https://attacker.test /private/build/sketch.ino",
      },
      diagnostics: [
        "learner source error: void setup() {}",
        "/private/build/sketch.ino:7: error: failed at https://attacker.test/x",
      ],
    }, { status: 422 }))).rejects.toEqual(expect.objectContaining({
      message: "The sketch did not compile.",
      diagnostics: ["[path]:7: error: failed at [redacted-url]"],
    }));
  });
});
