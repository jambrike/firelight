import process from "node:process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL, URL } from "node:url";
import { CanaryError, isRecord, safeCanaryErrorCode } from "./postdeploy-canary.mjs";
import {
  buildDeploymentsUrl,
  parseWorkerVersionEnvironment,
  requestCloudflare,
  verifyWorkerVersion,
} from "./verify-worker-version.mjs";

export const RELEASE_EVIDENCE_SCHEMA = "firelight.release-evidence";
export const RELEASE_EVIDENCE_VERSION = 3;
export const PROGRESS_SERVICE_WRITES_CAPABILITY = "service-v1";
export const COMPILER_PROTOCOL_VERSION = 1;
export const COMPILER_CONNECTION_FINGERPRINT_DOMAIN =
  "firelight.compiler-connection-fingerprint.v1";
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const BUILD_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FUNCTION_HOST = /^[a-z0-9]{10,64}\.lambda-url\.eu-west-1\.on\.aws$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKERS = Object.freeze({
  staging: "firelight-staging",
  production: "firelight-production",
});

function fail(code) {
  throw new CanaryError(code);
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
  return value;
}

function requiredSha256(environment, name) {
  const value = requiredString(environment, name, 64);
  if (!SHA256.test(value) || value === "0".repeat(64)) fail(`INVALID_${name}`);
  return value;
}

export function compilerConnectionFingerprint(environment) {
  const urlValue = requiredString(environment, "COMPILER_SERVICE_URL", 2048);
  const originValue = requiredString(
    environment,
    "COMPILER_SERVICE_ORIGIN",
    2048,
  );
  const host = requiredString(environment, "COMPILER_SERVICE_HOST", 253);
  const token = requiredString(environment, "COMPILER_SERVICE_TOKEN", 512);
  if (
    token.length < 32 ||
    /\s/u.test(token) ||
    !FUNCTION_HOST.test(host)
  ) {
    fail("COMPILER_CONNECTION_INVALID");
  }
  let url;
  let origin;
  try {
    url = new URL(urlValue);
    origin = new URL(originValue);
  } catch {
    fail("COMPILER_CONNECTION_INVALID");
  }
  const canonicalOrigin = `https://${host}`;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname !== host ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    originValue !== canonicalOrigin ||
    origin.origin !== canonicalOrigin ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    fail("COMPILER_CONNECTION_INVALID");
  }
  const canonical = JSON.stringify([
    `${canonicalOrigin}/`,
    canonicalOrigin,
    host,
    token,
  ]);
  return createHash("sha256")
    .update(`${COMPILER_CONNECTION_FINGERPRINT_DOMAIN}\0${canonical}`, "utf8")
    .digest("hex");
}

