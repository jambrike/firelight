import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CANONICAL_REPOSITORY,
  WEB_STAGING_EVIDENCE_FILENAME,
  serializeWebStagingEvidence,
  sha256,
  validateWebStagingEvidence,
  webStagingArtifactName,
} from "./capture-web-staging-evidence.mjs";
import {
  CanaryError,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const BUILD_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const PRODUCTION_WORKFLOW_REF =
  `${CANONICAL_REPOSITORY}/.github/workflows/deploy-production.yml@refs/heads/main`;

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

function positiveInteger(environment, name) {
  const raw = requiredString(environment, name, 16);
  if (!POSITIVE_INTEGER.test(raw)) fail(`INVALID_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`INVALID_${name}`);
  return value;
}

export function parseWebStagingVerificationEnvironment(environment) {
  requireExact(environment, "GITHUB_ACTIONS", "true");
  requireExact(environment, "GITHUB_SERVER_URL", "https://github.com");
  requireExact(environment, "GITHUB_API_URL", "https://api.github.com");
  requireExact(environment, "GITHUB_EVENT_NAME", "workflow_dispatch");
  requireExact(environment, "GITHUB_REPOSITORY", CANONICAL_REPOSITORY);
  requireExact(environment, "GITHUB_REF", "refs/heads/main");
  requireExact(environment, "GITHUB_WORKFLOW_REF", PRODUCTION_WORKFLOW_REF);

  const commitSha = requiredString(environment, "GITHUB_SHA", 40);
  if (!BUILD_SHA.test(commitSha)) fail("INVALID_GITHUB_SHA");
  const workflowSha = requiredString(environment, "GITHUB_WORKFLOW_SHA", 40);
  if (!BUILD_SHA.test(workflowSha) || workflowSha !== commitSha) {
    fail("INVALID_GITHUB_WORKFLOW_SHA");
  }
  const expectedEvidenceSha256 = requiredString(
    environment,
    "FIRELIGHT_STAGING_EVIDENCE_SHA256",
    64,
  );
  if (!SHA256.test(expectedEvidenceSha256)) {
    fail("INVALID_FIRELIGHT_STAGING_EVIDENCE_SHA256");
  }
  const runId = positiveInteger(environment, "FIRELIGHT_STAGING_RUN_ID");
  const runNumber = positiveInteger(environment, "FIRELIGHT_STAGING_RUN_NUMBER");
  const runAttempt = positiveInteger(
    environment,
    "FIRELIGHT_STAGING_RUN_ATTEMPT",
  );
  const runnerTemp = requiredString(environment, "RUNNER_TEMP", 4096);
  if (!isAbsolute(runnerTemp) || resolve(runnerTemp) !== runnerTemp) {
    fail("INVALID_RUNNER_TEMP");
  }
  const evidencePath = requiredString(
    environment,
    "FIRELIGHT_WEB_STAGING_EVIDENCE_PATH",
    4096,
  );
  const expectedPath = join(
    runnerTemp,
    "firelight-web-staging-evidence",
    WEB_STAGING_EVIDENCE_FILENAME,
  );
  if (evidencePath !== expectedPath) {
    fail("INVALID_FIRELIGHT_WEB_STAGING_EVIDENCE_PATH");
  }

  return {
    commitSha,
    expectedEvidenceSha256,
    runId,
    runNumber,
    runAttempt,
    artifactName: webStagingArtifactName(runId, runAttempt),
    runnerTemp,
    evidencePath,
  };
}

function equalBytes(left, right) {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

export function parseDownloadedWebStagingEvidence(bytes, configuration) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_EVIDENCE_BYTES) {
    fail("INVALID_WEB_STAGING_EVIDENCE_FILE");
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== configuration.expectedEvidenceSha256) {
    fail("WEB_STAGING_EVIDENCE_HASH_MISMATCH");
  }
  const value = parseJsonBytes(bytes);
  if (!isRecord(value)) fail("WEB_STAGING_EVIDENCE_MISMATCH");
  const evidence = validateWebStagingEvidence(value, {
    commitSha: configuration.commitSha,
    projectIdentitySha256: value.supabaseProjectIdentitySha256,
    projectRefIdentitySha256: value.supabaseProjectRefIdentitySha256,
    organizationIdentitySha256: value.supabaseOrganizationIdentitySha256,
    runId: configuration.runId,
    runNumber: configuration.runNumber,
    runAttempt: configuration.runAttempt,
    artifactName: configuration.artifactName,
  });
  if (!equalBytes(bytes, serializeWebStagingEvidence(evidence))) {
    fail("WEB_STAGING_EVIDENCE_NONCANONICAL");
  }
  return {
    evidence,
    evidenceSha256: actualSha256,
    projectIdentitySha256: evidence.supabaseProjectIdentitySha256,
    projectRefIdentitySha256:
      evidence.supabaseProjectRefIdentitySha256,
    organizationIdentitySha256:
      evidence.supabaseOrganizationIdentitySha256,
  };
}

export async function verifyDownloadedWebStagingEvidence(configuration) {
  let stats;
  let bytes;
  try {
    stats = await lstat(configuration.evidencePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size < 1 ||
      stats.size > MAX_EVIDENCE_BYTES
    ) {
      fail("INVALID_WEB_STAGING_EVIDENCE_FILE");
    }
    bytes = await readFile(configuration.evidencePath);
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    fail("WEB_STAGING_EVIDENCE_READ_FAILED");
  }
  if (bytes.byteLength !== stats.size) {
    fail("WEB_STAGING_EVIDENCE_CHANGED");
  }
  return parseDownloadedWebStagingEvidence(bytes, configuration);
}

async function main() {
  const configuration = parseWebStagingVerificationEnvironment(process.env);
  const result = await verifyDownloadedWebStagingEvidence(configuration);
  process.stdout.write(
    `staging_project_identity_hash=${result.projectIdentitySha256}\n` +
      `staging_project_ref_identity_hash=${result.projectRefIdentitySha256}\n` +
      `staging_organization_identity_hash=${result.organizationIdentitySha256}\n` +
      `staging_web_evidence_sha256=${result.evidenceSha256}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Web staging evidence verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
