import {
  FIRELIGHT_BOARD_FQBN,
  MAX_COMPILER_RESPONSE_BYTES,
} from "../shared/hardware";
import {
  FIRELIGHT_MAX_SKETCH_BYTES,
  MAX_INTEL_HEX_TEXT_BYTES,
  parseIntelHex,
} from "../src/features/hardware/intel-hex";

const MAX_DIAGNOSTICS = 16;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_LINE_CHARACTERS = 512;
const COMPILER_TIMEOUT_MS = 45_000;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LAMBDA_FUNCTION_URL_HOST = /^[a-z0-9]{10,64}\.lambda-url\.eu-west-1\.on\.aws$/;
const STRUCTURED_DIAGNOSTIC = /^(?:\[redacted\])*(?:\[path\]|[A-Za-z0-9_.-]+\.(?:ino|c|cc|cpp|h|hpp)):\d+(?::\d+)?:\s*(?:fatal error|error|warning|note)\s*:/i;
const GLOBAL_DIAGNOSTIC = /^(?:error during build|compilation failed|exit status)\b/i;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
const UNIX_PATH_IN_TEXT = /(?<![A-Za-z0-9_])\/(?:[^/\s:'"]+\/)*[^/\s:'"]+/g;
const WINDOWS_PATH_IN_TEXT = /\b[A-Za-z]:\\(?:[^\\\s:'"]+\\)*[^\\\s:'"]+/g;
// ANSI control bytes are intentional here: upstream diagnostics are untrusted terminal text.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export type CompilerFetcher = (request: Request) => Promise<Response>;

export interface CompilerGatewayConfig {
  readonly url: string;
  readonly expectedOrigin: string;
  readonly expectedHost: string;
  readonly token: string;
  readonly environment: string;
}

export interface CompilerGatewayResult {
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly hex: string;
  readonly diagnostics: readonly string[];
}

export class CompilerGatewayError extends Error {
  readonly code: string;
  readonly kind: "configuration" | "timeout" | "upstream" | "compile" | "invalid-response";
  readonly diagnostics: readonly string[];

  constructor(
    kind: CompilerGatewayError["kind"],
    code: string,
    message: string,
    diagnostics: readonly string[] = [],
  ) {
    super(message);
    this.name = "CompilerGatewayError";
    this.kind = kind;
    this.code = SAFE_ERROR_CODE.test(code) ? code : "COMPILER_FAILED";
    this.diagnostics = diagnostics;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredUrl(
  value: string,
  expectedOrigin: string,
  expectedHost: string,
  environment: string,
): URL {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(value);
    expected = new URL(expectedOrigin);
  } catch {
    throw new CompilerGatewayError(
      "configuration",
      "COMPILER_NOT_CONFIGURED",
      "The compiler service is not configured.",
    );
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const isDevelopmentLoopback =
    environment === "development" &&
    isLoopback &&
    parsed.hostname === expectedHost &&
    parsed.protocol === "http:" &&
    parsed.port.length > 0;
  const isRegionalFunctionUrl =
    (environment === "staging" || environment === "production") &&
    parsed.protocol === "https:" &&
    LAMBDA_FUNCTION_URL_HOST.test(parsed.hostname) &&
    LAMBDA_FUNCTION_URL_HOST.test(expectedHost) &&
    parsed.hostname === expectedHost &&
    parsed.port.length === 0;
  const expectedIsOriginOnly =
    expected.origin === expectedOrigin.replace(/\/$/, "") &&
    expected.pathname === "/" &&
    expected.search.length === 0 &&
    expected.hash.length === 0 &&
    expected.username.length === 0 &&
    expected.password.length === 0;
  if (
    (!isDevelopmentLoopback && !isRegionalFunctionUrl) ||
    !expectedIsOriginOnly ||
    parsed.origin !== expected.origin ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new CompilerGatewayError(
      "configuration",
      "COMPILER_NOT_CONFIGURED",
      "The compiler service is not configured.",
    );
  }
  return parsed;
}

function configuredToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || token.length > 512) {
    throw new CompilerGatewayError(
      "configuration",
      "COMPILER_NOT_CONFIGURED",
      "The compiler service is not configured.",
    );
  }
  return token;
}

function sanitizeDiagnostic(value: string, redactions: readonly string[] = []): string {
  let withoutAnsi = value.replace(ANSI_ESCAPE, "");
  for (const sensitiveValue of redactions) {
    if (sensitiveValue.length > 0) {
      withoutAnsi = withoutAnsi.replaceAll(sensitiveValue, "[redacted]");
    }
  }
  let result = "";
  for (const character of withoutAnsi) {
    const code = character.charCodeAt(0);
    if (code === 9 || code >= 32) result += character;
    if (Array.from(result).length >= MAX_DIAGNOSTIC_LINE_CHARACTERS) break;
  }
  result = result
    .replace(URL_IN_TEXT, "[redacted-url]")
    .replace(WINDOWS_PATH_IN_TEXT, "[path]")
    .replace(UNIX_PATH_IN_TEXT, "[path]")
    .trim();
  return STRUCTURED_DIAGNOSTIC.test(result) || GLOBAL_DIAGNOSTIC.test(result)
    ? result
    : "";
}

export function sanitizeDiagnostics(
  value: unknown,
  redactions: readonly string[] = [],
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: string[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const line = sanitizeDiagnostic(item, redactions);
    if (line.length === 0) continue;
    const bytes = new TextEncoder().encode(line).byteLength;
    if (totalBytes + bytes > MAX_DIAGNOSTIC_BYTES) break;
    diagnostics.push(line);
    totalBytes += bytes;
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  return diagnostics;
}

export function diagnosticSummary(diagnostics: readonly string[]): string {
  const summary = diagnostics.join("\n");
  const bytes = new TextEncoder().encode(summary);
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return summary;
  let bounded = new TextDecoder().decode(bytes.slice(0, MAX_DIAGNOSTIC_BYTES)).trimEnd();
  while (new TextEncoder().encode(bounded).byteLength > MAX_DIAGNOSTIC_BYTES) {
    bounded = Array.from(bounded).slice(0, -1).join("").trimEnd();
  }
  return bounded;
}

function timeoutError(): CompilerGatewayError {
  return new CompilerGatewayError(
    "timeout",
    "COMPILER_TIMEOUT",
    "Compilation took too long. Try again in a moment.",
  );
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_COMPILER_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new CompilerGatewayError(
        "invalid-response",
        "COMPILER_RESPONSE_TOO_LARGE",
        "The compiler returned an invalid response.",
      );
    }
  }
  if (!response.body) {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_RESPONSE",
      "The compiler returned an invalid response.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAborted!: (reason: CompilerGatewayError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    void reader.cancel("compiler-timeout").catch(() => undefined);
    rejectAborted(timeoutError());
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new CompilerGatewayError(
          "invalid-response",
          "COMPILER_INVALID_RESPONSE",
          "The compiler returned invalid response bytes.",
        );
      }
      total += chunk.byteLength;
      if (total > MAX_COMPILER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CompilerGatewayError(
          "invalid-response",
          "COMPILER_RESPONSE_TOO_LARGE",
          "The compiler returned an oversized response.",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_RESPONSE",
      "The compiler returned invalid JSON.",
    );
  }
}

function validateIntelHexText(value: unknown): string {
  if (typeof value !== "string") {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_ARTIFACT",
      "The compiler returned an invalid artifact.",
    );
  }
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength < 12 || encoded.byteLength > MAX_INTEL_HEX_TEXT_BYTES) {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_ARTIFACT",
      "The compiler returned an invalid artifact.",
    );
  }
  try {
    const image = parseIntelHex(value, {
      maxAddressExclusive: FIRELIGHT_MAX_SKETCH_BYTES,
      maxTextBytes: MAX_INTEL_HEX_TEXT_BYTES,
    });
    if (image.startAddress !== 0) throw new Error("missing reset vector");
  } catch {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_ARTIFACT",
      "The compiler returned malformed or out-of-range Intel HEX.",
    );
  }
  return value;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseUpstreamError(value: unknown, redactions: readonly string[]): {
  readonly code: string;
  readonly message: string;
  readonly diagnostics: readonly string[];
} {
  const diagnostics = isRecord(value)
    ? sanitizeDiagnostics(value.diagnostics, redactions)
    : [];
  const error = isRecord(value) && isRecord(value.error) ? value.error : null;
  const rawCode = error && typeof error.code === "string" ? error.code : "COMPILER_FAILED";
  const code = SAFE_ERROR_CODE.test(rawCode) ? rawCode : "COMPILER_FAILED";
  return {
    code,
    message: code === "COMPILER_TIMEOUT"
      ? "Compilation took too long. Try again in a moment."
      : code === "COMPILER_SOURCE_POLICY_REJECTED"
        ? "The sketch uses a compiler feature that Firelight lessons do not allow."
        : code === "COMPILER_FAILED"
          ? "The sketch did not compile."
          : "The compiler could not complete this request.",
    diagnostics,
  };
}

