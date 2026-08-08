import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONFIG_RESPONSE_BYTES = 128 * 1024;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const ENVIRONMENT_BASE_URLS = Object.freeze({
  staging: "https://staging.firelight.ie",
  production: "https://firelight.ie",
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

export function hashProjectRef(projectRef) {
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");
  return createHash("sha256").update(projectRef, "utf8").digest("hex");
}

export function parseDatabaseTargetEnvironment(environment) {
  const expectedEnvironment = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_ENVIRONMENT",
    10,
  );
  if (expectedEnvironment !== "staging" && expectedEnvironment !== "production") {
    fail("INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT");
  }

  const rawBaseUrl = requiredString(environment, "FIRELIGHT_BASE_URL", 2048);
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    fail("INVALID_FIRELIGHT_BASE_URL");
  }
  if (
    rawBaseUrl !== ENVIRONMENT_BASE_URLS[expectedEnvironment] ||
    rawBaseUrl !== baseUrl.origin ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    baseUrl.username !== "" ||
    baseUrl.password !== ""
  ) {
    fail("FIRELIGHT_BASE_URL_MISMATCH");
  }

  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");

  const expectedProjectRefHash = environment.FIRELIGHT_EXPECTED_PROJECT_REF_HASH;
  if (
    expectedProjectRefHash !== undefined &&
    (
      typeof expectedProjectRefHash !== "string" ||
      !LOWERCASE_SHA256.test(expectedProjectRefHash)
    )
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_PROJECT_REF_HASH");
  }
  const projectRefHash = hashProjectRef(projectRef);
  if (
    expectedProjectRefHash !== undefined &&
    expectedProjectRefHash !== projectRefHash
  ) {
    fail("SUPABASE_PROJECT_EVIDENCE_MISMATCH");
  }

  const confirmation = environment.FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION ?? "";
  const requiredConfirmation = `BOOTSTRAP_${expectedEnvironment.toUpperCase()}_DATABASE`;
  if (
    typeof confirmation !== "string" ||
    confirmation.length > 64 ||
    (confirmation !== "" && confirmation !== requiredConfirmation)
  ) {
    fail("INVALID_FIRELIGHT_DATABASE_BOOTSTRAP_CONFIRMATION");
  }

  return {
    baseUrl: baseUrl.origin,
    expectedEnvironment,
    projectRef,
    projectRefHash,
    bootstrapApproved: confirmation === requiredConfirmation,
  };
}

function parseDeployedProjectRef(body) {
  if (
    !isRecord(body) ||
    !isRecord(body.data) ||
    !isRecord(body.data.supabase) ||
    typeof body.data.supabase.url !== "string" ||
    body.data.supabase.url.length > 2048
  ) {
    fail("INVALID_DEPLOYED_CONFIG");
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(body.data.supabase.url);
  } catch {
    fail("INVALID_DEPLOYED_CONFIG");
  }
  if (
    supabaseUrl.protocol !== "https:" ||
    supabaseUrl.port !== "" ||
    supabaseUrl.username !== "" ||
    supabaseUrl.password !== "" ||
    supabaseUrl.pathname !== "/" ||
    supabaseUrl.search !== "" ||
    supabaseUrl.hash !== ""
  ) {
    fail("INVALID_DEPLOYED_CONFIG");
  }
  const hostnameMatch = /^([a-z0-9]{20})\.supabase\.co$/u.exec(
    supabaseUrl.hostname,
  );
  if (hostnameMatch === null) fail("INVALID_DEPLOYED_CONFIG");
  return hostnameMatch[1];
}

function bootstrapResult(configuration, reason) {
  return {
    environment: configuration.expectedEnvironment,
    projectRefHash: configuration.projectRefHash,
    mode: "bootstrap",
    reason,
  };
}

export async function verifyDatabaseTarget(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    `${configuration.baseUrl}/api/config`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maximumBytes: MAX_CONFIG_RESPONSE_BYTES,
    },
  );

  if (!response.ok) {
    if (
      configuration.bootstrapApproved &&
      (response.status === 404 || response.status === 410)
    ) {
      return bootstrapResult(configuration, `HTTP_${String(response.status)}`);
    }
    fail("DEPLOYED_CONFIG_UNAVAILABLE");
  }

  let body;
  try {
    body = parseJsonBytes(bytes);
  } catch {
    fail("INVALID_DEPLOYED_CONFIG");
  }

  let deployedProjectRef;
  try {
    deployedProjectRef = parseDeployedProjectRef(body);
  } catch {
    fail("INVALID_DEPLOYED_CONFIG");
  }
  if (deployedProjectRef !== configuration.projectRef) {
    fail("DEPLOYED_SUPABASE_PROJECT_MISMATCH");
  }

  return {
    environment: configuration.expectedEnvironment,
    projectRefHash: configuration.projectRefHash,
    mode: "matched",
    reason: "DEPLOYED_CONFIG_MATCHED",
  };
}

async function main() {
  const configuration = parseDatabaseTargetEnvironment(process.env);
  const result = await verifyDatabaseTarget(configuration, globalThis.fetch);
  process.stdout.write(`project_ref_hash=${result.projectRefHash}\n`);
  process.stdout.write(`database_target_mode=${result.mode}\n`);
  process.stdout.write(`database_target_reason=${result.reason}\n`);
}

function isDirectExecution() {
  const entry = process.argv[1];
  return typeof entry === "string" && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(
      `Database target verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
