import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";

/* global AbortController, Response, clearTimeout, setTimeout */

export const FIRELIGHT_BOARD_FQBN = "arduino:avr:nano:cpu=atmega328old";
export const MAX_JSON_RESPONSE_BYTES = 256 * 1024;

const PROBE_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 15_000;
const COMPILE_TIMEOUT_MS = 55_000;
const MAX_AUTH_RESPONSE_BYTES = 128 * 1024;
const MAX_INTEL_HEX_BYTES = 128 * 1024;
const MAX_NANO_APPLICATION_BYTES = 30_720;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const LOWERCASE_BUILD_SHA = /^[0-9a-f]{40}$/;
const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const LESSON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const SAFE_REMOTE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_BOOTSTRAP_PROGRESS_RECORDS = 256;
const ENVIRONMENT_BASE_URLS = Object.freeze({
  staging: "https://staging.firelight.ie",
  production: "https://firelight.ie",
});
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export class CanaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "CanaryError";
    this.code = SAFE_REMOTE_ERROR_CODE.test(code) ? code : "CANARY_FAILED";
  }
}

function fail(code) {
  throw new CanaryError(code);
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
  return value;
}

function requiredString(environment, name, { maximum = 4096, trim = false } = {}) {
  const raw = environment[name];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maximum) {
    fail(`INVALID_${name}`);
  }
  if (trim && raw.trim() !== raw) fail(`INVALID_${name}`);
  return raw;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function parsePostdeployEnvironment(environment) {
  const rawBaseUrl = requiredString(environment, "FIRELIGHT_BASE_URL", {
    maximum: 2048,
    trim: true,
  });
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    fail("INVALID_FIRELIGHT_BASE_URL");
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.port !== "" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    rawBaseUrl !== baseUrl.origin
  ) {
    fail("INVALID_FIRELIGHT_BASE_URL");
  }

  const expectedEnvironment = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_ENVIRONMENT",
    { maximum: 10, trim: true },
  );
  if (expectedEnvironment !== "staging" && expectedEnvironment !== "production") {
    fail("INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT");
  }
  if (baseUrl.origin !== ENVIRONMENT_BASE_URLS[expectedEnvironment]) {
    fail("FIRELIGHT_BASE_URL_MISMATCH");
  }

  const expectedBuildId = requiredString(environment, "FIRELIGHT_EXPECTED_BUILD_ID", {
    maximum: 40,
    trim: true,
  });
  if (!LOWERCASE_BUILD_SHA.test(expectedBuildId)) {
    fail("INVALID_FIRELIGHT_EXPECTED_BUILD_ID");
  }

  const expectedSupabaseProjectRef = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_SUPABASE_PROJECT_REF",
    { maximum: 20, trim: true },
  );
  if (!PROJECT_REF.test(expectedSupabaseProjectRef)) {
    fail("INVALID_FIRELIGHT_EXPECTED_SUPABASE_PROJECT_REF");
  }

  const email = requiredString(environment, "FIRELIGHT_CANARY_EMAIL", {
    maximum: 320,
    trim: true,
  });
  if (!email.includes("@") || hasControlCharacter(email)) {
    fail("INVALID_FIRELIGHT_CANARY_EMAIL");
  }
  const password = requiredString(environment, "FIRELIGHT_CANARY_PASSWORD", {
    maximum: 1024,
  });
  const defaultRepositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const configuredRepositoryRoot = environment.FIRELIGHT_CANARY_REPOSITORY_ROOT;
  let repositoryRoot = defaultRepositoryRoot;
  if (configuredRepositoryRoot !== undefined) {
    repositoryRoot = requiredString(environment, "FIRELIGHT_CANARY_REPOSITORY_ROOT", {
      maximum: 4096,
      trim: true,
    });
    if (
      !isAbsolute(repositoryRoot) ||
      resolve(repositoryRoot) !== repositoryRoot ||
      repositoryRoot.includes("\0")
    ) {
      fail("INVALID_FIRELIGHT_CANARY_REPOSITORY_ROOT");
    }
  }

  return {
    baseUrl: baseUrl.origin,
    expectedEnvironment,
    expectedBuildId,
    expectedSupabaseProjectRef,
    email,
    password,
    repositoryRoot,
  };
}

