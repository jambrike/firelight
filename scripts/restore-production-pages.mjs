import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";
import {
  buildDeploymentsUrl,
  parseWorkerVersionEnvironment,
  requestCloudflare,
  verifyWorkerVersion,
} from "./verify-worker-version.mjs";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const IDENTIFIER = /^[0-9a-f]{32}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROUTE_PATTERN = "firelight.ie/*";
const WORKER_NAME = "firelight-production";

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

export function parseRestoreProductionPagesEnvironment(environment) {
  const confirmation = requiredString(
    environment,
    "FIRELIGHT_RESTORE_CONFIRMATION",
    64,
  );
  if (confirmation !== "RESTORE_FIRELIGHT_IE_PAGES") {
    fail("INVALID_FIRELIGHT_RESTORE_CONFIRMATION");
  }
  const zoneId = requiredString(environment, "CLOUDFLARE_ZONE_ID", 32);
  if (!IDENTIFIER.test(zoneId)) fail("INVALID_CLOUDFLARE_ZONE_ID");

  const worker = parseWorkerVersionEnvironment({
    CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN,
    ROLLBACK_ENVIRONMENT: "production",
    ROLLBACK_WORKER_NAME: WORKER_NAME,
    ROLLBACK_VERSION_ID: environment.FIRELIGHT_RESTORE_VERSION_ID,
    ROLLBACK_EXPECTED_BUILD_ID: environment.FIRELIGHT_RESTORE_EXPECTED_BUILD_ID,
  });
  return { ...worker, zoneId, confirmation };
}

function routesUrl(configuration, routeId = "") {
  return `${CLOUDFLARE_API_BASE_URL}/zones/${configuration.zoneId}/workers/routes${routeId === "" ? "" : `/${routeId}`}`;
}

function cloudflareErrorCode(response) {
  if (response.status === 401 || response.status === 403) {
    return "CLOUDFLARE_AUTH_FAILED";
  }
  if (response.status === 404) return "PRODUCTION_ROUTE_NOT_FOUND";
  if (response.status === 429) return "CLOUDFLARE_RATE_LIMITED";
  return "CLOUDFLARE_API_FAILED";
}

async function requestRoutes(configuration, fetchImpl, { method = "GET", routeId = "" } = {}) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    routesUrl(configuration, routeId),
    {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.apiToken}`,
        "User-Agent": "firelight-pages-restore",
      },
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: MAX_RESPONSE_BYTES,
    },
  );
  const body = parseJsonBytes(bytes);
  if (!response.ok) fail(cloudflareErrorCode(response));
  if (
    !isRecord(body) ||
    body.success !== true ||
    !Array.isArray(body.errors) ||
    body.errors.length !== 0 ||
    !Array.isArray(body.messages)
  ) {
    fail("INVALID_CLOUDFLARE_RESPONSE");
  }
  return body.result;
}

function requireCurrentDeployment(result, versionId) {
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
    !UUID.test(deployment.id) ||
    deployment.strategy !== "percentage" ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 1 ||
    !isRecord(deployment.versions[0]) ||
    deployment.versions[0].version_id !== versionId ||
    deployment.versions[0].percentage !== 100
  ) {
    fail("RESTORE_VERSION_IS_NOT_CURRENT");
  }
  return deployment.id;
}

function exactProductionRoute(result) {
  if (!Array.isArray(result) || result.length > 10_000) {
    fail("INVALID_WORKER_ROUTES");
  }
  const matches = result.filter((route) =>
    isRecord(route) && route.pattern === ROUTE_PATTERN
  );
  const workerRoutes = result.filter((route) =>
    isRecord(route) && route.script === WORKER_NAME
  );
  if (
    matches.length !== 1 ||
    workerRoutes.length !== 1 ||
    workerRoutes[0] !== matches[0] ||
    matches[0].script !== WORKER_NAME ||
    typeof matches[0].id !== "string" ||
    !IDENTIFIER.test(matches[0].id)
  ) {
    fail("PRODUCTION_ROUTE_MISMATCH");
  }
  return matches[0].id;
}

function requireDeletedRoute(result, routeId) {
  if (!isRecord(result) || result.id !== routeId) {
    fail("PRODUCTION_ROUTE_DELETE_MISMATCH");
  }
}

function requireRouteAbsent(result) {
  if (!Array.isArray(result) || result.length > 10_000) {
    fail("INVALID_WORKER_ROUTES");
  }
  if (
    result.some((route) =>
      isRecord(route) &&
      (route.pattern === ROUTE_PATTERN || route.script === WORKER_NAME)
    )
  ) {
    fail("PRODUCTION_ROUTE_STILL_PRESENT");
  }
}

export async function restoreProductionPages(configuration, fetchImpl) {
  await verifyWorkerVersion(configuration, fetchImpl);
  const deploymentHistory = await requestCloudflare(
    configuration,
    fetchImpl,
    buildDeploymentsUrl(configuration),
  );
  const deploymentId = requireCurrentDeployment(
    deploymentHistory,
    configuration.versionId,
  );
  const routeId = exactProductionRoute(
    await requestRoutes(configuration, fetchImpl),
  );
  requireDeletedRoute(
    await requestRoutes(configuration, fetchImpl, { method: "DELETE", routeId }),
    routeId,
  );
  requireRouteAbsent(await requestRoutes(configuration, fetchImpl));
  return { routeId, deploymentId, versionId: configuration.versionId };
}

async function main() {
  const configuration = parseRestoreProductionPagesEnvironment(process.env);
  const result = await restoreProductionPages(configuration, globalThis.fetch);
  process.stdout.write(
    `Removed verified production route ${result.routeId}; retained Pages now owns traffic.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Production Pages restore failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
