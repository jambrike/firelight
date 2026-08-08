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
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MIGRATIONS = 10_000;
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const MIGRATION_VERSION = /^[0-9]{1,64}$/u;

export const MIGRATION_HISTORY_QUERY = `select
  version::text as version,
  coalesce(name, '')::text as name
from supabase_migrations.schema_migrations
order by version asc, name asc`;

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

function validMigrationName(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

export function migrationStateHash(rows) {
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

export function parseMigrationStateEnvironment(environment) {
  const projectRef = requiredString(environment, "SUPABASE_PROJECT_REF", 20);
  if (!PROJECT_REF.test(projectRef)) fail("INVALID_SUPABASE_PROJECT_REF");
  const accessToken = requiredString(environment, "SUPABASE_ACCESS_TOKEN", 4096);
  if (accessToken.length < 20 || /\s/u.test(accessToken)) {
    fail("INVALID_SUPABASE_ACCESS_TOKEN");
  }
  const expectedHash = environment.FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH;
  if (
    expectedHash !== undefined &&
    (typeof expectedHash !== "string" || !LOWERCASE_SHA256.test(expectedHash))
  ) {
    fail("INVALID_FIRELIGHT_EXPECTED_MIGRATION_STATE_HASH");
  }
  return { projectRef, accessToken, expectedHash };
}

export function buildMigrationQueryUrl(configuration) {
  return `${MANAGEMENT_API}/v1/projects/${configuration.projectRef}/database/query`;
}

export function parseMigrationHistory(value) {
  if (!Array.isArray(value) || value.length > MAX_MIGRATIONS) {
    fail("INVALID_MIGRATION_HISTORY");
  }
  const rows = [];
  let previousVersion = null;
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "name,version" ||
      typeof entry.version !== "string" ||
      !MIGRATION_VERSION.test(entry.version) ||
      !validMigrationName(entry.name) ||
      (previousVersion !== null && entry.version <= previousVersion)
    ) {
      fail("INVALID_MIGRATION_HISTORY");
    }
    rows.push({ version: entry.version, name: entry.name });
    previousVersion = entry.version;
  }
  return rows;
}

function managementErrorCode(status) {
  if (status === 401 || status === 403) return "SUPABASE_MANAGEMENT_AUTH_FAILED";
  if (status === 404) return "SUPABASE_PROJECT_NOT_FOUND";
  if (status === 429) return "SUPABASE_MANAGEMENT_RATE_LIMITED";
  return "SUPABASE_MIGRATION_STATE_UNAVAILABLE";
}

export async function verifyMigrationState(configuration, fetchImpl) {
  const { response, bytes } = await fetchBounded(
    fetchImpl,
    buildMigrationQueryUrl(configuration),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "firelight-release-migration-verifier",
      },
      body: JSON.stringify({ query: MIGRATION_HISTORY_QUERY, read_only: true }),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maximumBytes: MAX_RESPONSE_BYTES },
  );
  if (!response.ok) fail(managementErrorCode(response.status));
  const rows = parseMigrationHistory(parseJsonBytes(bytes));
  const stateHash = migrationStateHash(rows);
  if (configuration.expectedHash !== undefined && stateHash !== configuration.expectedHash) {
    fail("REMOTE_MIGRATION_STATE_CHANGED");
  }
  return { stateHash, count: rows.length };
}

async function main() {
  const configuration = parseMigrationStateEnvironment(process.env);
  const result = await verifyMigrationState(configuration, globalThis.fetch);
  process.stdout.write(`migration_state_hash=${result.stateHash}\n`);
  process.stdout.write(`migration_state_count=${String(result.count)}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Migration-state verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