async function cancelQuietly(reader) {
  try {
    await reader.cancel();
  } catch {
    // The deadline may already have closed the stream.
  }
}

export async function readBoundedBytes(response, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("INVALID_RESPONSE_LIMIT");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes) {
      await response.body?.cancel();
      fail("RESPONSE_TOO_LARGE");
    }
  }
  if (response.body === null) return new Uint8Array();

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
        await cancelQuietly(reader);
        fail("RESPONSE_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function parseJsonBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    fail("INVALID_JSON_RESPONSE");
  }
  try {
    return JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    fail("INVALID_JSON_RESPONSE");
  }
}

function remoteErrorCode(body) {
  if (
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.code === "string" &&
    SAFE_REMOTE_ERROR_CODE.test(body.error.code)
  ) {
    return body.error.code;
  }
  return "REMOTE_REQUEST_FAILED";
}

function forwardAbort(source, destination) {
  if (source === undefined) return () => {};
  if (source.aborted) {
    destination.abort();
    return () => {};
  }
  const abort = () => destination.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export async function fetchBounded(
  fetchImpl,
  input,
  init = {},
  { timeoutMs, maximumBytes },
) {
  if (typeof fetchImpl !== "function") fail("INVALID_FETCH_IMPLEMENTATION");
  const controller = new AbortController();
  const stopForwarding = forwardAbort(init.signal, controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!(response instanceof Response)) fail("INVALID_FETCH_RESPONSE");
    const bytes = await readBoundedBytes(response, maximumBytes);
    return { response, bytes };
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
    fail("NETWORK_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
    stopForwarding();
  }
}

export async function requestJson(
  fetchImpl,
  input,
  init = {},
  options = {},
) {
  const { response, bytes } = await fetchBounded(fetchImpl, input, init, {
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maximumBytes: options.maximumBytes ?? MAX_JSON_RESPONSE_BYTES,
  });
  const body = parseJsonBytes(bytes);
  if (!response.ok) fail(remoteErrorCode(body));
  return body;
}

export function parseDataEnvelope(body, code = "INVALID_DATA_ENVELOPE") {
  const envelope = exactKeys(body, ["data"], code);
  return envelope.data;
}

export function validateStatusProbe(body, expected, status) {
  const data = exactKeys(
    parseDataEnvelope(body, "INVALID_STATUS_ENVELOPE"),
    ["status", "environment", "buildId"],
    "INVALID_STATUS_RESPONSE",
  );
  if (
    data.status !== status ||
    data.environment !== expected.expectedEnvironment ||
    data.buildId !== expected.expectedBuildId
  ) {
    fail("STATUS_IDENTITY_MISMATCH");
  }
  return data;
}

function validateSupabaseUrl(rawUrl, projectRef) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) {
    fail("INVALID_SUPABASE_URL");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("INVALID_SUPABASE_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${projectRef}.supabase.co` ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail("SUPABASE_PROJECT_MISMATCH");
  }
  return url.origin;
}

export function validateRuntimeConfig(body, expected) {
  const data = exactKeys(
    parseDataEnvelope(body, "INVALID_CONFIG_ENVELOPE"),
    ["apiVersion", "environment", "buildId", "supabase", "hardware"],
    "INVALID_CONFIG_RESPONSE",
  );
  const supabase = exactKeys(
    data.supabase,
    ["url", "publishableKey"],
    "INVALID_CONFIG_RESPONSE",
  );
  const hardware = exactKeys(
    data.hardware,
    ["fqbn", "uploadBaud"],
    "INVALID_CONFIG_RESPONSE",
  );
  if (
    data.apiVersion !== "v1" ||
    data.environment !== expected.expectedEnvironment ||
    data.buildId !== expected.expectedBuildId ||
    hardware.fqbn !== FIRELIGHT_BOARD_FQBN ||
    hardware.uploadBaud !== 57_600
  ) {
    fail("CONFIG_IDENTITY_MISMATCH");
  }
  const supabaseUrl = validateSupabaseUrl(
    supabase.url,
    expected.expectedSupabaseProjectRef,
  );
  if (
    typeof supabase.publishableKey !== "string" ||
    supabase.publishableKey.length < 20 ||
    supabase.publishableKey.length > 2048 ||
    supabase.publishableKey.trim() !== supabase.publishableKey ||
    /\s/u.test(supabase.publishableKey)
  ) {
    fail("INVALID_SUPABASE_PUBLISHABLE_KEY");
  }
  return { supabaseUrl, publishableKey: supabase.publishableKey };
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    maximumDay !== undefined &&
    day >= 1 &&
    day <= maximumDay &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
}