export async function requestCompilation(
  config: CompilerGatewayConfig,
  source: string,
  expectedSourceHash: string,
  fetcher: CompilerFetcher = (request) => fetch(request),
): Promise<CompilerGatewayResult> {
  const url = configuredUrl(
    config.url,
    config.expectedOrigin,
    config.expectedHost,
    config.environment,
  );
  const token = configuredToken(config.token);
  if (!SHA256.test(expectedSourceHash)) {
    throw new CompilerGatewayError(
      "configuration",
      "SOURCE_HASH_INVALID",
      "The sketch hash is invalid.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort("compiler-timeout");
  }, COMPILER_TIMEOUT_MS);

  let response: Response;
  let body: unknown;
  try {
    response = await fetcher(
      new Request(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Firelight-Compiler-Token": token,
        },
        body: JSON.stringify({ fqbn: FIRELIGHT_BOARD_FQBN, source }),
        redirect: "manual",
        signal: controller.signal,
      }),
    );
    body = await readBoundedJson(response, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw timeoutError();
    }
    if (error instanceof CompilerGatewayError) throw error;
    throw new CompilerGatewayError(
      "upstream",
      "COMPILER_UNAVAILABLE",
      "The compiler service could not be reached.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const failure = parseUpstreamError(body, [token]);
    throw new CompilerGatewayError(
      response.status >= 500 ? "upstream" : "compile",
      failure.code,
      failure.message,
      failure.diagnostics,
    );
  }
  if (!isRecord(body) || body.ok !== true || !isRecord(body.artifact)) {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_RESPONSE",
      "The compiler returned an invalid response.",
    );
  }

  const artifact = body.artifact;
  if (
    artifact.format !== "intel-hex" ||
    artifact.fqbn !== FIRELIGHT_BOARD_FQBN ||
    artifact.sourceHash !== expectedSourceHash
  ) {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_ARTIFACT",
      "The compiler artifact did not match this sketch and board.",
    );
  }
  const hex = validateIntelHexText(artifact.hex);
  const artifactHash = await sha256Hex(hex);
  if (
    artifact.artifactHash !== undefined &&
    (typeof artifact.artifactHash !== "string" || artifact.artifactHash !== artifactHash)
  ) {
    throw new CompilerGatewayError(
      "invalid-response",
      "COMPILER_INVALID_ARTIFACT",
      "The compiler artifact integrity check failed.",
    );
  }
  return {
    sourceHash: expectedSourceHash,
    artifactHash,
    hex,
    diagnostics: sanitizeDiagnostics(body.diagnostics, [token]),
  };
}
