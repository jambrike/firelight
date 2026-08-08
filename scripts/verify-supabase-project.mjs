import { createHash } from "node:crypto";
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
const EXPECTED_REGION = "eu-west-1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const ORGANIZATION_ID = /^[A-Za-z0-9_-]{4,128}$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;

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

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function projectIdentityHash(identity) {
  const canonical = JSON.stringify([
    identity.projectRef,
    identity.organizationId,
    identity.projectName,
    EXPECTED_REGION,
    `db.${identity.projectRef}.supabase.co`,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function parseSupabaseProjectEnvironment(environment) {
  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");

  const accessToken = requiredString(environment, "SUPABASE_ACCESS_TOKEN", 4096);
  if (accessToken.length < 20 || /\s/u.test(accessToken)) {
    fail("INVALID_SUPABASE_ACCESS_TOKEN");
  }

  const organizationId = requiredString(
    environment,
    "SUPABASE_ORGANIZATION_ID",
    128,
  );
  if (!ORGANIZATION_ID.test(organizationId)) {
    fail("INVALID_SUPABASE_ORGANIZATION_ID");
  }

  const projectName = requiredString(environment, "SUPABASE_PROJECT_NAME", 100);
  if (containsControlCharacter(projectName)) {
    fail("INVALID_SUPABASE_PROJECT_NAME");
  }

  const identity = { projectRef, organizationId, projectName };
  const identityHash = projectIdentityHash(identity);
  const expectedHash = environment.FIRELIGHT_EXPECTED_PROJECT_IDENTITY_HASH;
  if (
    expectedHash !== undefined &&
    (typeof expectedHash !== "string" || !LOWERCASE_SHA256.test(expectedHash))
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_PROJECT_IDENTITY_HASH");
  }
  if (expectedHash !== undefined && expectedHash !== identityHash) {
    fail("SUPABASE_PROJECT_IDENTITY_EVIDENCE_MISMATCH");
  }

  return {
    ...identity,
    accessToken,
    expectedRegion: EXPECTED_REGION,
    expectedDatabaseHost: `db.${projectRef}.supabase.co`,
    identityHash,
  };
}

export function buildSupabaseProjectUrl(configuration) {
  return `${MANAGEMENT_API}/v1/projects/${configuration.projectRef}`;
}

function managementErrorCode(status) {
  if (status === 401 || status === 403) return "SUPABASE_MANAGEMENT_AUTH_FAILED";
  if (status === 404) return "SUPABASE_PROJECT_NOT_FOUND";
  if (status === 429) return "SUPABASE_MANAGEMENT_RATE_LIMITED";
  return "SUPABASE_MANAGEMENT_API_FAILED";
}

export function validateSupabaseProject(value, configuration) {
  if (
    !isRecord(value) ||
    value.ref !== configuration.projectRef ||
    value.organization_id !== configuration.organizationId ||
    value.name !== configuration.projectName ||
    value.region !== configuration.expectedRegion ||
    !isRecord(value.database) ||
    value.database.host !== configuration.expectedDatabaseHost
  ) {
    fail("SUPABASE_PROJECT_IDENTITY_MISMATCH");
  }
  return {
    projectRef: configuration.projectRef,
    identityHash: configuration.identityHash,
  };
}

export async function verifySupabaseProject(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildSupabaseProjectUrl(configuration),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.accessToken}`,
        "User-Agent": "firelight-release-project-verifier",
      },
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );
  if (!response.ok) fail(managementErrorCode(response.status));
  return validateSupabaseProject(parseJsonBytes(bytes), configuration);
}

async function main() {
  const configuration = parseSupabaseProjectEnvironment(process.env);
  const result = await verifySupabaseProject(configuration, globalThis.fetch);
  process.stdout.write(`project_identity_hash=${result.identityHash}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Supabase project verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