export function validateBootstrap(body, authenticatedIdentity) {
  if (
    !isRecord(authenticatedIdentity) ||
    typeof authenticatedIdentity.userId !== "string" ||
    !LOWERCASE_UUID_V4.test(authenticatedIdentity.userId) ||
    typeof authenticatedIdentity.email !== "string" ||
    authenticatedIdentity.email.length === 0 ||
    authenticatedIdentity.email.length > 320
  ) {
    fail("CANARY_AUTH_IDENTITY_INVALID");
  }
  const data = exactKeys(
    parseDataEnvelope(body, "INVALID_BOOTSTRAP_ENVELOPE"),
    ["profile", "activation", "progress", "achievements", "nextLesson"],
    "INVALID_BOOTSTRAP_RESPONSE",
  );
  const profile = exactKeys(
    data.profile,
    ["id", "displayName", "role", "email", "emailConfirmed", "createdAt", "updatedAt"],
    "INVALID_BOOTSTRAP_PROFILE",
  );
  if (
    typeof profile.id !== "string" ||
    !LOWERCASE_UUID_V4.test(profile.id) ||
    profile.id !== authenticatedIdentity.userId ||
    typeof profile.displayName !== "string" ||
    profile.displayName.length === 0 ||
    profile.displayName.length > 80 ||
    profile.role !== "learner" ||
    typeof profile.email !== "string" ||
    profile.email.length === 0 ||
    profile.email.length > 320 ||
    profile.email.toLowerCase() !== authenticatedIdentity.email.toLowerCase() ||
    profile.emailConfirmed !== true ||
    !validTimestamp(profile.createdAt) ||
    !validTimestamp(profile.updatedAt)
  ) {
    fail("CANARY_PROFILE_NOT_CONFIRMED");
  }
  const activation = exactKeys(
    data.activation,
    ["id", "batch", "kind", "claimedAt"],
    "CANARY_ACTIVATION_REQUIRED",
  );
  if (
    typeof activation.id !== "string" ||
    !LOWERCASE_UUID_V4.test(activation.id) ||
    typeof activation.batch !== "string" ||
    activation.batch.length === 0 ||
    activation.batch.length > 80 ||
    (activation.kind !== "code" && activation.kind !== "grandfathered") ||
    !validTimestamp(activation.claimedAt) ||
    !Array.isArray(data.progress) ||
    !Array.isArray(data.achievements) ||
    (data.nextLesson !== null && !isRecord(data.nextLesson))
  ) {
    fail("CANARY_ACTIVATION_REQUIRED");
  }
  return { profileId: profile.id, activationId: activation.id };
}

