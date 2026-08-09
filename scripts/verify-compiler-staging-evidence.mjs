import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { TextDecoder } from "node:util";
import {
  CANONICAL_REPOSITORY,
  COMPILER_STAGING_EVIDENCE_FILENAME,
  COMPILER_WORKFLOW_PATH,
  serializeCompilerStagingEvidence,
  sha256,
  validateCompilerStagingEvidence,
} from "./capture-compiler-staging-evidence.mjs";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  readBoundedBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

/* global AbortController, Response, clearTimeout, setTimeout */

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECT_RESPONSE_BYTES = 16 * 1024;
const MAX_ARTIFACT_ARCHIVE_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const BUILD_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const AZURE_ARTIFACT_HOST = /^[a-z0-9]{3,63}\.blob\.core\.windows\.net$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const WORKFLOW_PATH_ON_MAIN = `${COMPILER_WORKFLOW_PATH}@main`;
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_SERVER_URL = "https://github.com";
const GITHUB_API_VERSION = "2026-03-10";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;

function fail(code) {
  throw new CanaryError(code);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredString(environment, name, maximum = 4096) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    fail(`INVALID_${name}`);
  }
  return value;
}

function requireExact(environment, name, expected) {
  if (requiredString(environment, name, expected.length) !== expected) {
    fail(`INVALID_${name}`);
  }
}

