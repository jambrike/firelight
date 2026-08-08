import process from "node:process";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

/* global AbortController, Response, clearTimeout, setTimeout */

export const PUBLIC_PROBE_TIMEOUT_MS = 10_000;
export const PUBLIC_PROBE_RESPONSE_BYTES = 16 * 1024;
export const PUBLIC_PROBE_RETRY_DELAY_MS = 15_000;

const BUILD_SHA = /^[0-9a-f]{40}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const CANONICAL_BASE_URLS = Object.freeze({
  staging: "https://staging.firelight.ie",
  production: "https://firelight.ie",
});

export class PublicProbeError extends Error {
  constructor(code) {
    const safeCode = SAFE_ERROR_CODE.test(code) ? code : "PUBLIC_PROBE_FAILED";
    super(safeCode);
    this.name = "PublicProbeError";
    this.code = safeCode;
  }
}

function fail(code) {
  throw new PublicProbeError(code);
}

function requiredString(environment, name, maximum) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    fail(`INVALID_${name}`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) fail(`INVALID_${name}`);
  }
  return value;
}

export function parsePublicProbeEnvironment(environment) {
  const expectedEnvironment = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_ENVIRONMENT",
    10,
  );
  if (!Object.hasOwn(CANONICAL_BASE_URLS, expectedEnvironment)) {
    fail("INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT");
  }

  const baseUrl = requiredString(environment, "FIRELIGHT_BASE_URL", 64);
  if (baseUrl !== CANONICAL_BASE_URLS[expectedEnvironment]) {
    fail("FIRELIGHT_BASE_URL_MISMATCH");
  }

  return Object.freeze({ baseUrl, expectedEnvironment });
}

function exactRecord(value, expectedKeys, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    fail(code);
  }
  return value;
}

async function cancelQuietly(stream) {
  try {
    await stream?.cancel();
  } catch {
    // A timeout or transport error may already have closed the response.
  }
}

export async function readBoundedProbeResponse(
  response,
  maximumBytes = PUBLIC_PROBE_RESPONSE_BYTES,
) {
  if (!(response instanceof Response)) fail("INVALID_FETCH_RESPONSE");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("INVALID_RESPONSE_LIMIT");
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    await cancelQuietly(response.body);
    fail("RESPONSE_TOO_LARGE");
  }
  if (response.body === null) fail("INVALID_JSON_RESPONSE");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) fail("INVALID_RESPONSE_BODY");
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail("RESPONSE_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) fail("INVALID_JSON_RESPONSE");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes) {
  try {
    return JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    fail("INVALID_JSON_RESPONSE");
  }
}

export function validatePublicStatusEnvelope(
  body,
  { expectedEnvironment, expectedStatus },
) {
  const envelope = exactRecord(body, ["data"], "INVALID_STATUS_ENVELOPE");
  const data = exactRecord(
    envelope.data,
    ["status", "environment", "buildId"],
    "INVALID_STATUS_RESPONSE",
  );
  if (
    data.status !== expectedStatus ||
    data.environment !== expectedEnvironment ||
    typeof data.buildId !== "string" ||
    !BUILD_SHA.test(data.buildId)
  ) {
    fail("STATUS_IDENTITY_MISMATCH");
  }
  return data.buildId;
}

export async function probeStatusEndpoint(
  fetchImpl,
  url,
  expected,
  { timeoutMs = PUBLIC_PROBE_TIMEOUT_MS } = {},
) {
  if (typeof fetchImpl !== "function") fail("INVALID_FETCH_IMPLEMENTATION");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail("INVALID_PROBE_TIMEOUT");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!(response instanceof Response)) fail("INVALID_FETCH_RESPONSE");
    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    const bytes = await readBoundedProbeResponse(response);
    if (response.status !== 200 || mediaType !== "application/json") {
      fail("STATUS_REQUEST_FAILED");
    }
    return validatePublicStatusEnvelope(parseJson(bytes), expected);
  } catch (error) {
    if (error instanceof PublicProbeError) throw error;
    if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
    fail("NETWORK_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

export async function runPublicProbeAttempt(
  configuration,
  { fetchImpl, timeoutMs = PUBLIC_PROBE_TIMEOUT_MS },
) {
  const [healthBuild, readinessBuild] = await Promise.all([
    probeStatusEndpoint(
      fetchImpl,
      `${configuration.baseUrl}/api/health`,
      {
        expectedEnvironment: configuration.expectedEnvironment,
        expectedStatus: "ok",
      },
      { timeoutMs },
    ),
    probeStatusEndpoint(
      fetchImpl,
      `${configuration.baseUrl}/api/readiness`,
      {
        expectedEnvironment: configuration.expectedEnvironment,
        expectedStatus: "ready",
      },
      { timeoutMs },
    ),
  ]);
  if (healthBuild !== readinessBuild) fail("STATUS_BUILD_MISMATCH");
  return healthBuild;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runPublicStatusProbe(
  configuration,
  {
    fetchImpl,
    waitImpl = wait,
    timeoutMs = PUBLIC_PROBE_TIMEOUT_MS,
    retryDelayMs = PUBLIC_PROBE_RETRY_DELAY_MS,
  },
) {
  if (typeof waitImpl !== "function") fail("INVALID_WAIT_IMPLEMENTATION");
  if (
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > 60_000
  ) {
    fail("INVALID_RETRY_DELAY");
  }

  try {
    return await runPublicProbeAttempt(configuration, { fetchImpl, timeoutMs });
  } catch (error) {
    if (!(error instanceof PublicProbeError)) fail("PUBLIC_PROBE_FAILED");
  }

  await waitImpl(retryDelayMs);
  return runPublicProbeAttempt(configuration, { fetchImpl, timeoutMs });
}

export function safePublicProbeErrorCode(error) {
  return error instanceof PublicProbeError ? error.code : "PUBLIC_PROBE_FAILED";
}

async function main() {
  const configuration = parsePublicProbeEnvironment(process.env);
  const buildId = await runPublicStatusProbe(configuration, {
    fetchImpl: globalThis.fetch,
  });
  process.stdout.write(
    `Public status probe passed for ${configuration.expectedEnvironment} build ${buildId}.\n`,
  );
}

function isDirectExecution() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(
      `Public status probe failed [${safePublicProbeErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
