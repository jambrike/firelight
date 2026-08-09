import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  CanaryError,
  isRecord,
  safeCanaryErrorCode,
} from "./postdeploy-canary.mjs";
import {
  SUPABASE_ORGANIZATION_IDENTITY_DOMAIN,
  SUPABASE_PROJECT_REF_IDENTITY_DOMAIN,
} from "./verify-supabase-project.mjs";

export const RELEASE_ENVIRONMENT_ANCHORS_SCHEMA =
  "firelight.supabase-project-anchors";
export const RELEASE_ENVIRONMENT_ANCHORS_VERSION = 1;
export const RELEASE_ENVIRONMENT_ANCHORS_PATH =
  ".github/supabase-project-anchors.json";

const SHA256 = /^[0-9a-f]{64}$/u;
const ZERO_SHA256 = "0".repeat(64);
const MAX_ANCHOR_BYTES = 4 * 1024;

function fail(code) {
  throw new CanaryError(code);
}

function exactKeys(value, keys) {
  if (!isRecord(value)) fail("SUPABASE_ANCHOR_SCHEMA_INVALID");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("SUPABASE_ANCHOR_SCHEMA_INVALID");
  }
}

function validHash(value) {
  return typeof value === "string" && SHA256.test(value) && value !== ZERO_SHA256;
}

export function serializeReleaseEnvironmentAnchors(value) {
  return `${JSON.stringify({
    schema: value.schema,
    version: value.version,
    projectRefIdentityDomain: value.projectRefIdentityDomain,
    organizationIdentityDomain: value.organizationIdentityDomain,
    organizationIdentitySha256: value.organizationIdentitySha256,
    projects: {
      staging: {
        projectRefIdentitySha256:
          value.projects.staging.projectRefIdentitySha256,
      },
      production: {
        projectRefIdentitySha256:
          value.projects.production.projectRefIdentitySha256,
      },
    },
  })}\n`;
}

export function validateReleaseEnvironmentAnchors(value) {
  exactKeys(value, [
    "schema",
    "version",
    "projectRefIdentityDomain",
    "organizationIdentityDomain",
    "organizationIdentitySha256",
    "projects",
  ]);
  exactKeys(value.projects, ["staging", "production"]);
  exactKeys(value.projects.staging, ["projectRefIdentitySha256"]);
  exactKeys(value.projects.production, ["projectRefIdentitySha256"]);
  const stagingProjectRefIdentityHash =
    value.projects.staging.projectRefIdentitySha256;
  const productionProjectRefIdentityHash =
    value.projects.production.projectRefIdentitySha256;
  if (
    value.schema !== RELEASE_ENVIRONMENT_ANCHORS_SCHEMA ||
    value.version !== RELEASE_ENVIRONMENT_ANCHORS_VERSION ||
    value.projectRefIdentityDomain !== SUPABASE_PROJECT_REF_IDENTITY_DOMAIN ||
    value.organizationIdentityDomain !==
      SUPABASE_ORGANIZATION_IDENTITY_DOMAIN ||
    !validHash(value.organizationIdentitySha256) ||
    !validHash(stagingProjectRefIdentityHash) ||
    !validHash(productionProjectRefIdentityHash)
  ) {
    fail("SUPABASE_ANCHOR_VALUE_INVALID");
  }
  if (stagingProjectRefIdentityHash === productionProjectRefIdentityHash) {
    fail("SUPABASE_ANCHOR_PROJECT_COLLISION");
  }
  return {
    ...value,
    stagingProjectRefIdentityHash,
    productionProjectRefIdentityHash,
  };
}

export function parseReleaseEnvironmentAnchors(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ANCHOR_BYTES) {
    fail("SUPABASE_ANCHOR_FILE_INVALID");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("SUPABASE_ANCHOR_FILE_INVALID");
  }
  const anchors = validateReleaseEnvironmentAnchors(value);
  const canonical = Buffer.from(serializeReleaseEnvironmentAnchors(anchors), "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    fail("SUPABASE_ANCHOR_FILE_NONCANONICAL");
  }
  return {
    ...anchors,
    anchorSetSha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

export async function readReleaseEnvironmentAnchors(path) {
  let stats;
  let bytes;
  try {
    stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
      fail("SUPABASE_ANCHOR_FILE_INVALID");
    }
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    fail("SUPABASE_ANCHOR_FILE_READ_FAILED");
  }
  if (bytes.byteLength !== stats.size) fail("SUPABASE_ANCHOR_FILE_CHANGED");
  return parseReleaseEnvironmentAnchors(bytes);
}

async function main() {
  const path = process.argv[2];
  if (path !== RELEASE_ENVIRONMENT_ANCHORS_PATH) {
    fail("SUPABASE_ANCHOR_PATH_INVALID");
  }
  const anchors = await readReleaseEnvironmentAnchors(path);
  process.stdout.write(
    `anchor_set_sha256=${anchors.anchorSetSha256}\n` +
      `organization_identity_hash=${anchors.organizationIdentitySha256}\n` +
      `staging_project_ref_identity_hash=${anchors.stagingProjectRefIdentityHash}\n` +
      `production_project_ref_identity_hash=${anchors.productionProjectRefIdentityHash}\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Release-environment anchor verification failed [${safeCanaryErrorCode(error)}].\n`,
    );
    process.exitCode = 1;
  });
}
