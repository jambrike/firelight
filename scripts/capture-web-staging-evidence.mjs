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
import {
  SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
  SUPABASE_PROJECT_IDENTITY_DOMAIN,
  SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
} from "./verify-supabase-project.mjs";

export const WEB_STAGING_EVIDENCE_SCHEMA =
  "firelight.web-staging-promotion-evidence";
export const WEB_STAGING_EVIDENCE_VERSION = 2;
export const WEB_STAGING_EVIDENCE_FILENAME =
  "firelight-web-staging-evidence.json";
export const WEB_STAGING_WORKFLOW_PATH =
  ".github/workflows/deploy-staging.yml";
export const CANONICAL_REPOSITORY = "jambrike/firelight";

const ACCEPTANCE = "accepted";
const BUILD_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const WORKFLOW_REF =
  `${CANONICAL_REPOSITORY}/${WEB_STAGING_WORKFLOW_PATH}@refs/heads/main`;
const EVIDENCE_KEYS = Object.freeze([
  "acceptance",
  "artifactName",
  "branch",
  "commitSha",
  "environment",
  "event",
  "job",
  "repository",
  "runAttempt",
  "runId",
  "runNumber",
  "schema",
  "supabaseOrganizationIdentityDomain",
  "supabaseOrganizationIdentitySha256",
  "supabaseProjectIdentityDomain",
  "supabaseProjectIdentitySha256",
  "supabaseProjectRefIdentityDomain",
  "supabaseProjectRefIdentitySha256",
  "version",
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

export function webStagingArtifactName(runId, runAttempt) {
  return `web-staging-evidence-${String(runId)}-${String(runAttempt)}`;
}

export function parseWebStagingCaptureEnvironment(environment) {
  requireExact(environment, "GITHUB_ACTIONS", "true");
  requireExact(environment, "GITHUB_SERVER_URL", "https://github.com");
  requireExact(environment, "GITHUB_API_URL", "https://api.github.com");
  requireExact(environment, "GITHUB_EVENT_NAME", "workflow_dispatch");
  requireExact(environment, "GITHUB_REPOSITORY", CANONICAL_REPOSITORY);
  requireExact(environment, "GITHUB_REF", "refs/heads/main");
  requireExact(environment, "GITHUB_JOB", "migrate-and-deploy");
  requireExact(environment, "GITHUB_WORKFLOW_REF", WORKFLOW_REF);

  const commitSha = requiredString(environment, "GITHUB_SHA", 40);
  if (!BUILD_SHA.test(commitSha)) fail("INVALID_GITHUB_SHA");
  const workflowSha = requiredString(environment, "GITHUB_WORKFLOW_SHA", 40);
  if (!BUILD_SHA.test(workflowSha) || workflowSha !== commitSha) {
    fail("INVALID_GITHUB_WORKFLOW_SHA");
  }
  const projectIdentitySha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_SUPABASE_PROJECT_IDENTITY_SHA256",
  );
  const projectRefIdentitySha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256",
  );
  const organizationIdentitySha256 = sha256Fingerprint(
    environment,
    "FIRELIGHT_SUPABASE_ORGANIZATION_IDENTITY_SHA256",
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
    "FIRELIGHT_WEB_STAGING_EVIDENCE_PATH",
    4096,
  );
  if (evidencePath !== join(runnerTemp, WEB_STAGING_EVIDENCE_FILENAME)) {
    fail("INVALID_FIRELIGHT_WEB_STAGING_EVIDENCE_PATH");
  }

  return {
    commitSha,
    projectIdentitySha256,
    projectRefIdentitySha256,
    organizationIdentitySha256,
    runId,
    runNumber,
    runAttempt,
    runnerTemp,
    evidencePath,
    artifactName: webStagingArtifactName(runId, runAttempt),
  };
}