function validateCanaryProgressRecord(
  value,
  expectedLesson,
  errorCode = "INVALID_BOOTSTRAP_PROGRESS",
) {
  const progress = exactKeys(
    value,
    [
      "lessonId",
      "lessonVersion",
      "revision",
      "status",
      "currentStep",
      "percentage",
      "codeSnapshot",
      "completionEvidenceId",
      "completedAt",
      "updatedAt",
    ],
    errorCode,
  );
  const codeSnapshotBytes = typeof progress.codeSnapshot === "string"
    ? TEXT_ENCODER.encode(progress.codeSnapshot).byteLength
    : 0;
  const validState =
    (progress.status === "not_started" && progress.percentage === 0) ||
    (
      progress.status === "in_progress" &&
      Number.isSafeInteger(progress.percentage) &&
      progress.percentage >= 0 &&
      progress.percentage < 100
    ) ||
    (progress.status === "completed" && progress.percentage === 100);
  const validCompletion = progress.status === "completed"
    ? (
        typeof progress.codeSnapshot === "string" &&
        progress.codeSnapshot.length > 0 &&
        typeof progress.completionEvidenceId === "string" &&
        LOWERCASE_UUID_V4.test(progress.completionEvidenceId) &&
        validTimestamp(progress.completedAt)
      )
    : progress.completionEvidenceId === null && progress.completedAt === null;
  if (
    progress.lessonId !== expectedLesson.id ||
    typeof progress.lessonId !== "string" ||
    !LESSON_SLUG.test(progress.lessonId) ||
    progress.lessonVersion !== expectedLesson.version ||
    !Number.isSafeInteger(progress.revision) ||
    progress.revision < 1 ||
    progress.revision >= Number.MAX_SAFE_INTEGER ||
    typeof progress.currentStep !== "string" ||
    progress.currentStep.length === 0 ||
    progress.currentStep.length > 100 ||
    !STEP_ID.test(progress.currentStep) ||
    !Number.isSafeInteger(progress.percentage) ||
    (progress.codeSnapshot !== null && typeof progress.codeSnapshot !== "string") ||
    codeSnapshotBytes > 65_536 ||
    !validState ||
    !validCompletion ||
    !validTimestamp(progress.updatedAt)
  ) {
    fail(errorCode);
  }
  return progress;
}

export function buildFirstSparkProgressReplay(body, lessonValue) {
  const lesson = validateFirstSparkLesson(lessonValue);
  const data = exactKeys(
    parseDataEnvelope(body, "INVALID_BOOTSTRAP_ENVELOPE"),
    ["profile", "activation", "progress", "achievements", "nextLesson"],
    "INVALID_BOOTSTRAP_RESPONSE",
  );
  if (
    !Array.isArray(data.progress) ||
    data.progress.length > MAX_BOOTSTRAP_PROGRESS_RECORDS
  ) {
    fail("INVALID_BOOTSTRAP_PROGRESS");
  }
  const firstSparkEntries = data.progress.filter(
    (entry) =>
      isRecord(entry) &&
      entry.lessonId === lesson.id,
  );
  if (firstSparkEntries.some(
    (entry) => !Number.isSafeInteger(entry.lessonVersion) || entry.lessonVersion < 1,
  )) {
    fail("INVALID_BOOTSTRAP_PROGRESS");
  }
  const matches = firstSparkEntries.filter(
    (entry) => entry.lessonVersion === lesson.version,
  );
  if (matches.length > 1) fail("INVALID_BOOTSTRAP_PROGRESS");
  if (matches.length === 0) {
    return {
      request: {
        lessonVersion: lesson.version,
        expectedRevision: null,
        status: "not_started",
        currentStep: "meet-the-build",
        percentage: 0,
      },
      previous: null,
    };
  }

  const previous = validateCanaryProgressRecord(matches[0], lesson);
  const request = {
    lessonVersion: previous.lessonVersion,
    expectedRevision: previous.revision,
    status: previous.status,
    currentStep: previous.currentStep,
    percentage: previous.percentage,
    ...(previous.status === "completed"
      ? {
          codeSnapshot: previous.codeSnapshot,
          uploadEvidenceId: previous.completionEvidenceId,
        }
      : {}),
  };
  return { request, previous };
}

export function validateFirstSparkProgressResponse(body, replay) {
  if (
    !isRecord(replay) ||
    !isRecord(replay.request) ||
    (replay.previous !== null && !isRecord(replay.previous))
  ) {
    fail("INVALID_PROGRESS_RESPONSE");
  }
  const expectedLesson = {
    id: "first-spark",
    version: replay.request.lessonVersion,
  };
  const progress = validateCanaryProgressRecord(
    parseDataEnvelope(body, "INVALID_PROGRESS_ENVELOPE"),
    expectedLesson,
    "INVALID_PROGRESS_RESPONSE",
  );
  const previous = replay.previous;
  const expectedRevision = (replay.request.expectedRevision ?? 0) + 1;
  const expectedCodeSnapshot = previous === null ? null : previous.codeSnapshot;
  const expectedCompletionEvidence = replay.request.status === "completed"
    ? replay.request.uploadEvidenceId
    : null;
  const expectedCompletedAt = previous === null ? null : previous.completedAt;
  if (
    progress.revision !== expectedRevision ||
    progress.status !== replay.request.status ||
    progress.currentStep !== replay.request.currentStep ||
    progress.percentage !== replay.request.percentage ||
    progress.codeSnapshot !== expectedCodeSnapshot ||
    progress.completionEvidenceId !== expectedCompletionEvidence ||
    progress.completedAt !== expectedCompletedAt ||
    (
      previous !== null &&
      Date.parse(progress.updatedAt) < Date.parse(previous.updatedAt)
    )
  ) {
    fail("INVALID_PROGRESS_RESPONSE");
  }
  return { revision: progress.revision, updatedAt: progress.updatedAt };
}

