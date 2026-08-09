import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CanaryError,
  isRecord,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

export const COMPILER_STAGING_EVIDENCE_SCHEMA =
  "firelight.compiler-staging-evidence";
export const COMPILER_STAGING_EVIDENCE_VERSION = 2;
export const COMPILER_STAGING_EVIDENCE_FILENAME =
  "firelight-compiler-staging-evidence.json";
export const COMPILER_WORKFLOW_PATH = ".github/workflows/deploy-compiler.yml";
export const CANONICAL_REPOSITORY = "jambrike/firelight";

const ACCEPTANCE = "accepted";
const BUILD_SHA = /^[0-9a-f]{40}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const WORKFLOW_REF = `${CANONICAL_REPOSITORY}/${COMPILER_WORKFLOW_PATH}@refs/heads/main`;
const EVIDENCE_KEYS = Object.freeze([
  "acceptance",
  "authSecretSha256",
  "artifactName",
  "awsAccountIdSha256",
  "backendLocationSha256",
  "branch",
  "commitSha",
  "environment",
  "event",
  "imageDigest",
  "job",
  "repository",
  "runAttempt",
  "runId",
  "runNumber",
  "schema",
  "stateKmsKeySha256",
  "version",
  "vpcCidrSha256",
  "workflowPath",
  "workflowRef",
  "workflowSha",
]);

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

function sha256Fingerprint(environment, name) {
  const value = requiredString(environment, name, 64);
  if (!SHA256.test(value)) fail(`INVALID_${name}`);
  return value;
}

function artifactName(runId, runAttempt) {
  return `compiler-staging-evidence-${String(runId)}-${String(runAttempt)}`;
}

export function parseCompilerStagingCaptureEnvironment(environment) {
  requireExact(environment, "GITHUB_ACTIONS", "true");
  requireExact(environment, "GITHUB_SERVER_URL", "https://github.com");
  requireExact(environment, "GITHUB_API_URL", "https://api.github.com");
  requireExact(environment, "GITHUB_EVENT_NAME", "workflow_dispatch");
  requireExact(environment, "GITHUB_REPOSITORY", CANONICAL_REPOSITORY);
  requireExact(environment, "GITHUB_REF", "refs/heads/main");
  requireExact(environment, "GITHUB_JOB", "apply");
  requireExact(environment, "GITHUB_WORKFLOW_REF", WORKFLOW_REF);
  requireExact(environment, "FIRELIGHT_COMPILER_ENVIRONMENT", "staging");

  const commitSha = requiredString(environment, "GITHUB_SHA", 40);
  if (!BUILD_SHA.test(commitSha)) fail("INVALID_GITHUB_SHA");
  const workflowSha = requiredString(environment, "GITHUB_WORKFLOW_SHA", 40);
  if (!BUILD_SHA.test(workflowSha) || workflowSha !== commitSha) {
    fail("INVALID_GITHUB_WORKFLOW_SHA");
  }
  const imageDigest = requiredString(
    environment,
    "FIRELIGHT_COMPILER_IMAGE_DIGEST",
    71,
  );
  if (!IMAGE_DIGEST.test(imageDigest)) {
    fail("INVALID_FIRELIGHT_COMPILER_IMAGE_DIGEST");
  }
  const backendLocationSha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_COMPILER_BACKEND_LOCATION_SHA256",
  );
  const awsAccountIdSha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_COMPILER_AWS_ACCOUNT_ID_SHA256",
  );
  const stateKmsKeySha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_COMPILER_STATE_KMS_KEY_SHA256",
  );
  const authSecretSha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_COMPILER_AUTH_SECRET_SHA256",
  );
  const vpcCidrSha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_COMPILER_VPC_CIDR_SHA256",
  );

  const runId = positiveInteger(environment, "GITHUB_RUN_ID");
  const runNumber = positiveInteger(environment, "GITHUB_RUN_NUMBER");
  const runAttempt = positiveInteger(environment, "GITHUB_RUN_ATTEMPT");
  const runnerTemp = requiredString(environment, "RUNNER_TEMP", 4096);
  if (!isAbsolute(runnerTemp) || resolve(runnerTemp) !== runnerTemp) {
    fail("INVALID_RUNNER_TEMP");
  }
  const evidencePath = requiredString(
    environment,
    "FIRELIGHT_COMPILER_STAGING_EVIDENCE_PATH",
    4096,
  );
  if (evidencePath !== join(runnerTemp, COMPILER_STAGING_EVIDENCE_FILENAME)) {
    fail("INVALID_FIRELIGHT_COMPILER_STAGING_EVIDENCE_PATH");
  }

  return {
    commitSha,
    imageDigest,
    awsAccountIdSha256,
    backendLocationSha256,
    stateKmsKeySha256,
    authSecretSha256,
    vpcCidrSha256,
    runId,
    runNumber,
    runAttempt,
    runnerTemp,
    evidencePath,
    artifactName: artifactName(runId, runAttempt),
  };
}