export function buildWebStagingEvidence(configuration) {
  return {
    schema: WEB_STAGING_EVIDENCE_SCHEMA,
    version: WEB_STAGING_EVIDENCE_VERSION,
    acceptance: ACCEPTANCE,
    environment: "staging",
    repository: CANONICAL_REPOSITORY,
    commitSha: configuration.commitSha,
    supabaseProjectIdentityDomain: SUPABASE_PROJECT_IDENTITY_DOMAIN,
    supabaseProjectIdentitySha256: configuration.projectIdentitySha256,
    supabaseProjectRefIdentityDomain:
      SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
    supabaseProjectRefIdentitySha256:
      configuration.projectRefIdentitySha256,
    supabaseOrganizationIdentityDomain:
      SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
    supabaseOrganizationIdentitySha256:
      configuration.organizationIdentitySha256,
    workflowPath: WEB_STAGING_WORKFLOW_PATH,
    workflowRef: WORKFLOW_REF,
    workflowSha: configuration.commitSha,
    event: "workflow_dispatch",
    branch: "main",
    job: "migrate-and-deploy",
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

export function validateWebStagingEvidence(value, expected) {
  if (
    !hasExactKeys(value) ||
    value.schema !== WEB_STAGING_EVIDENCE_SCHEMA ||
    value.version !== WEB_STAGING_EVIDENCE_VERSION ||
    value.acceptance !== ACCEPTANCE ||
    value.environment !== "staging" ||
    value.repository !== CANONICAL_REPOSITORY ||
    value.commitSha !== expected.commitSha ||
    !BUILD_SHA.test(value.commitSha) ||
    value.supabaseProjectIdentityDomain !==
      SUPABASE_PROJECT_IDENTITY_DOMAIN ||
    typeof value.supabaseProjectIdentitySha256 !== "string" ||
    !SHA256.test(value.supabaseProjectIdentitySha256) ||
    value.supabaseProjectIdentitySha256 !== expected.projectIdentitySha256 ||
    value.supabaseProjectRefIdentityDomain !==
      SUPABASE_PROJECT_REF_IDENTITY_DOMAIN ||
    typeof value.supabaseProjectRefIdentitySha256 !== "string" ||
    !SHA256.test(value.supabaseProjectRefIdentitySha256) ||
    value.supabaseProjectRefIdentitySha256 !==
      expected.projectRefIdentitySha256 ||
    value.supabaseOrganizationIdentityDomain !==
      SUPABASE_ORGANIZATION_IDENTITY_DOMAIN ||
    typeof value.supabaseOrganizationIdentitySha256 !== "string" ||
    !SHA256.test(value.supabaseOrganizationIdentitySha256) ||
    value.supabaseOrganizationIdentitySha256 !==
      expected.organizationIdentitySha256 ||
    value.workflowPath !== WEB_STAGING_WORKFLOW_PATH ||
    value.workflowRef !== WORKFLOW_REF ||
    value.workflowSha !== expected.commitSha ||
    value.event !== "workflow_dispatch" ||
    value.branch !== "main" ||
    value.job !== "migrate-and-deploy" ||
    value.runId !== expected.runId ||
    value.runNumber !== expected.runNumber ||
    value.runAttempt !== expected.runAttempt ||
    value.artifactName !== expected.artifactName
  ) {
    fail("WEB_STAGING_EVIDENCE_MISMATCH");
  }
  return value;
}

export function serializeWebStagingEvidence(evidence) {
  return Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function removeCreatedEvidence(path) {
  try {
    await unlink(path);
  } catch {
    // The evidence either never existed or has already been removed.
  }
}

export async function captureWebStagingEvidence(configuration) {
  const evidence = buildWebStagingEvidence(configuration);
  validateWebStagingEvidence(evidence, configuration);
  const bytes = serializeWebStagingEvidence(evidence);
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
      fail("WEB_STAGING_EVIDENCE_NOT_PRIVATE");
    }
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    fail("WEB_STAGING_EVIDENCE_WRITE_FAILED");
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
  const configuration = parseWebStagingCaptureEnvironment(process.env);
  const result = await captureWebStagingEvidence(configuration);
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
      `Web staging evidence capture failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