export function sha256Hex(value) {
  if (typeof value !== "string") fail("INVALID_HASH_INPUT");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeIntelHexRecord(line) {
  if (!/^:(?:[0-9A-Fa-f]{2}){5,}$/u.test(line) || (line.length - 1) % 2 !== 0) {
    fail("INVALID_COMPILE_ARTIFACT");
  }
  const bytes = new Uint8Array((line.length - 1) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(line.slice(index * 2 + 1, index * 2 + 3), 16);
  }
  if (bytes.length !== (bytes[0] ?? 0) + 5) fail("INVALID_COMPILE_ARTIFACT");
  let checksum = 0;
  for (const byte of bytes) checksum = (checksum + byte) & 0xff;
  if (checksum !== 0) fail("INVALID_COMPILE_ARTIFACT");
  return bytes;
}

export function validateIntelHex(hex) {
  if (
    typeof hex !== "string" ||
    hex.length === 0 ||
    TEXT_ENCODER.encode(hex).byteLength > MAX_INTEL_HEX_BYTES
  ) {
    fail("INVALID_COMPILE_ARTIFACT");
  }
  const occupied = new Set();
  let addressBase = 0;
  let eofSeen = false;
  let dataBytes = 0;
  let startsAtResetVector = false;
  for (const rawLine of hex.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line !== rawLine || eofSeen) fail("INVALID_COMPILE_ARTIFACT");
    const record = decodeIntelHexRecord(line);
    const byteCount = record[0] ?? 0;
    const address = ((record[1] ?? 0) << 8) | (record[2] ?? 0);
    const recordType = record[3] ?? -1;
    const data = record.slice(4, 4 + byteCount);
    if (recordType === 0) {
      const start = addressBase + address;
      const end = start + data.length;
      if (data.length === 0 || end > MAX_NANO_APPLICATION_BYTES) {
        fail("INVALID_COMPILE_ARTIFACT");
      }
      if (start === 0) startsAtResetVector = true;
      for (let cursor = start; cursor < end; cursor += 1) {
        if (occupied.has(cursor)) fail("INVALID_COMPILE_ARTIFACT");
        occupied.add(cursor);
      }
      dataBytes += data.length;
    } else if (recordType === 1) {
      if (address !== 0 || data.length !== 0) fail("INVALID_COMPILE_ARTIFACT");
      eofSeen = true;
    } else if (recordType === 2) {
      if (address !== 0 || data.length !== 2) fail("INVALID_COMPILE_ARTIFACT");
      addressBase = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 4;
    } else if (recordType === 4) {
      if (address !== 0 || data.length !== 2) fail("INVALID_COMPILE_ARTIFACT");
      addressBase = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 16;
    } else if (recordType === 3 || recordType === 5) {
      if (address !== 0 || data.length !== 4) fail("INVALID_COMPILE_ARTIFACT");
    } else {
      fail("INVALID_COMPILE_ARTIFACT");
    }
  }
  if (!eofSeen || dataBytes === 0 || !startsAtResetVector) {
    fail("INVALID_COMPILE_ARTIFACT");
  }
  return { dataBytes };
}

