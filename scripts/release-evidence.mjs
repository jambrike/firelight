import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CanaryError, isRecord, safeCanaryErrorCode } from "./postdeploy-canary.mjs";
import {
  buildDeploymentsUrl,
  parseWorkerVersionEnvironment,
  requestCloudflare,
  verifyWorkerVersion,
} from "./verify-worker-version.mjs";

export const RELEASE_EVIDENCE_SCHEMA = "firelight.release-evidence";
export const RELEASE_EVIDENCE_VERSION = 1;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const BUILD_SHA = /^[0-9a-f]{40}$/u;
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

export function parseReleaseEvidenceEnvironment(
  environment,
  { requirePath = false, requireApiToken = true } = {},
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
  return {
    releaseEnvironment,
    workerName,
    buildId,
    accountId,
    ...(requireApiToken ? { apiToken } : {}),
    ...(requirePath ? { evidencePath } : {}),
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
    versionId: deployment.versionId,
    deploymentId: deployment.deploymentId,
    deployedAt: deployment.deployedAt,
  };
}

export function validateReleaseEvidence(value, expected) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "accountId,buildId,deployedAt,deploymentId,environment,schema,version,versionId,workerName" ||
    value.schema !== RELEASE_EVIDENCE_SCHEMA ||
    value.version !== RELEASE_EVIDENCE_VERSION ||
    value.accountId !== expected.accountId ||
    value.environment !== expected.releaseEnvironment ||
    value.workerName !== expected.workerName ||
    value.buildId !== expected.buildId ||
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
