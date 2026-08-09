import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const PROJECT_REF = /^[a-z0-9]{20}$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

function fail(code) {
  throw new CanaryError(code);
}

function requiredString(environment, name, maximum) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    fail(`INVALID_${name}`);
  }
  return value;
}

export function parseProspectiveWorkerBindings(environment) {
  const releaseEnvironment = requiredString(
    environment,
    "FIRELIGHT_EXPECTED_ENVIRONMENT",
    10,
  );
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production") {
    fail("INVALID_FIRELIGHT_EXPECTED_ENVIRONMENT");
  }
  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");
  const rawUrl = requiredString(environment, "SUPABASE_URL", 2048);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("INVALID_SUPABASE_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${projectRef}.supabase.co` ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail("SUPABASE_PROJECT_MISMATCH");
  }
  const publishableKey = requiredString(
    environment,
    "SUPABASE_PUBLISHABLE_KEY",
    2048,
  );
  const serviceRoleKey = requiredString(
    environment,
    "SUPABASE_SERVICE_ROLE_KEY",
    8192,
  );
  const kitCodePepper = requiredString(environment, "KIT_CODE_PEPPER", 4096);
  if (publishableKey.length < 20) fail("INVALID_SUPABASE_PUBLISHABLE_KEY");
  if (serviceRoleKey.length < 20) fail("INVALID_SUPABASE_SERVICE_ROLE_KEY");
  if (kitCodePepper.length < 32) fail("INVALID_KIT_CODE_PEPPER");
  return {
    releaseEnvironment,
    projectRef,
    projectOrigin: url.origin,
    publishableKey,
    serviceRoleKey,
  };
}

function responseContentType(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    fail("SUPABASE_BINDING_RESPONSE_INVALID");
  }
}

async function boundedJson(fetchImpl, url, headers, errorCode) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    url,
    { method: "GET", headers },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );
  if (!response.ok) fail(errorCode);
  responseContentType(response);
  const value = parseJsonBytes(bytes);
  if (!isRecord(value)) fail("SUPABASE_BINDING_RESPONSE_INVALID");
  return value;
}

export async function verifyProspectiveWorkerBindings(
  configuration,
  fetchImpl,
) {
  await boundedJson(
    fetchImpl,
    `${configuration.projectOrigin}/auth/v1/settings`,
    {
      Accept: "application/json",
      apikey: configuration.publishableKey,
      "User-Agent": "firelight-worker-binding-preflight",
    },
    "SUPABASE_PUBLISHABLE_KEY_REJECTED",
  );
  const admin = await boundedJson(
    fetchImpl,
    `${configuration.projectOrigin}/auth/v1/admin/users?page=1&per_page=1`,
    {
      Accept: "application/json",
      apikey: configuration.serviceRoleKey,
      Authorization: `Bearer ${configuration.serviceRoleKey}`,
      "User-Agent": "firelight-worker-binding-preflight",
    },
    "SUPABASE_SERVICE_ROLE_KEY_REJECTED",
  );
  if (!Array.isArray(admin.users) || admin.users.length > 1) {
    fail("SUPABASE_SERVICE_ROLE_RESPONSE_INVALID");
  }
  return {
    environment: configuration.releaseEnvironment,
    projectRef: configuration.projectRef,
  };
}

async function main() {
  const configuration = parseProspectiveWorkerBindings(process.env);
  await verifyProspectiveWorkerBindings(configuration, globalThis.fetch);
  process.stdout.write(
    `Verified prospective ${configuration.releaseEnvironment} Worker bindings.\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Worker-binding preflight failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