export function validateCompileArtifact(body, source) {
  const artifact = exactKeys(
    parseDataEnvelope(body, "INVALID_COMPILE_ENVELOPE"),
    [
      "compileJobId",
      "format",
      "fqbn",
      "sourceHash",
      "artifactHash",
      "hex",
      "diagnostics",
    ],
    "INVALID_COMPILE_ARTIFACT",
  );
  if (
    typeof artifact.compileJobId !== "string" ||
    !LOWERCASE_UUID_V4.test(artifact.compileJobId) ||
    artifact.format !== "intel-hex" ||
    artifact.fqbn !== FIRELIGHT_BOARD_FQBN ||
    typeof artifact.sourceHash !== "string" ||
    !LOWERCASE_SHA256.test(artifact.sourceHash) ||
    artifact.sourceHash !== sha256Hex(source) ||
    typeof artifact.artifactHash !== "string" ||
    !LOWERCASE_SHA256.test(artifact.artifactHash) ||
    typeof artifact.hex !== "string" ||
    artifact.artifactHash !== sha256Hex(artifact.hex) ||
    !Array.isArray(artifact.diagnostics) ||
    artifact.diagnostics.length > 16
  ) {
    fail("INVALID_COMPILE_ARTIFACT");
  }
  let diagnosticBytes = 0;
  for (const diagnostic of artifact.diagnostics) {
    if (typeof diagnostic !== "string" || Array.from(diagnostic).length > 512) {
      fail("INVALID_COMPILE_ARTIFACT");
    }
    diagnosticBytes += TEXT_ENCODER.encode(diagnostic).byteLength;
  }
  if (diagnosticBytes > 8 * 1024) fail("INVALID_COMPILE_ARTIFACT");
  const image = validateIntelHex(artifact.hex);
  return { compileJobId: artifact.compileJobId, dataBytes: image.dataBytes };
}

export function validateFirstSparkLesson(value) {
  if (
    !isRecord(value) ||
    value.id !== "first-spark" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.starterCode !== "string" ||
    value.starterCode.length === 0 ||
    TEXT_ENCODER.encode(value.starterCode).byteLength > 65_536
  ) {
    fail("FIRST_SPARK_LESSON_INVALID");
  }
  return {
    id: value.id,
    version: value.version,
    starterCode: value.starterCode,
  };
}

export async function loadFirstSparkLesson(repositoryRoot) {
  const { createServer } = await import("vite");
  if (
    typeof repositoryRoot !== "string" ||
    !isAbsolute(repositoryRoot) ||
    resolve(repositoryRoot) !== repositoryRoot
  ) {
    fail("FIRST_SPARK_LESSON_INVALID");
  }
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const catalogModule = await server.ssrLoadModule("/src/features/lessons/catalog.ts");
    if (!Array.isArray(catalogModule.lessonCatalog)) {
      fail("FIRST_SPARK_LESSON_INVALID");
    }
    return validateFirstSparkLesson(
      catalogModule.lessonCatalog.find((lesson) => lesson?.id === "first-spark"),
    );
  } finally {
    await server.close();
  }
}

