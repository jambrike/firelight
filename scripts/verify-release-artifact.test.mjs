import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  COMPILER_PROTOCOL_VERSION,
  PROGRESS_SERVICE_WRITES_CAPABILITY,
  RELEASE_EVIDENCE_SCHEMA,
  RELEASE_EVIDENCE_VERSION,
  compilerConnectionFingerprint,
} from "./release-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./verify-release-artifact.mjs", import.meta.url),
);
const ACCOUNT_ID = "a".repeat(32);
const BUILD_ID = "b".repeat(40);
const VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const DEPLOYMENT_ID = "87654321-4321-4321-4321-cba987654321";
const COMPILER_HOST = "abcdefghij.lambda-url.eu-west-1.on.aws";
const COMPILER_TOKEN = "compiler-artifact-test-token-must-stay-private";
const ANCHOR_SET_SHA256 = "d".repeat(64);
const PROJECT_REF_IDENTITY_SHA256 = "e".repeat(64);
const ORGANIZATION_IDENTITY_SHA256 = "f".repeat(64);

function environment(evidencePath, overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    FIRELIGHT_RELEASE_ENVIRONMENT: "production",
    FIRELIGHT_RELEASE_WORKER_NAME: "firelight-production",
    FIRELIGHT_RELEASE_BUILD_ID: BUILD_ID,
    FIRELIGHT_RELEASE_EVIDENCE_PATH: evidencePath,
    FIRELIGHT_SUPABASE_ANCHOR_SET_SHA256: ANCHOR_SET_SHA256,
    FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256:
      PROJECT_REF_IDENTITY_SHA256,
    FIRELIGHT_SUPABASE_ORGANIZATION_IDENTITY_SHA256:
      ORGANIZATION_IDENTITY_SHA256,
    COMPILER_SERVICE_URL: `https://${COMPILER_HOST}/`,
    COMPILER_SERVICE_ORIGIN: `https://${COMPILER_HOST}`,
    COMPILER_SERVICE_HOST: COMPILER_HOST,
    COMPILER_SERVICE_TOKEN: COMPILER_TOKEN,
    ROLLBACK_VERSION_ID: VERSION_ID,
    ...overrides,
  };
}

function artifact(currentEnvironment) {
  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    version: RELEASE_EVIDENCE_VERSION,
    accountId: ACCOUNT_ID,
    environment: "production",
    workerName: "firelight-production",
    buildId: BUILD_ID,
    compilerProtocolVersion: COMPILER_PROTOCOL_VERSION,
    compilerConnectionSha256:
      compilerConnectionFingerprint(currentEnvironment),
    compilerBuildId: "1".repeat(40),
    compilerImageDigest: `sha256:${"2".repeat(64)}`,
    supabaseAnchorSetSha256: ANCHOR_SET_SHA256,
    supabaseProjectRefIdentitySha256: PROJECT_REF_IDENTITY_SHA256,
    supabaseOrganizationIdentitySha256: ORGANIZATION_IDENTITY_SHA256,
    progressServiceWrites: PROGRESS_SERVICE_WRITES_CAPABILITY,
    versionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    deployedAt: "2026-08-07T18:00:00.000Z",
  };
}

function verify(currentEnvironment) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: currentEnvironment,
  });
}

test("rollback artifact verification binds live fingerprints but not historical compiler deployment metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "firelight-release-artifact-"));
  const evidencePath = join(directory, "firelight-release-evidence.json");
  try {
    const currentEnvironment = environment(evidencePath);
    await writeFile(
      evidencePath,
      `${JSON.stringify(artifact(currentEnvironment))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const accepted = verify(currentEnvironment);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Verified accepted production release/u);
    assert.equal(accepted.stderr, "");
    assert.equal(accepted.stdout.includes(COMPILER_TOKEN), false);
    assert.equal(accepted.stdout.includes(COMPILER_HOST), false);

    const changedConnection = verify(environment(evidencePath, {
      COMPILER_SERVICE_TOKEN: `${COMPILER_TOKEN}-rotated`,
    }));
    assert.equal(changedConnection.status, 1);
    assert.match(changedConnection.stderr, /\[RELEASE_EVIDENCE_MISMATCH\]/u);
    assert.equal(changedConnection.stderr.includes(COMPILER_TOKEN), false);
    assert.equal(changedConnection.stderr.includes(COMPILER_HOST), false);

    const changedLogicalProject = verify(environment(evidencePath, {
      FIRELIGHT_SUPABASE_PROJECT_REF_IDENTITY_SHA256: "3".repeat(64),
    }));
    assert.equal(changedLogicalProject.status, 1);
    assert.match(changedLogicalProject.stderr, /\[RELEASE_EVIDENCE_MISMATCH\]/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