export function parseReleaseEvidenceEnvironment(
  environment,
  {
    requirePath = false,
    requireApiToken = true,
    requireCompilerDeploymentIdentity = true,
  } = {},
) {
  const releaseEnvironment = requiredString(
    environment,
    "FIRELIGHT_RELEASE_ENVIRONMENT",
    10,
  );
  const expectedWorker = WORKERS[releaseEnvironment];
  if (expectedWorker === undefined) fail("INVALID_FIRELIGHT_RELEASE_ENVIRONMENT");
  const workerName = requiredString(environment, "FIRELIGHT_RELEASE_WORKER_NAME", 64);
  if (workerName !== expectedWorker) fail("FIRELIGHT_RELEASE_WORKER_MISMATCH");
  const buildId = requiredString(environment, "FIRELIGHT_RELEASE_BUILD_ID", 40);
  if (!BUILD_SHA.test(buildId)) fail("INVALID_FIRELIGHT_RELEASE_BUILD_ID");
  const accountId = requiredString(environment, "CLOUDFLARE_ACCOUNT_ID", 32);
  if (!ACCOUNT_ID.test(accountId)) fail("INVALID_CLOUDFLARE_ACCOUNT_ID");
  let apiToken;
  if (requireApiToken) {
    apiToken = requiredString(environment, "CLOUDFLARE_API_TOKEN", 4096);
    if (apiToken.length < 20 || /\s/u.test(apiToken)) {
      fail("INVALID_CLOUDFLARE_API_TOKEN");
    }
  }
  let evidencePath;
  if (requirePath) {
    evidencePath = requiredString(
      environment,
      "FIRELIGHT_RELEASE_EVIDENCE_PATH",
      4096,
    );
    if (
      !isAbsolute(evidencePath) ||
      resolve(evidencePath) !== evidencePath ||
      !evidencePath.endsWith("/firelight-release-evidence.json")
    ) {
      fail("INVALID_FIRELIGHT_RELEASE_EVIDENCE_PATH");
    }
  }
  const compilerConnectionSha256 = compilerConnectionFingerprint(environment);
  const supabaseAnchorSetSha256 = requiredSha256(
    environment,
    "FIRELIGHT_SUPABASE_ANCHOR_SET_SHA256",
  );
  const supabaseProjectRefIdentitySha256 = requiredSha256(
    environment,
    "FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256",
  );
  const supabaseOrganizationIdentitySha256 = requiredSha256(
    environment,
    "FIRELIGHT_SUPABASE_ORGANIZATION_IDENTITY_SHA256",
  );
  let compilerBuildId;
  let compilerImageDigest;
  if (requireCompilerDeploymentIdentity) {
    compilerBuildId = requiredString(
      environment,
      "COMPILER_SERVICE_BUILD_ID",
      40,
    );
    compilerImageDigest = requiredString(
      environment,
      "COMPILER_SERVICE_IMAGE_DIGEST",
      71,
    );
    if (
      !BUILD_SHA.test(compilerBuildId) ||
      compilerBuildId === "0".repeat(40)
    ) {
      fail("INVALID_COMPILER_SERVICE_BUILD_ID");
    }
    if (
      !IMAGE_DIGEST.test(compilerImageDigest) ||
      compilerImageDigest === `sha256:${"0".repeat(64)}`
    ) {
      fail("INVALID_COMPILER_SERVICE_IMAGE_DIGEST");
    }
  }
  return {
    releaseEnvironment,
    workerName,
    buildId,
    accountId,
    compilerProtocolVersion: COMPILER_PROTOCOL_VERSION,
    compilerConnectionSha256,
    supabaseAnchorSetSha256,
    supabaseProjectRefIdentitySha256,
    supabaseOrganizationIdentitySha256,
    ...(requireApiToken ? { apiToken } : {}),
    ...(requirePath ? { evidencePath } : {}),
    ...(requireCompilerDeploymentIdentity
      ? { compilerBuildId, compilerImageDigest }
      : {}),
  };
}

function latestDeployment(result) {
  if (
    !isRecord(result) ||
    !Array.isArray(result.deployments) ||
    result.deployments.length < 1 ||
    result.deployments.length > 1_000
  ) {
    fail("INVALID_DEPLOYMENT_HISTORY");
  }
  const deployment = result.deployments[0];
  if (
    !isRecord(deployment) ||
    typeof deployment.id !== "string" ||
    !UUID.test(deployment.id) ||
    typeof deployment.created_on !== "string" ||
    deployment.created_on.length > 40 ||
    Number.isNaN(Date.parse(deployment.created_on)) ||
    deployment.strategy !== "percentage" ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    !isRecord(deployment.versions[0]) ||
    typeof deployment.versions[0].version_id !== "string" ||
    !UUID.test(deployment.versions[0].version_id) ||
    deployment.versions[0].percentage !== 100
  ) {
    fail("LATEST_WORKER_DEPLOYMENT_INVALID");
  }
  return {
    deploymentId: deployment.id,
    deployedAt: deployment.created_on,
    versionId: deployment.versions[0].version_id,
  };
}