export function makeSupabaseFetch(fetchImpl) {
  return async (input, init = {}) => {
    const { response, bytes } = await fetchBounded(fetchImpl, input, init, {
      timeoutMs: AUTH_TIMEOUT_MS,
      maximumBytes: MAX_AUTH_RESPONSE_BYTES,
    });
    const body = response.status === 204 || response.status === 205 || response.status === 304
      ? null
      : bytes;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function validateSession(result, expectedEmail) {
  if (
    !isRecord(result) ||
    result.error !== null ||
    !isRecord(result.data) ||
    !isRecord(result.data.session) ||
    !isRecord(result.data.user) ||
    typeof result.data.session.access_token !== "string" ||
    result.data.session.access_token.length < 20 ||
    result.data.session.access_token.length > 8192 ||
    typeof result.data.user.id !== "string" ||
    !LOWERCASE_UUID_V4.test(result.data.user.id) ||
    typeof result.data.user.email !== "string" ||
    result.data.user.email.length === 0 ||
    result.data.user.email.length > 320 ||
    result.data.user.email.toLowerCase() !== expectedEmail.toLowerCase()
  ) {
    fail("CANARY_SIGN_IN_FAILED");
  }
  return {
    accessToken: result.data.session.access_token,
    userId: result.data.user.id,
    email: result.data.user.email,
  };
}

async function globallySignOut(client) {
  try {
    const result = await client.auth.signOut({ scope: "global" });
    if (!isRecord(result) || result.error !== null) fail("CANARY_SIGN_OUT_FAILED");
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    fail("CANARY_SIGN_OUT_FAILED");
  }
}

export async function runPostdeployCanary(
  configuration,
  { fetchImpl, createClientImpl, loadLessonImpl = loadFirstSparkLesson },
) {
  const health = await requestJson(fetchImpl, `${configuration.baseUrl}/api/health`);
  validateStatusProbe(health, configuration, "ok");

  const readiness = await requestJson(fetchImpl, `${configuration.baseUrl}/api/readiness`);
  validateStatusProbe(readiness, configuration, "ready");

  const configBody = await requestJson(fetchImpl, `${configuration.baseUrl}/api/config`);
  const publicConfig = validateRuntimeConfig(configBody, configuration);
  const lesson = validateFirstSparkLesson(
    await loadLessonImpl(configuration.repositoryRoot),
  );

  let client;
  let failure;
  let result;
  try {
    client = createClientImpl(publicConfig.supabaseUrl, publicConfig.publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
      global: { fetch: makeSupabaseFetch(fetchImpl) },
    });
    if (!isRecord(client) || !isRecord(client.auth)) fail("CANARY_AUTH_CLIENT_INVALID");

    const signIn = await client.auth.signInWithPassword({
      email: configuration.email,
      password: configuration.password,
    });
    const authenticatedIdentity = validateSession(signIn, configuration.email);
    const authorization = `Bearer ${authenticatedIdentity.accessToken}`;

    const bootstrap = await requestJson(
      fetchImpl,
      `${configuration.baseUrl}/api/bootstrap`,
      { headers: { Accept: "application/json", Authorization: authorization } },
      { timeoutMs: AUTH_TIMEOUT_MS },
    );
    validateBootstrap(bootstrap, authenticatedIdentity);
    const progressReplay = buildFirstSparkProgressReplay(bootstrap, lesson);

    const progress = await requestJson(
      fetchImpl,
      `${configuration.baseUrl}/api/lessons/${lesson.id}/progress`,
      {
        method: "PUT",
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(progressReplay.request),
      },
      { timeoutMs: AUTH_TIMEOUT_MS, maximumBytes: MAX_JSON_RESPONSE_BYTES },
    );
    const savedProgress = validateFirstSparkProgressResponse(progress, progressReplay);

    const compile = await requestJson(
      fetchImpl,
      `${configuration.baseUrl}/api/compile`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          lessonId: lesson.id,
          lessonVersion: lesson.version,
          fqbn: FIRELIGHT_BOARD_FQBN,
          source: lesson.starterCode,
        }),
      },
      { timeoutMs: COMPILE_TIMEOUT_MS, maximumBytes: MAX_JSON_RESPONSE_BYTES },
    );
    result = {
      ...validateCompileArtifact(compile, lesson.starterCode),
      progressRevision: savedProgress.revision,
    };
  } catch (error) {
    failure = error instanceof CanaryError ? error : new CanaryError("CANARY_FAILED");
  } finally {
    if (client !== undefined) {
      try {
        await globallySignOut(client);
      } catch (error) {
        if (failure === undefined) {
          failure = error instanceof CanaryError
            ? error
            : new CanaryError("CANARY_SIGN_OUT_FAILED");
        }
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) fail("CANARY_FAILED");
  return {
    environment: configuration.expectedEnvironment,
    buildId: configuration.expectedBuildId,
    compileJobId: result.compileJobId,
    progressRevision: result.progressRevision,
  };
}

export function safeCanaryErrorCode(error) {
  return error instanceof CanaryError ? error.code : "CANARY_FAILED";
}

async function main() {
  const configuration = parsePostdeployEnvironment(process.env);
  const { createClient } = await import("@supabase/supabase-js");
  const result = await runPostdeployCanary(configuration, {
    fetchImpl: globalThis.fetch,
    createClientImpl: createClient,
  });
  process.stdout.write(
    `Postdeploy canary passed for ${result.environment} build ${result.buildId}; progress revision ${result.progressRevision}; compile job ${result.compileJobId}.\n`,
  );
}

function isDirectExecution() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`Postdeploy canary failed [${safeCanaryErrorCode(error)}].\n`);
    process.exitCode = 1;
  });
}