export function buildCompilerStagingEvidence(configuration) {
  return {
    schema: COMPILER_STAGING_EVIDENCE_SCHEMA,
    version: COMPILER_STAGING_EVIDENCE_VERSION,
    acceptance: ACCEPTANCE,
    environment: "staging",
    repository: CANONICAL_REPOSITORY,
    commitSha: configuration.commitSha,
    imageDigest: configuration.imageDigest,
    awsAccountIdSha256: configuration.awsAccountIdSha256,
    backendLocationSha256: configuration.backendLocationSha256,
    stateKmsKeySha256: configuration.stateKmsKeySha256,
    authSecretSha256: configuration.authSecretSha256,
    vpcCidrSha256: configuration.vpcCidrSha256,
    workflowPath: COMPILER_WORKFLOW_PATH,
    workflowRef: WORKFLOW_REF,
    workflowSha: configuration.commitSha,
    event: "workflow_dispatch",
    branch: "main",
    job: "apply",
    runId: configuration.runId,
    runNumber: configuration.runNumber,
    runAttempt: configuration.runAttempt,
    artifactName: configuration.artifactName,
  };
}

function hasExactKeys(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...EVIDENCE_KEYS].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

export function validateCompilerStagingEvidence(value, expected) {
  if (
    !hasExactKeys(value) ||
    value.schema !== COMPILER_STAGING_EVIDENCE_SCHEMA ||
    value.version !== COMPILER_STAGING_EVIDENCE_VERSION ||
    value.acceptance !== ACCEPTANCE ||
    value.environment !== "staging" ||
    value.repository !== CANONICAL_REPOSITORY ||
    value.commitSha !== expected.commitSha ||
    !BUILD_SHA.test(value.commitSha) ||
    typeof value.imageDigest !== "string" ||
    !IMAGE_DIGEST.test(value.imageDigest) ||
    typeof value.backendLocationSha256 !== "string" ||
    !SHA256.test(value.backendLocationSha256) ||
    value.backendLocationSha256 !== expected.backendLocationSha256 ||
    typeof value.awsAccountIdSha256 !== "string" ||
    !SHA256.test(value.awsAccountIdSha256) ||
    value.awsAccountIdSha256 !== expected.awsAccountIdSha256 ||
    typeof value.stateKmsKeySha256 !== "string" ||
    !SHA256.test(value.stateKmsKeySha256) ||
    value.stateKmsKeySha256 !== expected.stateKmsKeySha256 ||
    typeof value.authSecretSha256 !== "string" ||
    !SHA256.test(value.authSecretSha256) ||
    value.authSecretSha256 !== expected.authSecretSha256 ||
    typeof value.vpcCidrSha256 !== "string" ||
    !SHA256.test(value.vpcCidrSha256) ||
    value.vpcCidrSha256 !== expected.vpcCidrSha256 ||
    value.workflowPath !== COMPILER_WORKFLOW_PATH ||
    value.workflowRef !== WORKFLOW_REF ||
    value.workflowSha !== expected.commitSha ||
    value.event !== "workflow_dispatch" ||
    value.branch !== "main" ||
    value.job !== "apply" ||
    value.runId !== expected.runId ||
    value.runNumber !== expected.runNumber ||
    value.runAttempt !== expected.runAttempt ||
    value.artifactName !== expected.artifactName
  ) {
    fail("COMPILER_STAGING_EVIDENCE_MISMATCH");
  }
  return value;
}

export function serializeCompilerStagingEvidence(evidence) {
  return Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function removeCreatedEvidence(path) {
  try {
    await unlink(path);
  } catch {
    // The private evidence either never existed or has already been removed.
  }
}

export async function captureCompilerStagingEvidence(configuration) {
  const evidence = buildCompilerStagingEvidence(configuration);
  validateCompilerStagingEvidence(evidence, configuration);
  const bytes = serializeCompilerStagingEvidence(evidence);
  try {
    await writeFile(configuration.evidencePath, bytes, {
      encoding: null,
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode: 0o600,
    });
    const stats = await lstat(configuration.evidencePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size !== bytes.byteLength
    ) {
      await removeCreatedEvidence(configuration.evidencePath);
      fail("COMPILER_STAGING_EVIDENCE_NOT_PRIVATE");
    }
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    fail("COMPILER_STAGING_EVIDENCE_WRITE_FAILED");
  }
  return {
    evidence,
    bytes,
    artifactName: configuration.artifactName,
    evidencePath: configuration.evidencePath,
    evidenceSha256: sha256(bytes),
  };
}

async function main() {
  const configuration = parseCompilerStagingCaptureEnvironment(process.env);
  const result = await captureCompilerStagingEvidence(configuration);
  process.stdout.write(
    `artifact_name=${result.artifactName}\n` +
      `evidence_sha256=${result.evidenceSha256}\n` +
      `evidence_path=${result.evidencePath}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Compiler staging evidence capture failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
