import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CanaryError,
  fetchBounded,
  isRecord,
  parseJsonBytes,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";

const MANAGEMENT_API = "https://api.supabase.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const PROJECT_REF = /^[a-z0-9]{20}$/u;

export const FINALIZE_PROGRESS_WRITE_BOUNDARY_QUERY =
  "select public.firelight_finalize_progress_write_boundary() as boundary";

export const FINAL_PROGRESS_WRITE_BOUNDARY = Object.freeze({
  status: "finalized",
  anon_insert: false,
  anon_update: false,
  anon_delete: false,
  authenticated_select: true,
  authenticated_insert: false,
  authenticated_update: false,
  authenticated_delete: false,
  service_select: true,
  service_insert: true,
  service_update: true,
  service_delete: false,
  mutation_policy_count: 0,
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

function exactKeys(value, expectedKeys) {
  if (!isRecord(value)) fail("INVALID_PROGRESS_WRITE_BOUNDARY_RESULT");
  const actualKeys = Object.keys(value).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalKeys.length ||
    actualKeys.some((key, index) => key !== canonicalKeys[index])
  ) {
    fail("INVALID_PROGRESS_WRITE_BOUNDARY_RESULT");
  }
  return value;
}

export function parseProgressWriteBoundaryEnvironment(environment) {
  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");

  const accessToken = requiredString(environment, "SUPABASE_ACCESS_TOKEN", 4096);
  if (accessToken.length < 20 || /\s/u.test(accessToken)) {
    fail("INVALID_SUPABASE_ACCESS_TOKEN");
  }

  return { projectRef, accessToken };
}

export function buildProgressWriteBoundaryQueryUrl(configuration) {
  return `${MANAGEMENT_API}/v1/projects/${configuration.projectRef}/database/query`;
}

export function parseProgressWriteBoundaryResult(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    fail("INVALID_PROGRESS_WRITE_BOUNDARY_RESULT");
  }
  const row = exactKeys(value[0], ["boundary"]);
  const boundary = exactKeys(row.boundary, Object.keys(FINAL_PROGRESS_WRITE_BOUNDARY));
  for (const [key, expected] of Object.entries(FINAL_PROGRESS_WRITE_BOUNDARY)) {
    if (boundary[key] !== expected) {
      fail("INVALID_PROGRESS_WRITE_BOUNDARY_RESULT");
    }
  }
  return { ...FINAL_PROGRESS_WRITE_BOUNDARY };
}

function managementErrorCode(status) {
  if (status === 401 || status === 403) return "SUPABASE_MANAGEMENT_AUTH_FAILED";
  if (status === 404) return "SUPABASE_PROJECT_NOT_FOUND";
  if (status === 429) return "SUPABASE_MANAGEMENT_RATE_LIMITED";
  return "SUPABASE_PROGRESS_WRITE_BOUNDARY_UNAVAILABLE";
}

function isJsonResponse(response) {
  const contentType = response.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export async function finalizeProgressWriteBoundary(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildProgressWriteBoundaryQueryUrl(configuration),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "firelight-progress-write-boundary-finalizer",
      },
      body: JSON.stringify({
        query: FINALIZE_PROGRESS_WRITE_BOUNDARY_QUERY,
        read_only: false,
      }),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );

  if (response.status !== 201) fail(managementErrorCode(response.status));
  if (!isJsonResponse(response)) fail("INVALID_PROGRESS_WRITE_BOUNDARY_RESPONSE");
  return parseProgressWriteBoundaryResult(parseJsonBytes(bytes));
}

async function main() {
  const configuration = parseProgressWriteBoundaryEnvironment(process.env);
  const boundary = await finalizeProgressWriteBoundary(configuration, globalThis.fetch);
  process.stdout.write(`progress_write_boundary=${boundary.status}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Progress-write boundary finalization failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