export async function captureReleaseEvidence(configuration, fetchImpl) {
  const deployment = latestDeployment(
    await requestCloudflare(
      configuration,
      fetchImpl,
      buildDeploymentsUrl(configuration),
    ),
  );
  const verified = await verifyWorkerVersion(
    parseWorkerVersionEnvironment({
      CLOUDFLARE_ACCOUNT_ID: configuration.accountId,
      CLOUDFLARE_API_TOKEN: configuration.apiToken,
      ROLLBACK_ENVIRONMENT: configuration.releaseEnvironment,
      ROLLBACK_WORKER_NAME: configuration.workerName,
      ROLLBACK_VERSION_ID: deployment.versionId,
      ROLLBACK_EXPECTED_BUILD_ID: configuration.buildId,
    }),
    fetchImpl,
  );
  if (
    verified.deploymentId !== deployment.deploymentId ||
    verified.deployedAt !== deployment.deployedAt
  ) {
    fail("LATEST_WORKER_DEPLOYMENT_CHANGED");
  }
  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    version: RELEASE_EVIDENCE_VERSION,
    accountId: configuration.accountId,
    environment: configuration.releaseEnvironment,
    workerName: configuration.workerName,
    buildId: configuration.buildId,
    compilerProtocolVersion: configuration.compilerProtocolVersion,
    compilerConnectionSha256: configuration.compilerConnectionSha256,
    compilerBuildId: configuration.compilerBuildId,
    compilerImageDigest: configuration.compilerImageDigest,
    supabaseAnchorSetSha256: configuration.supabaseAnchorSetSha256,
    supabaseProjectRefIdentitySha256:
      configuration.supabaseProjectRefIdentitySha256,
    supabaseOrganizationIdentitySha256:
      configuration.supabaseOrganizationIdentitySha256,
    progressServiceWrites: PROGRESS_SERVICE_WRITES_CAPABILITY,
    versionId: deployment.versionId,
    deploymentId: deployment.deploymentId,
    deployedAt: deployment.deployedAt,
  };
}

export function validateReleaseEvidence(value, expected) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "accountId,buildId,compilerBuildId,compilerConnectionSha256,compilerImageDigest,compilerProtocolVersion,deployedAt,deploymentId,environment,progressServiceWrites,schema,supabaseAnchorSetSha256,supabaseOrganizationIdentitySha256,supabaseProjectRefIdentitySha256,version,versionId,workerName" ||
    value.schema !== RELEASE_EVIDENCE_SCHEMA ||
    value.version !== RELEASE_EVIDENCE_VERSION ||
    value.progressServiceWrites !== PROGRESS_SERVICE_WRITES_CAPABILITY ||
    value.accountId !== expected.accountId ||
    value.environment !== expected.releaseEnvironment ||
    value.workerName !== expected.workerName ||
    value.buildId !== expected.buildId ||
    value.compilerProtocolVersion !== expected.compilerProtocolVersion ||
    value.compilerConnectionSha256 !== expected.compilerConnectionSha256 ||
    value.supabaseAnchorSetSha256 !== expected.supabaseAnchorSetSha256 ||
    value.supabaseProjectRefIdentitySha256 !==
      expected.supabaseProjectRefIdentitySha256 ||
    value.supabaseOrganizationIdentitySha256 !==
      expected.supabaseOrganizationIdentitySha256 ||
    typeof value.compilerBuildId !== "string" ||
    !BUILD_SHA.test(value.compilerBuildId) ||
    value.compilerBuildId === "0".repeat(40) ||
    typeof value.compilerImageDigest !== "string" ||
    !IMAGE_DIGEST.test(value.compilerImageDigest) ||
    value.compilerImageDigest === `sha256:${"0".repeat(64)}` ||
    typeof value.versionId !== "string" ||
    !UUID.test(value.versionId) ||
    typeof value.deploymentId !== "string" ||
    !UUID.test(value.deploymentId) ||
    typeof value.deployedAt !== "string" ||
    value.deployedAt.length > 40 ||
    Number.isNaN(Date.parse(value.deployedAt))
  ) {
    fail("RELEASE_EVIDENCE_MISMATCH");
  }
  return value;
}

async function main() {
  const configuration = parseReleaseEvidenceEnvironment(process.env, { requirePath: true });
  const evidence = await captureReleaseEvidence(configuration, globalThis.fetch);
  await writeFile(
    configuration.evidencePath,
    `${JSON.stringify(evidence)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(
    `Captured accepted ${evidence.environment} release ${evidence.buildId}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Release-evidence capture failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
