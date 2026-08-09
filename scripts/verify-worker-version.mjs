import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOWERCASE_BUILD_SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT_WORKERS = Object.freeze({
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

export function expectedVersionMessage(environment, buildId) {
  if (!(environment in ENVIRONMENT_WORKERS) || !LOWERCASE_BUILD_SHA.test(buildId)) {
    fail("INVALID_VERSION_IDENTITY");
  }
  return `firelight-release:${environment}:${buildId}`;
}

export function parseWorkerVersionEnvironment(environment) {
  const accountId = requiredString(environment, "CLOUDFLARE_ACCOUNT_ID", 32);
  if (!ACCOUNT_ID.test(accountId)) fail("INVALID_CLOUDFLARE_ACCOUNT_ID");

  const apiToken = requiredString(environment, "CLOUDFLARE_API_TOKEN", 4096);
  if (apiToken.length < 20 || /\s/u.test(apiToken)) {
    fail("INVALID_CLOUDFLARE_API_TOKEN");
  }

  const expectedEnvironment = requiredString(
    environment,
    "ROLLBACK_ENVIRONMENT",
    10,
  );
  const expectedWorkerName = ENVIRONMENT_WORKERS[expectedEnvironment];
  if (expectedWorkerName === undefined) fail("INVALID_ROLLBACK_ENVIRONMENT");

  const workerName = requiredString(environment, "ROLLBACK_WORKER_NAME", 64);
  if (workerName !== expectedWorkerName) fail("ROLLBACK_WORKER_MISMATCH");

  const versionId = requiredString(environment, "ROLLBACK_VERSION_ID", 36);
  if (!LOWERCASE_UUID.test(versionId)) fail("INVALID_ROLLBACK_VERSION_ID");

  const expectedBuildId = requiredString(
    environment,
    "ROLLBACK_EXPECTED_BUILD_ID",
    40,
  );
  if (!LOWERCASE_BUILD_SHA.test(expectedBuildId)) {
    fail("INVALID_ROLLBACK_EXPECTED_BUILD_ID");
  }

  return {
    accountId,
    apiToken,
    expectedEnvironment,
    workerName,
    versionId,
    expectedBuildId,
    expectedMessage: expectedVersionMessage(expectedEnvironment, expectedBuildId),
  };
}

export function buildVersionsInventoryUrl(configuration) {
  const url = new URL(
    `${CLOUDFLARE_API_BASE_URL}/accounts/${configuration.accountId}/workers/scripts/${configuration.workerName}/versions`,
  );
  url.searchParams.set("deployable", "true");
  return url.href;
}

export function buildVersionDetailUrl(configuration) {
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${configuration.accountId}/workers/scripts/${configuration.workerName}/versions/${configuration.versionId}`;
}

export function buildDeploymentsUrl(configuration) {
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${configuration.accountId}/workers/scripts/${configuration.workerName}/deployments`;
}

function cloudflareErrorCode(response) {
  if (response.status === 401 || response.status === 403) {
    return "CLOUDFLARE_AUTH_FAILED";
  }
  if (response.status === 404) return "WORKER_VERSION_NOT_FOUND";
  if (response.status === 429) return "CLOUDFLARE_RATE_LIMITED";
  return "CLOUDFLARE_API_FAILED";
}

export async function requestCloudflare(configuration, fetchImpl, url) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.apiToken}`,
        "User-Agent": "firelight-rollback-verifier",
      },
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: MAX_RESPONSE_BYTES,
    },
  );
  const body = parseJsonBytes(bytes);
  if (!response.ok) fail(cloudflareErrorCode(response));
  const hasNoErrors = body?.errors === null ||
    (Array.isArray(body?.errors) && body.errors.length === 0);
  const hasValidMessages = body?.messages === null || Array.isArray(body?.messages);
  if (
    !isRecord(body) ||
    body.success !== true ||
    !hasNoErrors ||
    !hasValidMessages ||
    !isRecord(body.result)
  ) {
    fail("INVALID_CLOUDFLARE_RESPONSE");
  }
  return body.result;
}

function validVersionSummary(value, versionId) {
  return isRecord(value) &&
    value.id === versionId &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    isRecord(value.metadata) &&
    value.metadata.source === "wrangler";
}

export function validateVersionInventory(result, versionId) {
  if (
    !isRecord(result) ||
    !Array.isArray(result.items) ||
    result.items.length > 5_000
  ) {
    fail("INVALID_VERSION_INVENTORY");
  }
  const matches = result.items.filter((item) =>
    isRecord(item) && item.id === versionId
  );
  if (matches.length !== 1 || !validVersionSummary(matches[0], versionId)) {
    fail("ROLLBACK_VERSION_NOT_IN_INVENTORY");
  }
  return { versionNumber: matches[0].number };
}

function requiredPlainTextBinding(bindings, name, expectedValue) {
  const matches = bindings.filter((binding) =>
    isRecord(binding) && binding.name === name
  );
  if (
    matches.length !== 1 ||
    matches[0].type !== "plain_text" ||
    matches[0].text !== expectedValue
  ) {
    fail("WORKER_VERSION_IDENTITY_MISMATCH");
  }
}

export function validateVersionDetail(result, configuration) {
  if (
    !validVersionSummary(result, configuration.versionId) ||
    !isRecord(result.annotations) ||
    result.annotations["workers/tag"] !== configuration.expectedBuildId ||
    result.annotations["workers/message"] !== configuration.expectedMessage ||
    !isRecord(result.resources) ||
    !Array.isArray(result.resources.bindings) ||
    result.resources.bindings.length > 512
  ) {
    fail("WORKER_VERSION_IDENTITY_MISMATCH");
  }
  requiredPlainTextBinding(
    result.resources.bindings,
    "ENVIRONMENT",
    configuration.expectedEnvironment,
  );
  requiredPlainTextBinding(
    result.resources.bindings,
    "BUILD_ID",
    configuration.expectedBuildId,
  );
  return { versionNumber: result.number };
}

function validTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export function validateDeploymentHistory(result, versionId) {
  if (
    !isRecord(result) ||
    !Array.isArray(result.deployments) ||
    result.deployments.length > 1_000
  ) {
    fail("INVALID_DEPLOYMENT_HISTORY");
  }
  const matching = result.deployments.filter((deployment) =>
    isRecord(deployment) &&
    LOWERCASE_UUID.test(deployment.id) &&
    validTimestamp(deployment.created_on) &&
    deployment.strategy === "percentage" &&
    Array.isArray(deployment.versions) &&
    deployment.versions.length === 1 &&
    isRecord(deployment.versions[0]) &&
    deployment.versions[0].version_id === versionId &&
    deployment.versions[0].percentage === 100
  );
  if (matching.length < 1) fail("WORKER_VERSION_WAS_NOT_FULLY_DEPLOYED");
  return {
    deploymentId: matching[0].id,
    deployedAt: matching[0].created_on,
  };
}

export async function verifyWorkerVersion(configuration, fetchImpl) {
  const inventory = await requestCloudflare(
    configuration,
    fetchImpl,
    buildVersionsInventoryUrl(configuration),
  );
  const inventoryVersion = validateVersionInventory(
    inventory,
    configuration.versionId,
  );
  const detail = await requestCloudflare(
    configuration,
    fetchImpl,
    buildVersionDetailUrl(configuration),
  );
  const detailedVersion = validateVersionDetail(detail, configuration);
  if (inventoryVersion.versionNumber !== detailedVersion.versionNumber) {
    fail("WORKER_VERSION_IDENTITY_MISMATCH");
  }
  const deployments = await requestCloudflare(
    configuration,
    fetchImpl,
    buildDeploymentsUrl(configuration),
  );
  const deployment = validateDeploymentHistory(
    deployments,
    configuration.versionId,
  );
  return {
    environment: configuration.expectedEnvironment,
    workerName: configuration.workerName,
    versionId: configuration.versionId,
    versionNumber: detailedVersion.versionNumber,
    buildId: configuration.expectedBuildId,
    ...deployment,
  };
}

async function main() {
  const configuration = parseWorkerVersionEnvironment(process.env);
  const result = await verifyWorkerVersion(configuration, globalThis.fetch);
  process.stdout.write(
    `Verified ${result.workerName} version ${result.versionId} as build ${result.buildId}.\n`,
  );
}

function isDirectExecution() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(
      `Worker version verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