function parsePositiveInteger(environment, name) {
  const raw = requiredString(environment, name, 16);
  if (!POSITIVE_INTEGER.test(raw)) fail(`INVALID_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`INVALID_${name}`);
  return value;
}

function artifactName(runId, runAttempt) {
  return `compiler-staging-evidence-${String(runId)}-${String(runAttempt)}`;
}

export function parseCompilerStagingVerificationEnvironment(environment) {
  requireExact(environment, "GITHUB_ACTIONS", "true");
  requireExact(environment, "GITHUB_SERVER_URL", GITHUB_SERVER_URL);
  requireExact(environment, "GITHUB_API_URL", GITHUB_API_URL);
  requireExact(environment, "GITHUB_EVENT_NAME", "workflow_dispatch");
  requireExact(environment, "GITHUB_REPOSITORY", CANONICAL_REPOSITORY);
  requireExact(environment, "GITHUB_REF", "refs/heads/main");
  requireExact(
    environment,
    "GITHUB_WORKFLOW_REF",
    `${CANONICAL_REPOSITORY}/${COMPILER_WORKFLOW_PATH}@refs/heads/main`,
  );
  requireExact(environment, "FIRELIGHT_COMPILER_ENVIRONMENT", "production");

  const commitSha = requiredString(environment, "GITHUB_SHA", 40);
  if (!BUILD_SHA.test(commitSha)) fail("INVALID_GITHUB_SHA");
  const workflowSha = requiredString(environment, "GITHUB_WORKFLOW_SHA", 40);
  if (!BUILD_SHA.test(workflowSha) || workflowSha !== commitSha) {
    fail("INVALID_GITHUB_WORKFLOW_SHA");
  }
  const token = requiredString(environment, "GITHUB_TOKEN", 4096);
  if (/\s/u.test(token)) fail("INVALID_GITHUB_TOKEN");
  const expectedRunId = parsePositiveInteger(
    environment,
    "FIRELIGHT_COMPILER_STAGING_RUN_ID",
  );
  const expectedEvidenceSha256 = requiredString(
    environment,
    "FIRELIGHT_COMPILER_STAGING_EVIDENCE_SHA256",
    64,
  );
  if (!SHA256.test(expectedEvidenceSha256)) {
    fail("INVALID_FIRELIGHT_COMPILER_STAGING_EVIDENCE_SHA256");
  }

  return {
    apiUrl: GITHUB_API_URL,
    owner: "jambrike",
    repository: "firelight",
    token,
    commitSha,
    expectedRunId,
    expectedEvidenceSha256,
  };
}

export function buildCompilerWorkflowRunUrl(configuration) {
  return `${configuration.apiUrl}/repos/${configuration.owner}/${configuration.repository}/actions/runs/${String(configuration.expectedRunId)}`;
}

export function buildCompilerRunArtifactsUrl(configuration, run) {
  const url = new URL(
    `${configuration.apiUrl}/repos/${configuration.owner}/${configuration.repository}/actions/runs/${String(run.runId)}/artifacts`,
  );
  url.searchParams.set("name", run.artifactName);
  url.searchParams.set("per_page", "2");
  return url.href;
}

export function buildCompilerArtifactDownloadUrl(configuration, artifactId) {
  return `${configuration.apiUrl}/repos/${configuration.owner}/${configuration.repository}/actions/artifacts/${String(artifactId)}/zip`;
}

function isMatchingRun(run, configuration) {
  return (
    isRecord(run) &&
    run.id === configuration.expectedRunId &&
    run.head_sha === configuration.commitSha &&
    run.head_branch === "main" &&
    run.event === "workflow_dispatch" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    (run.path === COMPILER_WORKFLOW_PATH ||
      run.path === WORKFLOW_PATH_ON_MAIN) &&
    isRecord(run.repository) &&
    run.repository.full_name === CANONICAL_REPOSITORY &&
    Number.isSafeInteger(run.repository.id) &&
    run.repository.id > 0 &&
    Number.isSafeInteger(run.run_number) &&
    run.run_number > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  );
}

export function parseCompilerWorkflowRun(body, configuration) {
  if (!isMatchingRun(body, configuration)) {
    fail("COMPILER_STAGING_RUN_MISMATCH");
  }
  return {
    runId: body.id,
    runNumber: body.run_number,
    runAttempt: body.run_attempt,
    commitSha: body.head_sha,
    repositoryId: body.repository.id,
    artifactName: artifactName(body.id, body.run_attempt),
  };
}

function isExpectedApiUrl(raw, expected) {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return url.href === expected;
  } catch {
    return false;
  }
}

export function parseCompilerStagingArtifact(body, configuration, run) {
  if (
    !isRecord(body) ||
    !Number.isSafeInteger(body.total_count) ||
    body.total_count < 0 ||
    !Array.isArray(body.artifacts) ||
    body.artifacts.length > 2
  ) {
    fail("INVALID_GITHUB_ARTIFACTS_RESPONSE");
  }
  if (body.total_count === 0 && body.artifacts.length === 0) {
    fail("COMPILER_STAGING_ARTIFACT_NOT_FOUND");
  }
  if (body.total_count !== 1 || body.artifacts.length !== 1) {
    fail("COMPILER_STAGING_ARTIFACT_NOT_UNIQUE");
  }
  const artifact = body.artifacts[0];
  if (
    !isRecord(artifact) ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    artifact.name !== run.artifactName ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_ARTIFACT_ARCHIVE_BYTES ||
    artifact.expired !== false ||
    typeof artifact.digest !== "string" ||
    !ARTIFACT_DIGEST.test(artifact.digest) ||
    !isExpectedApiUrl(
      artifact.archive_download_url,
      buildCompilerArtifactDownloadUrl(configuration, artifact.id),
    ) ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== run.runId ||
    artifact.workflow_run.repository_id !== run.repositoryId ||
    artifact.workflow_run.head_repository_id !== run.repositoryId ||
    artifact.workflow_run.head_branch !== "main" ||
    artifact.workflow_run.head_sha !== configuration.commitSha
  ) {
    fail("COMPILER_STAGING_ARTIFACT_MISMATCH");
  }
  return {
    artifactId: artifact.id,
    archiveSha256: artifact.digest.slice("sha256:".length),
    sizeInBytes: artifact.size_in_bytes,
    downloadUrl: buildCompilerArtifactDownloadUrl(configuration, artifact.id),
  };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "firelight-compiler-staging-evidence",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

function githubErrorCode(response, notFoundCode) {
  if (response.status === 401 || response.status === 403) {
    return "GITHUB_AUTH_FAILED";
  }
  if (response.status === 404) return notFoundCode;
  if (response.status === 410) return "COMPILER_STAGING_ARTIFACT_EXPIRED";
  if (response.status === 429) return "GITHUB_RATE_LIMITED";
  return "GITHUB_API_FAILED";
}

async function requestGithubJson(fetchImpl, url, token, notFoundCode) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: githubHeaders(token),
    },
    {
      timeoutMs: GITHUB_TIMEOUT_MS,
      maximumBytes: MAX_GITHUB_RESPONSE_BYTES,
    },
  );
  if (!response.ok) fail(githubErrorCode(response, notFoundCode));
  return parseJsonBytes(bytes);
}

function validateArtifactRedirect(rawLocation) {
  if (
    typeof rawLocation !== "string" ||
    rawLocation.length === 0 ||
    rawLocation.length > 8192 ||
    rawLocation.trim() !== rawLocation
  ) {
    fail("INVALID_ARTIFACT_REDIRECT");
  }
  let url;
  try {
    url = new URL(rawLocation);
  } catch {
    fail("INVALID_ARTIFACT_REDIRECT");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !AZURE_ARTIFACT_HOST.test(url.hostname) ||
    !url.pathname.startsWith("/actions-results/") ||
    url.search.length < 2
  ) {
    fail("INVALID_ARTIFACT_REDIRECT");
  }
  return url.href;
}

async function requestArtifactRedirect(fetchImpl, url, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: githubHeaders(token),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!(response instanceof Response)) fail("INVALID_FETCH_RESPONSE");
    await readBoundedBytes(response, MAX_REDIRECT_RESPONSE_BYTES);
    if (response.status !== 302) {
      fail(githubErrorCode(response, "COMPILER_STAGING_ARTIFACT_NOT_FOUND"));
    }
    return validateArtifactRedirect(response.headers.get("location"));
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    if (controller.signal.aborted) fail("REQUEST_TIMEOUT");
    fail("NETWORK_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadArtifactArchive(fetchImpl, redirectUrl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    redirectUrl,
    {
      method: "GET",
      headers: {
        Accept: "application/zip",
        "User-Agent": "firelight-compiler-staging-evidence",
      },
    },
    {
      timeoutMs: GITHUB_TIMEOUT_MS,
      maximumBytes: MAX_ARTIFACT_ARCHIVE_BYTES,
    },
  );
  if (!response.ok) fail("COMPILER_STAGING_ARTIFACT_DOWNLOAD_FAILED");
  return bytes;
}

function findEndOfCentralDirectory(archive) {
  if (archive.length < 22) fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  const earliest = Math.max(0, archive.length - 22 - 65_535);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
}

function decodeFilename(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
}

function validateDataDescriptor(archive, offset, centralOffset, expected) {
  const length = centralOffset - offset;
  const hasSignature =
    length === 16 && archive.readUInt32LE(offset) === ZIP_DATA_DESCRIPTOR;
  if (length !== 12 && !hasSignature) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  const dataOffset = offset + (hasSignature ? 4 : 0);
  if (
    archive.readUInt32LE(dataOffset) !== expected.crc32 ||
    archive.readUInt32LE(dataOffset + 4) !== expected.compressedSize ||
    archive.readUInt32LE(dataOffset + 8) !== expected.uncompressedSize
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function extractCompilerStagingEvidenceBytes(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== 1 ||
    entries !== 1 ||
    centralSize < 46 ||
    centralOffset + centralSize !== eocdOffset ||
    centralOffset + 46 > eocdOffset ||
    archive.readUInt32LE(centralOffset) !== ZIP_CENTRAL_DIRECTORY_HEADER
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }

  const flags = archive.readUInt16LE(centralOffset + 8);
  const compression = archive.readUInt16LE(centralOffset + 10);
  const expected = {
    crc32: archive.readUInt32LE(centralOffset + 16),
    compressedSize: archive.readUInt32LE(centralOffset + 20),
    uncompressedSize: archive.readUInt32LE(centralOffset + 24),
  };
  const filenameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const startDisk = archive.readUInt16LE(centralOffset + 34);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const centralEnd =
    centralOffset + 46 + filenameLength + extraLength + commentLength;
  if (
    (flags & ~(ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG)) !== 0 ||
    (compression !== 0 && compression !== 8) ||
    expected.compressedSize < 1 ||
    expected.compressedSize > MAX_ARTIFACT_ARCHIVE_BYTES ||
    expected.uncompressedSize < 1 ||
    expected.uncompressedSize > MAX_EVIDENCE_BYTES ||
    (compression === 0 &&
      expected.compressedSize !== expected.uncompressedSize) ||
    startDisk !== 0 ||
    localOffset !== 0 ||
    centralEnd !== eocdOffset
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  const centralFilename = decodeFilename(
    archive.subarray(centralOffset + 46, centralOffset + 46 + filenameLength),
  );
  if (centralFilename !== COMPILER_STAGING_EVIDENCE_FILENAME) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }

  if (
    archive.length < 30 ||
    archive.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localCompression = archive.readUInt16LE(localOffset + 8);
  const localCrc32 = archive.readUInt32LE(localOffset + 14);
  const localCompressedSize = archive.readUInt32LE(localOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
  const localFilenameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localFilenameLength + localExtraLength;
  const dataEnd = dataOffset + expected.compressedSize;
  if (
    localFlags !== flags ||
    localCompression !== compression ||
    dataOffset > centralOffset ||
    dataEnd > centralOffset ||
    decodeFilename(
      archive.subarray(
        localOffset + 30,
        localOffset + 30 + localFilenameLength,
      ),
    ) !== centralFilename
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  if ((flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0) {
    if (
      dataEnd !== centralOffset ||
      localCrc32 !== expected.crc32 ||
      localCompressedSize !== expected.compressedSize ||
      localUncompressedSize !== expected.uncompressedSize
    ) {
      fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
    }
  } else {
    if (
      (localCrc32 !== 0 && localCrc32 !== expected.crc32) ||
      (localCompressedSize !== 0 &&
        localCompressedSize !== expected.compressedSize) ||
      (localUncompressedSize !== 0 &&
        localUncompressedSize !== expected.uncompressedSize)
    ) {
      fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
    }
    validateDataDescriptor(archive, dataEnd, centralOffset, expected);
  }

  let evidenceBytes;
  try {
    const compressed = archive.subarray(dataOffset, dataEnd);
    evidenceBytes =
      compression === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_EVIDENCE_BYTES });
  } catch {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  if (
    evidenceBytes.byteLength !== expected.uncompressedSize ||
    crc32(evidenceBytes) !== expected.crc32
  ) {
    fail("INVALID_COMPILER_STAGING_ARTIFACT_ZIP");
  }
  return evidenceBytes;
}

export function parseDownloadedCompilerStagingEvidence(
  evidenceBytes,
  configuration,
  run,
) {
  if (sha256(evidenceBytes) !== configuration.expectedEvidenceSha256) {
    fail("COMPILER_STAGING_EVIDENCE_SHA256_MISMATCH");
  }
  let value;
  try {
    value = parseJsonBytes(evidenceBytes);
  } catch {
    fail("COMPILER_STAGING_EVIDENCE_INVALID");
  }
  const evidence = validateCompilerStagingEvidence(value, {
    commitSha: configuration.commitSha,
    runId: run.runId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
    artifactName: run.artifactName,
    awsAccountIdSha256: value.awsAccountIdSha256,
    backendLocationSha256: value.backendLocationSha256,
    stateKmsKeySha256: value.stateKmsKeySha256,
    authSecretSha256: value.authSecretSha256,
    vpcCidrSha256: value.vpcCidrSha256,
  });
  const canonicalBytes = serializeCompilerStagingEvidence(evidence);
  if (!Buffer.from(evidenceBytes).equals(canonicalBytes)) {
    fail("COMPILER_STAGING_EVIDENCE_INVALID");
  }
  return evidence;
}

export async function verifyCompilerStagingEvidence(configuration, fetchImpl) {
  const runsBody = await requestGithubJson(
    fetchImpl,
    buildCompilerWorkflowRunUrl(configuration),
    configuration.token,
    "COMPILER_WORKFLOW_NOT_FOUND",
  );
  const run = parseCompilerWorkflowRun(runsBody, configuration);
  const artifactsBody = await requestGithubJson(
    fetchImpl,
    buildCompilerRunArtifactsUrl(configuration, run),
    configuration.token,
    "COMPILER_STAGING_ARTIFACT_NOT_FOUND",
  );
  const artifact = parseCompilerStagingArtifact(
    artifactsBody,
    configuration,
    run,
  );
  const redirectUrl = await requestArtifactRedirect(
    fetchImpl,
    artifact.downloadUrl,
    configuration.token,
  );
  const archiveBytes = await downloadArtifactArchive(fetchImpl, redirectUrl);
  if (sha256(archiveBytes) !== artifact.archiveSha256) {
    fail("COMPILER_STAGING_ARTIFACT_DIGEST_MISMATCH");
  }
  const evidenceBytes = extractCompilerStagingEvidenceBytes(archiveBytes);
  const evidence = parseDownloadedCompilerStagingEvidence(
    evidenceBytes,
    configuration,
    run,
  );
  return {
    imageDigest: evidence.imageDigest,
    awsAccountIdSha256: evidence.awsAccountIdSha256,
    backendLocationSha256: evidence.backendLocationSha256,
    stateKmsKeySha256: evidence.stateKmsKeySha256,
    authSecretSha256: evidence.authSecretSha256,
    vpcCidrSha256: evidence.vpcCidrSha256,
    runId: run.runId,
    evidenceSha256: configuration.expectedEvidenceSha256,
  };
}

async function main() {
  const configuration = parseCompilerStagingVerificationEnvironment(
    process.env,
  );
  const result = await verifyCompilerStagingEvidence(
    configuration,
    globalThis.fetch,
  );
  process.stdout.write(
    `staging_compiler_image_digest=${result.imageDigest}\n` +
      `staging_compiler_aws_account_id_sha256=${result.awsAccountIdSha256}\n` +
      `staging_compiler_backend_location_sha256=${result.backendLocationSha256}\n` +
      `staging_compiler_state_kms_key_sha256=${result.stateKmsKeySha256}\n` +
      `staging_compiler_auth_secret_sha256=${result.authSecretSha256}\n` +
      `staging_compiler_vpc_cidr_sha256=${result.vpcCidrSha256}\n` +
      `staging_compiler_run_id=${String(result.runId)}\n` +
      `staging_compiler_evidence_sha256=${result.evidenceSha256}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Compiler staging evidence verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
