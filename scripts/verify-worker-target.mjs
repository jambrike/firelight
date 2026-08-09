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
const MAX_RESPONSE_BYTES = 128 * 1024;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
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

export function parseWorkerTargetEnvironment(environment) {
  const accountId = requiredString(environment, "CLOUDFLARE_ACCOUNT_ID", 32);
  if (!ACCOUNT_ID.test(accountId)) fail("INVALID_CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredString(environment, "CLOUDFLARE_API_TOKEN", 4096);
  if (apiToken.length < 20 || /\s/u.test(apiToken)) {
    fail("INVALID_CLOUDFLARE_API_TOKEN");
  }
  const releaseEnvironment = requiredString(
    environment,
    "FIRELIGHT_WORKER_ENVIRONMENT",
    10,
  );
  const workerName = WORKERS[releaseEnvironment];
  if (workerName === undefined) fail("INVALID_FIRELIGHT_WORKER_ENVIRONMENT");
  const targetMode = requiredString(environment, "FIRELIGHT_WORKER_TARGET_MODE", 9);
  if (targetMode !== "bootstrap" && targetMode !== "existing") {
    fail("INVALID_FIRELIGHT_WORKER_TARGET_MODE");
  }
  return { accountId, apiToken, releaseEnvironment, workerName, targetMode };
}

export function buildWorkerSettingsUrl(configuration) {
  return new URL(
    `${CLOUDFLARE_API_BASE_URL}/accounts/${configuration.accountId}/workers/scripts/${configuration.workerName}/settings`,
  ).href;
}

function isMissingWorkerEnvelope(body) {
  return isRecord(body) &&
    body.success === false &&
    Array.isArray(body.errors) &&
    body.errors.length === 1 &&
    isRecord(body.errors[0]) &&
    body.errors[0].code === 10007 &&
    Array.isArray(body.messages);
}

function isExistingWorkerEnvelope(body) {
  return isRecord(body) &&
    body.success === true &&
    Array.isArray(body.errors) &&
    body.errors.length === 0 &&
    Array.isArray(body.messages) &&
    isRecord(body.result);
}

function cloudflareErrorCode(response) {
  if (response.status === 401 || response.status === 403) {
    return "CLOUDFLARE_AUTH_FAILED";
  }
  if (response.status === 429) return "CLOUDFLARE_RATE_LIMITED";
  return "CLOUDFLARE_API_FAILED";
}

export async function verifyWorkerTarget(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildWorkerSettingsUrl(configuration),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.apiToken}`,
        "User-Agent": "firelight-worker-target-verifier",
      },
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: MAX_RESPONSE_BYTES,
    },
  );
  const body = parseJsonBytes(bytes);

  if (configuration.targetMode === "bootstrap") {
    if (response.status !== 404 || !isMissingWorkerEnvelope(body)) {
      fail(response.ok ? "WORKER_ALREADY_EXISTS" : cloudflareErrorCode(response));
    }
  } else {
    if (!response.ok) fail(cloudflareErrorCode(response));
    if (!isExistingWorkerEnvelope(body)) fail("INVALID_CLOUDFLARE_RESPONSE");
  }

  return {
    environment: configuration.releaseEnvironment,
    workerName: configuration.workerName,
    targetMode: configuration.targetMode,
  };
}

async function main() {
  const configuration = parseWorkerTargetEnvironment(process.env);
  const result = await verifyWorkerTarget(configuration, globalThis.fetch);
  process.stdout.write(
    `Verified ${result.environment} Worker target for ${result.targetMode}.\n`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Worker-target verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
